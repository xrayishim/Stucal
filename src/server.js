const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');
const sms = require('./sms');
const calendar = require('./calendar');
const { friendlyCourse } = require('./subjects');
const { sendDueReminders, sendWeeklySummaries, reminderText, summaryText } = require('./reminders');

const fs = require('node:fs');

const PUBLIC = path.join(__dirname, '..', 'public');
const APP_URL = (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
// Test mode: no Twilio keys and not production. Login codes and texts are shown on screen instead of sent.
const TEST_MODE = !sms.live && process.env.NODE_ENV !== 'production';
const MAX_CODES_PER_HOUR = Number(process.env.MAX_CODES_PER_HOUR) || 300; // whole-app safety cap

const app = express();
// Railway, Render, Fly etc. sit behind one proxy; trust it so req.ip is the student's real IP.
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);

app.use(express.json());

// Privacy and Terms pages get the contact email and app address filled in.
function legalPage(file) {
  return (req, res) => {
    const html = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
      .replaceAll('{{CONTACT_EMAIL}}', CONTACT_EMAIL || '(contact email not set yet)')
      .replaceAll('{{APP_URL}}', APP_URL);
    res.type('html').send(html);
  };
}
app.get(['/privacy', '/privacy.html'], legalPage('privacy.html'));
app.get(['/terms', '/terms.html'], legalPage('terms.html'));
app.use(express.static(PUBLIC));

// ---------- helpers ----------

// Caribbean countries share the +1 code but are billed as (expensive) international texts,
// which is exactly what SMS-fraud bots target. Toll-free numbers can't receive our texts.
const BLOCKED_AREA_CODES = new Set([
  '242', '246', '264', '268', '284', '345', '441', '473', '649', '658', '664', '721', '758', '767',
  '784', '809', '829', '849', '868', '869', '876',
  '800', '833', '844', '855', '866', '877', '888', '900',
]);

// US and Canada mobile numbers only.
function normalizePhone(input) {
  let digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  if (BLOCKED_AREA_CODES.has(digits.slice(0, 3))) return null;
  return `+1${digits}`;
}

// ---------- rate limits ----------
const countEvents = db.prepare(`SELECT COUNT(*) AS n FROM rate_events WHERE key = ? AND at > ?`);
const addEvent = db.prepare(`INSERT INTO rate_events (key, at) VALUES (?, ?)`);

// rules: [[key, windowMs, max], ...]. Records the event only if every rule allows it.
function allow(rules) {
  const now = Date.now();
  for (const [key, windowMs, max] of rules) {
    if (countEvents.get(key, now - windowMs).n >= max) return { ok: false, key };
  }
  for (const key of new Set(rules.map((r) => r[0]))) addEvent.run(key, now);
  return { ok: true };
}

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;

function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

function auth(req, res, next) {
  const token = readCookie(req, 'stucal_session');
  const user = token && db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`).get(token);
  if (!user) return res.status(401).json({ error: 'Not logged in' });
  req.user = user;
  next();
}

function publicUser(u) {
  return {
    phone: u.phone,
    timezone: u.timezone,
    remindHours: u.remind_hours,
    calendarUrl: u.calendar_url,
    weeklySummary: Boolean(u.weekly_summary),
    testMode: TEST_MODE,
  };
}

// ---------- login by texted code ----------
app.post('/api/auth/start', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a US or Canadian mobile number' });

  const limit = allow([
    [`phone:${phone}`, MIN, 1],
    [`phone:${phone}`, HOUR, 5],
    [`phone:${phone}`, DAY, 10],
    [`ip:${req.ip}`, HOUR, 10],
    [`ip:${req.ip}`, DAY, 30],
    ['all', HOUR, MAX_CODES_PER_HOUR],
  ]);
  if (!limit.ok) {
    if (limit.key === 'all') console.error(`ALERT: login code cap (${MAX_CODES_PER_HOUR}/hour) reached, possible SMS fraud`);
    const wait = limit.key === `phone:${phone}` && countEvents.get(limit.key, Date.now() - HOUR).n < 5 ? 'a minute' : 'a while';
    return res.status(429).json({ error: `Too many codes requested. Try again in ${wait}.` });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT OR REPLACE INTO login_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)`)
    .run(phone, code, Date.now() + 10 * MIN);
  try {
    await sms.sendSms(phone, `Your StuCal code is ${code}`);
  } catch (e) {
    if (e.optedOut) {
      return res.status(400).json({ error: `This number texted STOP to StuCal. Text START to ${process.env.TWILIO_FROM || 'our number'} to turn texts back on, then try again.` });
    }
    console.error(e.message);
    return res.status(502).json({ error: 'Could not send a text to that number. Check it and try again.' });
  }
  res.json({ ok: true, devMode: !sms.live, ...(TEST_MODE ? { testCode: code } : {}) });
});

