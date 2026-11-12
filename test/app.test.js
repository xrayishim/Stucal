process.env.DB_PATH = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../src/db');
const app = require('../src/server');
const { parseIcs, splitCourse } = require('../src/calendar');
const { sendDueReminders, whenText } = require('../src/reminders');

test('parses a Canvas-style calendar feed', () => {
  const ics = [
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-assignment-123',
    'DTSTART:20261113T045900Z',
    'SUMMARY:Lab Report 3 [CHEM-101-02]',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-assignment-456',
    'DTSTART;TZID=America/Chicago:20261115T170000',
    'SUMMARY:Essay draft\\, part 2 [ENG-',
    ' 200]',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:allday-1',
    'DTSTART;VALUE=DATE:20261120',
    'SUMMARY:Quiz',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const evs = parseIcs(ics, 'America/New_York');
  assert.equal(evs.length, 3);
  assert.equal(evs[0].due.toISOString(), '2026-11-13T04:59:00.000Z');
  assert.equal(evs[1].summary, 'Essay draft, part 2 [ENG-200]');
  assert.equal(evs[1].due.toISOString(), '2026-11-15T23:00:00.000Z'); // 5pm CST
  assert.equal(evs[2].due.toISOString(), '2026-11-21T04:59:00.000Z'); // all-day → 11:59pm ET
  assert.deepEqual(splitCourse('Lab Report 3 [CHEM-101-02]'), { title: 'Lab Report 3', course: 'CHEM-101-02' });
});

test('words the due time naturally', () => {
  const now = new Date('2026-11-12T15:00:00Z'); // Thu 10am ET
  assert.equal(whenText(new Date('2026-11-13T04:59:00Z'), 'America/New_York', now), 'today at 11:59 PM');
  assert.equal(whenText(new Date('2026-11-13T14:00:00Z'), 'America/New_York', now), 'tomorrow at 9:00 AM');
  assert.equal(whenText(new Date('2026-11-14T22:00:00Z'), 'America/New_York', now), 'Saturday at 5:00 PM');
});

test('signup, add assignment, get exactly one text', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const post = (p, body, cookie) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: cookie || '' }, body: JSON.stringify(body) });

  assert.equal((await post('/api/auth/start', { phone: 'abc' })).status, 400);
  assert.equal((await post('/api/auth/start', { phone: '(202) 555-0123' })).status, 200);
  const { code } = db.prepare(`SELECT code FROM login_codes WHERE phone = '+12025550123'`).get();
  assert.equal((await post('/api/auth/verify', { phone: '2025550123', code: '000000' })).status, 400);
  const res = await post('/api/auth/verify', { phone: '2025550123', code, timezone: 'America/New_York' });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const due = new Date(Date.now() + 20 * 3600e3); // inside the default 24h window
  const later = new Date(Date.now() + 72 * 3600e3); // outside it
  assert.equal((await post('/api/assignments', { title: 'Lab Report', course: 'Chem 101', dueAt: due.toISOString() }, cookie)).status, 200);
  assert.equal((await post('/api/assignments', { title: 'Essay', dueAt: later.toISOString() }, cookie)).status, 200);

  const logs = [];
  t.mock.method(console, 'log', (m) => logs.push(m));
  assert.equal(await sendDueReminders(), 1);
  assert.equal(await sendDueReminders(), 0); // never texts twice
  assert.match(logs[0], /to \+12025550123: StuCal: Lab Report \(Chem 101\) is due (today|tomorrow) at/);

  // checked off → no text
  db.prepare(`UPDATE assignments SET reminded_at = NULL, done = 1`).run();
  assert.equal(await sendDueReminders(), 0);

  const unauth = await fetch(base + '/api/assignments');
  assert.equal(unauth.status, 401);
});

