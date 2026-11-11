const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const db = require('./db');
const sms = require('./sms');
const billing = require('./billing');
const calendar = require('./calendar');
const { sendDueReminders } = require('./reminders');

const TRIAL_DAYS = 14;
const app = express();

// Stripe needs the raw body to verify its signature, so this route comes before express.json().
app.post('/api/billing/webhook', express.text({ type: '*/*' }), (req, res) => {
  res.sendStatus(billing.handleWebhook(req.body, req.get('stripe-signature')) ? 200 : 400);
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------
function normalizePhone(input) {
  const digits = String(input || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(input).trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

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
  const trialActive = u.plan === 'trial' && u.trial_ends_at > new Date().toISOString();
  return {
    phone: u.phone,
    timezone: u.timezone,
    remindHours: u.remind_hours,
    calendarUrl: u.calendar_url,
    plan: u.plan,
    trialEndsAt: u.trial_ends_at,
    remindersOn: u.plan === 'active' || trialActive,
    billingEnabled: billing.enabled,
  };
}

// ---------- login by texted code ----------
app.post('/api/auth/start', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Enter a valid phone number' });
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare(`INSERT OR REPLACE INTO login_codes (phone, code, expires_at, attempts) VALUES (?, ?, ?, 0)`)
    .run(phone, code, Date.now() + 10 * 60e3);
  try {
    await sms.sendSms(phone, `Your Stucal code is ${code}`);
  } catch (e) {
    console.error(e.message);
    return res.status(502).json({ error: 'Could not send text, try again' });
  }
  res.json({ ok: true, devMode: !sms.live });
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
    const trialEnds = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString();
    db.prepare(`INSERT INTO users (phone, timezone, trial_ends_at) VALUES (?, ?, ?)`).run(phone, tz, trialEnds);
    user = db.prepare(`SELECT * FROM users WHERE phone = ?`).get(phone);
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
  const { remindHours, timezone, calendarUrl } = req.body;
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

app.post('/api/calendar/sync', auth, async (req, res) => {
  try { res.json({ imported: await calendar.syncUser(req.user) }); } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- assignments ----------
app.get('/api/assignments', auth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, title, course, due_at AS dueAt, source, done, reminded_at AS remindedAt
    FROM assignments WHERE user_id = ? AND due_at > ? ORDER BY due_at
  `).all(req.user.id, new Date(Date.now() - 3 * 864e5).toISOString());
  res.json({ assignments: rows });
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

// ---------- billing ----------
app.post('/api/billing/checkout', auth, async (req, res) => {
  if (!billing.enabled) return res.status(503).json({ error: 'Payments are not set up yet' });
  try { res.json({ url: await billing.createCheckout(req.user) }); } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/billing/portal', auth, async (req, res) => {
  if (!billing.enabled || !req.user.stripe_customer_id) return res.status(400).json({ error: 'No subscription found' });
  try { res.json({ url: await billing.createPortal(req.user) }); } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- background jobs ----------
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Stucal running on http://localhost:${port}${sms.live ? '' : '  (dev mode: texts print here)'}`));
  setInterval(() => sendDueReminders().catch(console.error), 60e3);   // check every minute
  setInterval(() => calendar.syncAll().catch(console.error), 60 * 60e3); // re-pull calendars hourly
  sendDueReminders().catch(console.error);
}

module.exports = app;
