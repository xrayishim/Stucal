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
  assert.equal((await post('/api/auth/start', { phone: '(555) 123-4567' })).status, 200);
  const { code } = db.prepare(`SELECT code FROM login_codes WHERE phone = '+15551234567'`).get();
  assert.equal((await post('/api/auth/verify', { phone: '5551234567', code: '000000' })).status, 400);
  const res = await post('/api/auth/verify', { phone: '5551234567', code, timezone: 'America/New_York' });
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
  assert.match(logs[0], /to \+15551234567: StuCal: Lab Report \(Chem 101\) is due (today|tomorrow) at/);

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
  assert.match(logs[0], /You have 2 assignments due tomorrow:\n• Algebra — Chapter 5 HW \(5:00 PM\)\n• Chemistry — Lab Report \(11:59 PM\)/);
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
  assert.match(logs[0], /to \+15550000060: StuCal: Your week ahead 📅 2 assignments\n\nMon:\n• Algebra — Chapter 6 HW \(11:59 PM\)\n\nThu:\n• Bio — Quiz \(2:00 PM\)/);
  assert.doesNotMatch(logs[0], /Done already|Next week/);
});