test('groups same-day reminders into one text', async (t) => {
  const { sendDueReminders } = require('../src/reminders');
  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, phone, timezone, remind_hours) VALUES (50, '+15550000050', 'America/New_York', 24)`).run();
  const add = db.prepare(`INSERT INTO assignments (user_id, title, course, due_at) VALUES (50, ?, ?, ?)`);
  const now = new Date('2026-11-12T23:00:00Z');                 // Thu 6 PM ET
  add.run('Chapter 5 HW', 'Algebra', '2026-11-13T22:00:00Z');   // Fri 5 PM: inside 24h
  add.run('Lab Report', 'Chemistry', '2026-11-14T04:59:00Z');   // Fri 11:59 PM: same day, 30h out
  add.run('Essay', 'English', '2026-11-16T04:59:00Z');          // Sun: later, not included

  const logs = [];
  t.mock.method(console, 'log', (m) => logs.push(m));
  assert.equal(await sendDueReminders(now), 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /You have 2 assignments due tomorrow:\n- Algebra: Chapter 5 HW \(5:00 PM\)\n- Chemistry: Lab Report \(11:59 PM\)/);
  assert.doesNotMatch(logs[0], /Essay/);
  assert.equal(await sendDueReminders(now), 0);
});

test('Sunday night summary goes out once, at 6 PM local', async (t) => {
  const { sendWeeklySummaries } = require('../src/reminders');
  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, phone, timezone) VALUES (60, '+15550000060', 'America/Chicago')`).run();
  db.prepare(`INSERT INTO users (id, phone, timezone, weekly_summary) VALUES (61, '+15550000061', 'America/Chicago', 0)`).run();
  const add = db.prepare(`INSERT INTO assignments (user_id, title, course, due_at, done) VALUES (?, ?, ?, ?, ?)`);
  add.run(60, 'Chapter 6 HW', 'Algebra', '2026-11-17T05:59:00Z', 0); // Mon 11:59 PM CT
  add.run(60, 'Quiz', 'Bio', '2026-11-19T20:00:00Z', 0);             // Thu 2 PM CT
  add.run(60, 'Done already', 'Bio', '2026-11-19T21:00:00Z', 1);     // checked off
  add.run(60, 'Next week', 'Bio', '2026-11-25T20:00:00Z', 0);        // too far out
  add.run(61, 'Opted out', 'Bio', '2026-11-17T20:00:00Z', 0);

  const logs = [];
  t.mock.method(console, 'log', (m) => logs.push(m));
  assert.equal(await sendWeeklySummaries(new Date('2026-11-15T23:00:00Z')), 0); // Sun 5 PM CT: too early
  assert.equal(await sendWeeklySummaries(new Date('2026-11-14T01:00:00Z')), 0); // Fri: wrong day
  assert.equal(await sendWeeklySummaries(new Date('2026-11-16T00:05:00Z')), 1); // Sun 6:05 PM CT
  assert.equal(await sendWeeklySummaries(new Date('2026-11-16T01:00:00Z')), 0); // already sent tonight
  assert.equal(logs.length, 1);
  assert.match(logs[0], /to \+15550000060: StuCal: Your week ahead - 2 assignments\n\nMon:\n- Algebra: Chapter 6 HW \(11:59 PM\)\n\nThu:\n- Bio: Quiz \(2:00 PM\)/);
  assert.doesNotMatch(logs[0], /Done already|Next week/);
});

test('texts only use cheap plain characters', () => {
  const { toPlain } = require('../src/sms');
  const { reminderText } = require('../src/reminders');
  const msg = reminderText([
    { title: 'Café “Essay” – draft…', course: 'Français 📚', due_at: '2026-11-13T22:00:00Z' },
    { title: 'Lab', course: 'Chem', due_at: '2026-11-13T23:00:00Z' },
  ], 'America/New_York', new Date('2026-11-12T23:00:00Z'));
  const sent = toPlain(msg);
  assert.match(sent, /^[\n\x20-\x7E]+$/);
  assert.match(sent, /- Francais : Cafe "Essay" - draft\.\.\. \(5:00 PM\)|- Francais: Cafe "Essay" - draft\.\.\. \(5:00 PM\)/);
});

test('only real US/Canada numbers, and login codes are rate limited', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const start = (phone) => fetch(base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone }) });
  t.mock.method(console, 'log', () => {});
  db.exec(`DELETE FROM rate_events`);

  for (const bad of ['+44 20 7946 0958', '(876) 555-0199', '1-800-555-0199', '(202) 123-4567', '12345']) {
    assert.equal((await start(bad)).status, 400, bad);
  }
  assert.equal((await start('+1 (312) 555-0142')).status, 200);
  const again = await start('3125550142');
  assert.equal(again.status, 429); // same number within a minute
  assert.match((await again.json()).error, /a minute/);

  // one person spraying many numbers gets cut off after 10 an hour
  db.exec(`DELETE FROM rate_events`);
  let last;
  for (let i = 0; i < 11; i++) last = await start(`(415) 555-01${String(i).padStart(2, '0')}`);
  assert.equal(last.status, 429);
});