app.post('/api/auth/verify', (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const row = phone && db.prepare(`SELECT * FROM login_codes WHERE phone = ?`).get(phone);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5) return res.status(400).json({ error: 'Code expired, request a new one' });
  if (row.code !== String(req.body.code).trim()) {
    db.prepare(`UPDATE login_codes SET attempts = attempts + 1 WHERE phone = ?`).run(phone);
    return res.status(400).json({ error: 'Wrong code' });
  }
  db.prepare(`DELETE FROM login_codes WHERE phone = ?`).run(phone);

  let user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
  if (!user) {
    const tz = validTimezone(req.body.timezone) ? req.body.timezone : 'America/New_York';
    db.prepare(`INSERT INTO users (phone, timezone) VALUES (?, ?)`).run(phone, tz);
    user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
    // Carriers expect a confirmation text when someone signs up.
    sms.sendSms(phone, 'StuCal: You\'re signed up for assignment reminders. Msg frequency varies. Msg & data rates may apply. Reply HELP for help, STOP to cancel.')
      .catch((e) => console.error('welcome text failed:', e.message));
  } else if (user.opted_out) {
    // They just got a login code, so texts are getting through again.
    db.prepare(`UPDATE users SET opted_out = 0 WHERE id = ?`).run(user.id);
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare(`INSERT INTO sessions (token, user_id) VALUES (?, ?)`).run(token, user.id);
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `stucal_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}`);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/logout', auth, (req, res) => {
  db.prepare(`DELETE FROM sessions WHERE token = ?`).run(readCookie(req, 'stucal_session'));
  res.setHeader('Set-Cookie', 'stucal_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- account ----------
app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', auth, async (req, res) => {
  const { remindHours, timezone, calendarUrl, weeklySummary } = req.body;
  if (weeklySummary !== undefined) {
    db.prepare(`UPDATE users SET weekly_summary = ? WHERE id = ?`).run(weeklySummary ? 1 : 0, req.user.id);
  }
  if (remindHours !== undefined) {
    const h = Number(remindHours);
    if (!Number.isInteger(h) || h < 1 || h > 168) return res.status(400).json({ error: 'Reminder must be 1–168 hours ahead' });
    db.prepare(`UPDATE users SET remind_hours = ? WHERE id = ?`).run(h, req.user.id);
  }
  if (timezone !== undefined) {
    if (!validTimezone(timezone)) return res.status(400).json({ error: 'Unknown timezone' });
    db.prepare(`UPDATE users SET timezone = ? WHERE id = ?`).run(timezone, req.user.id);
  }
  if (calendarUrl !== undefined) {
    const url = String(calendarUrl).trim();
    if (url && !/^(https|webcal):\/\//i.test(url)) return res.status(400).json({ error: 'Calendar link should start with https:// or webcal://' });
    db.prepare(`UPDATE users SET calendar_url = ? WHERE id = ?`).run(url || null, req.user.id);
  }
  const user = db.prepare(`SELECT * FROM users WHERE id = ?`).get(req.user.id);
  let imported;
  if (calendarUrl) {
    try { imported = await calendar.syncUser(user); } catch (e) { return res.status(400).json({ error: `Couldn't read that calendar: ${e.message}` }); }
  }
  res.json({ user: publicUser(user), imported });
});

app.delete('/api/me', auth, (req, res) => {
  // Assignments and sessions are removed with the user (ON DELETE CASCADE).
  db.prepare(`DELETE FROM users WHERE id = ?`).run(req.user.id);
  db.prepare(`DELETE FROM login_codes WHERE phone = ?`).run(req.user.phone);
  res.setHeader('Set-Cookie', 'stucal_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---------- incoming texts (Twilio webhook) ----------
// Twilio itself answers STOP / START / HELP and blocks texts to people who opted out.
// This keeps our records in step so we stop trying to text them.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'UNSTOP', 'YES']);
const HELP_WORDS = new Set(['HELP', 'INFO']);

function twiml(message) {
  const esc = (s) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${message ? `<Message>${esc(message)}</Message>` : ''}</Response>`;
}

app.post('/api/sms/incoming', express.urlencoded({ extended: false }), (req, res) => {
  if (sms.live && !sms.verifyTwilioRequest(`${APP_URL}/api/sms/incoming`, req.body, req.get('x-twilio-signature'))) {
    return res.sendStatus(403);
  }
  const from = normalizePhone(req.body.From);
  const word = String(req.body.OptOutType || req.body.Body || '').trim().toUpperCase();
  res.type('text/xml');

  if (STOP_WORDS.has(word)) {
    if (from) db.prepare(`UPDATE users SET opted_out = 1 WHERE phone = ?`).run(from);
    return res.send(twiml());
  }
  if (START_WORDS.has(word)) {
    if (from) db.prepare(`UPDATE users SET opted_out = 0 WHERE phone = ?`).run(from);
    return res.send(twiml());
  }
  if (HELP_WORDS.has(word)) return res.send(twiml());

  // Anything else: we can't read replies yet. Answer at most once a day per number so nobody can run up our bill.
  const ok = from && allow([[`reply:${from}`, DAY, 1]]).ok;
  res.send(twiml(ok ? `StuCal can't read replies yet. Manage your reminders at ${APP_URL}` : ''));
});

// ---------- test mode helpers (never available with real texting) ----------
app.get('/api/test/outbox', auth, (req, res) => {
  if (!TEST_MODE) return res.sendStatus(404);
  res.json({ texts: sms.outbox.filter((m) => m.to === req.user.phone).slice(-30).reverse() });
});

// Shows what the next day-before reminder and the Sunday summary would say, without marking anything as sent.
app.post('/api/test/preview', auth, async (req, res) => {
  if (!TEST_MODE) return res.sendStatus(404);
  const tz = req.user.timezone;
  const now = new Date();
  const upcoming = db.prepare(`SELECT * FROM assignments WHERE user_id = ? AND done = 0 AND due_at > ? ORDER BY due_at`)
    .all(req.user.id, now.toISOString());
  const dayOf = (a) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(a.due_at));
  if (upcoming.length) {
    const firstDay = dayOf(upcoming[0]);
    const batch = upcoming.filter((a) => dayOf(a) === firstDay);
    // pretend it's the day before, at the user's chosen reminder time
    const at = new Date(new Date(batch[0].due_at).getTime() - req.user.remind_hours * 3600e3);
    await sms.sendSms(req.user.phone, reminderText(batch, tz, at < now ? now : at));
  }
  const week = upcoming.filter((a) => new Date(a.due_at) - now <= 7 * DAY);
  await sms.sendSms(req.user.phone, summaryText(week, tz));
  res.json({ ok: true });
});

app.post('/api/calendar/sync', auth, async (req, res) => {
  try { res.json({ imported: await calendar.syncUser(req.user) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- assignments ----------
app.get('/api/assignments', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, course, due_at AS dueAt, source, done, reminded_at AS remindedAt
    FROM assignments WHERE user_id = ? AND due_at > ? ORDER BY due_at
  `).all(req.user.id, new Date(Date.now() - 3 * 864e5).toISOString());
  res.json({ assignments: rows.map((r) => ({ ...r, course: friendlyCourse(r.course) })) });
});

app.post('/api/assignments', auth, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const course = String(req.body.course || '').trim().slice(0, 100) || null;
  const due = new Date(req.body.dueAt);
  if (!title) return res.status(400).json({ error: 'Give it a name' });
  if (isNaN(due)) return res.status(400).json({ error: 'Pick a due date and time' });
  const r = db.prepare(`INSERT INTO assignments (user_id, title, course, due_at) VALUES (?, ?, ?, ?)`)
    .run(req.user.id, title, course, due.toISOString());
  res.json({ id: Number(r.lastInsertRowid) });
});

app.patch('/api/assignments/:id', auth, (req, res) => {
  if (req.body.done !== undefined) {
    db.prepare(`UPDATE assignments SET done = ? WHERE id = ? AND user_id = ?`).run(req.body.done ? 1 : 0, req.params.id, req.user.id);
  }
  res.json({ ok: true });
});

app.delete('/api/assignments/:id', auth, (req, res) => {
  db.prepare(`DELETE FROM assignments WHERE id = ? AND user_id = ?`).run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- background jobs ----------
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`StuCal running on http://localhost:${port}${sms.live ? '' : '  (dev mode: texts print here)'}`));
  if (process.env.NODE_ENV === 'production') {
    if (!CONTACT_EMAIL) console.warn('WARNING: set CONTACT_EMAIL so the Privacy and Terms pages show how to reach you.');
    if (!process.env.APP_URL) console.warn('WARNING: set APP_URL to your public address (needed for the Twilio webhook).');
  }
  let running = false;
  const tick = async () => {
    if (running) return; // a slow minute shouldn't overlap the next one
    running = true;
    await sendDueReminders().catch(console.error);     // day-before reminders
    await sendWeeklySummaries().catch(console.error);  // Sunday 6 PM "your week ahead"
    db.prepare(`DELETE FROM rate_events WHERE at < ?`).run(Date.now() - 2 * DAY);
    running = false;
  };
  setInterval(tick, 60e3);                                              // check every minute
  setInterval(() => calendar.syncAll().catch(console.error), 60 * 60e3); // re-pull calendars hourly
  tick();
}

module.exports = app;