test('STOP stops texts, START turns them back on, delete erases everything', async (t) => {
  const sms = require('../src/sms');
  const { sendDueReminders } = require('../src/reminders');
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const incoming = (From, Body) => fetch(base + '/api/sms/incoming', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ From, Body }),
  });

  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, phone) VALUES (70, '+12025550170')`).run();
  const due = new Date(Date.now() + 3600e3).toISOString();
  db.prepare(`INSERT INTO assignments (user_id, title, due_at) VALUES (70, 'Quiz', ?)`).run(due);
  const optedOut = () => db.prepare(`SELECT opted_out FROM users WHERE id = 70`).get().opted_out;

  // texting STOP: no reminders go out
  assert.equal((await incoming('+12025550170', 'stop')).status, 200);
  assert.equal(optedOut(), 1);
  const sends = t.mock.method(sms, 'sendSms', async () => ({}));
  assert.equal(await sendDueReminders(), 0);
  assert.equal(sends.mock.callCount(), 0);

  // START: reminders resume
  await incoming('+12025550170', 'START');
  assert.equal(optedOut(), 0);
  assert.equal(await sendDueReminders(), 1);

  // if Twilio says they opted out (STOP we missed), mark it and don't retry every minute
  db.exec(`UPDATE assignments SET reminded_at = NULL`);
  sends.mock.mockImplementation(async () => { throw new sms.SmsError('unsubscribed', 400, 21610); });
  t.mock.method(console, 'log', () => {});
  assert.equal(await sendDueReminders(), 0);
  assert.equal(optedOut(), 1);
  assert.ok(db.prepare(`SELECT reminded_at FROM assignments WHERE user_id = 70`).get().reminded_at);

  // a temporary Twilio outage is retried
  db.exec(`UPDATE users SET opted_out = 0; UPDATE assignments SET reminded_at = NULL`);
  sends.mock.mockImplementation(async () => { throw new sms.SmsError('server error', 503); });
  t.mock.method(console, 'error', () => {});
  await sendDueReminders();
  assert.equal(db.prepare(`SELECT reminded_at FROM assignments WHERE user_id = 70`).get().reminded_at, null);

  // random replies get one auto-answer per day, not one per message
  const r1 = await (await incoming('+12025550170', 'what is due?')).text();
  const r2 = await (await incoming('+12025550170', 'hello??')).text();
  assert.match(r1, /<Message>StuCal can&#39;t read replies yet/);
  assert.doesNotMatch(r2, /<Message>/);

  // delete account
  sends.mock.mockImplementation(async () => ({}));
  db.exec(`DELETE FROM rate_events`);
  await fetch(base + '/api/auth/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '2025550170' }) });
  const { code } = db.prepare(`SELECT code FROM login_codes WHERE phone = '+12025550170'`).get();
  const login = await fetch(base + '/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '2025550170', code }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + '/api/me', { method: 'DELETE', headers: { cookie } })).status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM users WHERE id = 70`).get().n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM assignments WHERE user_id = 70`).get().n, 0);
  assert.equal((await fetch(base + '/api/me', { headers: { cookie } })).status, 401);
});

test('privacy and terms pages load with contact details filled in', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  for (const page of ['/privacy', '/terms']) {
    const html = await (await fetch(base + page)).text();
    assert.match(html, /STOP/);
    assert.doesNotMatch(html, /\{\{/);
  }
  assert.match(await (await fetch(base + '/privacy')).text(), /No mobile information will be shared with third parties/);
});

test('test mode shows the login code and the texts StuCal would send', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  t.mock.method(console, 'log', () => {});
  db.exec(`DELETE FROM rate_events; DELETE FROM users`);

  const started = await (await fetch(base + '/api/auth/start', { method: 'POST', headers: json, body: JSON.stringify({ phone: '2025550188' }) })).json();
  assert.match(started.testCode, /^\d{6}$/);
  const login = await fetch(base + '/api/auth/verify', { method: 'POST', headers: json, body: JSON.stringify({ phone: '2025550188', code: started.testCode, timezone: 'America/New_York' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await login.json()).user.testMode, true);

  await fetch(base + '/api/assignments', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ title: 'HW 5.3', course: 'Algebra', dueAt: new Date(Date.now() + 2 * 864e5).toISOString() }) });
  await fetch(base + '/api/test/preview', { method: 'POST', headers: { cookie } });
  const { texts } = await (await fetch(base + '/api/test/outbox', { headers: { cookie } })).json();
  assert.match(texts[0].body, /Your week ahead - 1 assignment/);
  assert.match(texts[1].body, /HW 5\.3 \(Algebra\) is due tomorrow/);
  assert.ok(texts.some((m) => /signed up for assignment reminders/.test(m.body)));
  // preview doesn't count as the real reminder
  assert.equal(db.prepare(`SELECT reminded_at FROM assignments WHERE title = 'HW 5.3'`).get().reminded_at, null);
});

test('Canvas sync skips school-wide events and drops deleted assignments', async (t) => {
  const http = require('node:http');
  const { syncUser } = require('../src/calendar');
  const ev = (uid, summary, start) => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE;VALUE=DATE:${start}\r\nCLASS:PUBLIC\r\nSUMMARY:${summary}\r\nEND:VEVENT`;
  const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  let events = [
    ev('event-assignment-1', 'Section 4.3 HW\\, Part 1 [MAC1105 MRG]', day(2)),
    ev('event-assignment-2', 'Chapter 7 Quiz [COP1000 MRG]', day(3)),
    ev('event-calendar-event-9', 'Thanksgiving Break ', day(4)),
    ev('event-calendar-event-10', 'Midterm in class [ENC1101 MRG]', day(5)),
  ];
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/calendar');
    res.end(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.join('\r\n')}\r\nEND:VCALENDAR\r\n`);
  }).listen(0);
  t.after(() => server.close());

  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, phone, timezone, calendar_url) VALUES (80, '+12025550180', 'America/New_York', ?)`)
    .run(`http://localhost:${server.address().port}/feeds/calendars/user_x.ics`);
  const user = db.prepare(`SELECT * FROM users WHERE id = 80`).get();
  const titles = () => db.prepare(`SELECT title, course FROM assignments WHERE user_id = 80 ORDER BY due_at`).all().map((r) => `${r.course}: ${r.title}`);

  assert.equal(await syncUser(user), 3);
  assert.deepEqual(titles(), ['MAC1105 MRG: Section 4.3 HW, Part 1', 'COP1000 MRG: Chapter 7 Quiz', 'ENC1101 MRG: Midterm in class']);
  const homework = db.prepare(`SELECT due_at FROM assignments WHERE external_uid = 'event-assignment-1'`).get();
  assert.match(new Date(homework.due_at).toLocaleTimeString('en-US', { timeZone: 'America/New_York' }), /^11:59:00\sPM$/);

  // teacher deletes the quiz; a hand-added assignment is untouched
  db.prepare(`INSERT INTO assignments (user_id, title, due_at) VALUES (80, 'MyMathLab 5.3', ?)`).run(new Date(Date.now() + 864e5).toISOString());
  events = events.filter((e) => !e.includes('event-assignment-2'));
  assert.equal(await syncUser(user), 2);
  assert.deepEqual(titles(), ['null: MyMathLab 5.3', 'MAC1105 MRG: Section 4.3 HW, Part 1', 'ENC1101 MRG: Midterm in class']);
});

test('a very busy day is capped at 10 lines', () => {
  const { reminderText } = require('../src/reminders');
  const items = Array.from({ length: 15 }, (_, i) => ({ title: `Task ${i + 1}`, course: 'ENC1101', due_at: '2026-11-30T04:59:00Z' }));
  const msg = reminderText(items, 'America/New_York', new Date('2026-11-29T00:00:00Z'));
  assert.match(msg, /You have 15 assignments due tomorrow/);
  assert.equal(msg.match(/^- /gm).length, 10);
  assert.match(msg, /\+5 more on StuCal/);
});

test('class codes become subject names people recognize', () => {
  const { friendlyCourse } = require('../src/subjects');
  const cases = {
    'MAC1105 MRG': 'Math', 'COP1000 MRG': 'Coding', 'ENC1101 MRG': 'English', 'POS2041 70715': 'Government',
    'ENC1101 Lab Requirements': 'English Lab', 'BSC2010L': 'Biology Lab', 'AMH2010 01': 'History',
    'HIST 1301-02': 'History', 'CS 101': 'Coding', 'CHM1045': 'Chemistry', 'PSY2012 Online': 'Psychology',
    'AP US History - Period 3': 'AP US History - Period 3', 'Algebra': 'Algebra', 'XYZ1234': 'XYZ1234',
  };
  for (const [input, want] of Object.entries(cases)) assert.equal(friendlyCourse(input), want, input);
});

test('notification accounts: quick signup, reminders by notification, dead devices cleaned up', async (t) => {
  const notify = require('../src/notify');
  const { sendDueReminders, sendWeeklySummaries } = require('../src/reminders');
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const json = { 'Content-Type': 'application/json' };
  db.exec(`DELETE FROM users; DELETE FROM rate_events`);

  const config = await (await fetch(base + '/api/config')).json();
  assert.equal(config.sms, false);
  assert.ok(config.pushKey.length > 60);

  // one tap, no phone number
  const signup = await fetch(base + '/api/auth/quick', { method: 'POST', headers: json, body: JSON.stringify({ timezone: 'America/New_York' }) });
  assert.equal(signup.status, 200);
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  assert.match(signup.headers.get('set-cookie'), /Max-Age=34560000/); // 400 days
  const user = (await signup.json()).user;
  assert.equal(user.hasPhone, false);
  assert.equal(user.notificationDevices, 0);
  const userId = db.prepare(`SELECT id FROM users`).get().id;

  // an assignment due soon, but notifications aren't on yet: nothing is "sent" or used up
  db.prepare(`INSERT INTO assignments (user_id, title, course, due_at) VALUES (?, 'Research Paper Outline', 'ENC1101 MRG', ?)`)
    .run(userId, new Date(Date.now() + 5 * 3600e3).toISOString());
  const pushes = [];
  const send = t.mock.method(notify.webpush, 'sendNotification', async (sub, payload) => { pushes.push({ sub, payload: JSON.parse(payload) }); return { statusCode: 201 }; });
  assert.equal(await sendDueReminders(), 0);
  assert.equal(db.prepare(`SELECT reminded_at FROM assignments`).get().reminded_at, null);
  assert.equal((await fetch(base + '/api/push/test', { method: 'POST', headers: { cookie } })).status, 400);

  // turn on notifications on two devices
  const sub = (n) => ({ endpoint: `https://web.push.apple.com/device-${n}`, keys: { p256dh: 'BKey' + n, auth: 'auth' + n } });
  assert.equal((await fetch(base + '/api/push/subscribe', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ subscription: { endpoint: 'http://evil', keys: {} } }) })).status, 400);
  for (const n of [1, 2]) {
    const r = await fetch(base + '/api/push/subscribe', { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ subscription: sub(n) }) });
    assert.equal(r.status, 200);
  }
  assert.equal((await (await fetch(base + '/api/me', { headers: { cookie } })).json()).user.notificationDevices, 2);

  // the reminder goes out as a notification to both devices, with friendly names
  assert.equal(await sendDueReminders(), 1);
  assert.equal(pushes.length, 2);
  assert.match(pushes[0].payload.title, /^Due (today|tomorrow) at /);
  assert.equal(pushes[0].payload.body, 'Research Paper Outline (English)');
  assert.ok(db.prepare(`SELECT reminded_at FROM assignments`).get().reminded_at);

  // a device that removed the app (410 Gone) is forgotten; the other still works
  pushes.length = 0;
  send.mock.mockImplementation(async (s, payload) => {
    if (s.endpoint.endsWith('device-1')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushes.push({ sub: s, payload: JSON.parse(payload) });
  });
  const test = await fetch(base + '/api/push/test', { method: 'POST', headers: { cookie } });
  assert.equal(test.status, 200);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get().n, 1);
  assert.equal(pushes.length, 1); // the test shows just the next reminder, exactly as it will look
  assert.match(pushes[0].payload.title, /^Due (today|tomorrow) at /);
  assert.equal(pushes[0].payload.body, 'Research Paper Outline (English)');

  // no Sunday list for notification-only accounts: it'd be cut off on the lock screen
  db.exec(`UPDATE assignments SET due_at = '2026-11-17T04:59:00Z', reminded_at = NULL`);
  pushes.length = 0;
  assert.equal(await sendWeeklySummaries(new Date('2026-11-15T23:30:00Z')), 0); // Sun 6:30 PM ET
  assert.equal(pushes.length, 0);

  // Apple temporarily down: reminder is retried next minute rather than lost
  db.exec(`UPDATE assignments SET due_at = '${new Date(Date.now() + 3600e3).toISOString()}', reminded_at = NULL`);
  send.mock.mockImplementation(async () => { throw Object.assign(new Error('unavailable'), { statusCode: 503 }); });
  t.mock.method(console, 'error', () => {});
  assert.equal(await sendDueReminders(), 0);
  assert.equal(db.prepare(`SELECT reminded_at FROM assignments`).get().reminded_at, null);

  // deleting the account removes its devices too
  await fetch(base + '/api/me', { method: 'DELETE', headers: { cookie } });
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions`).get().n, 0);
});

test('the app can be installed: manifest, icons and service worker are served', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone');
  for (const icon of [...manifest.icons.map((i) => i.src), '/icons/icon-180.png']) {
    const r = await fetch(base + icon);
    assert.equal(r.status, 200, icon);
    assert.equal(r.headers.get('content-type'), 'image/png');
  }
  const sw = await fetch(base + '/sw.js');
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), /showNotification/);
});

test('notifications: same-day assignments come together at the time the person picked', async (t) => {
  const notify = require('../src/notify');
  const { sendDueReminders } = require('../src/reminders');
  db.exec(`DELETE FROM users`);
  db.prepare(`INSERT INTO users (id, timezone, remind_hours) VALUES (90, 'America/New_York', 3)`).run(); // "3 hours before"
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (90, 'https://web.push.apple.com/x', 'k', 'a')`).run();
  const add = db.prepare(`INSERT INTO assignments (user_id, title, course, due_at) VALUES (90, ?, ?, ?)`);
  add.run('Chapter 7 Quiz', 'COP1000 MRG', '2026-11-21T01:30:00Z');         // Fri 8:30 PM
  add.run('Research Paper Outline', 'ENC1101 MRG', '2026-11-21T04:59:00Z'); // Fri 11:59 PM
  add.run('Chapter 8 Quiz', 'COP1000 MRG', '2026-11-22T04:59:00Z');         // Sat: later

  const pushes = [];
  t.mock.method(notify.webpush, 'sendNotification', async (sub, payload) => { pushes.push(JSON.parse(payload)); });
  assert.equal(await sendDueReminders(new Date('2026-11-20T22:00:00Z')), 0); // 5 PM: nothing within 3 hours yet
  assert.equal(await sendDueReminders(new Date('2026-11-20T22:31:00Z')), 1); // 5:31 PM: the quiz is 3 hours out
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].title, '2 assignments due today');
  assert.equal(pushes[0].body, 'Coding: Chapter 7 Quiz (8:30 PM)\nEnglish: Research Paper Outline (11:59 PM)');
  assert.equal(await sendDueReminders(new Date('2026-11-21T02:00:00Z')), 0); // already covered, never twice
});

test('past-due assignments drop off the list', async (t) => {
  const server = app.listen(0);
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  db.exec(`DELETE FROM users; DELETE FROM rate_events`);
  const signup = await fetch(base + '/api/auth/quick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const cookie = signup.headers.get('set-cookie').split(';')[0];
  const userId = db.prepare(`SELECT id FROM users`).get().id;
  const add = db.prepare(`INSERT INTO assignments (user_id, title, due_at) VALUES (?, ?, ?)`);
  add.run(userId, 'Due an hour ago', new Date(Date.now() - 3600e3).toISOString());
  add.run(userId, 'Due last week', new Date(Date.now() - 7 * 864e5).toISOString());
  add.run(userId, 'Due tonight', new Date(Date.now() + 3600e3).toISOString());
  const { assignments } = await (await fetch(base + '/api/assignments', { headers: { cookie } })).json();
  assert.deepEqual(assignments.map((a) => a.title), ['Due tonight']);
});
