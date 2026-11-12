const db = require('./db');
const sms = require('./sms');

const SUMMARY_HOUR = 18;      // Sunday summary goes out at 6 PM local time
const SUMMARY_MAX_ITEMS = 12; // keep the text short enough to read (and cheap to send)
const FOOTER = 'Reply STOP to opt out.';

function dayKey(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date); // YYYY-MM-DD
}

function timeText(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(date);
}

// "today", "tomorrow", "Friday"
function dayText(due, tz, now = new Date()) {
  const day = dayKey(due, tz);
  if (day === dayKey(now, tz)) return 'today';
  if (day === dayKey(new Date(now.getTime() + 864e5), tz)) return 'tomorrow';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(due);
}

// "today at 11:59 PM", "tomorrow at 9:00 AM", "Friday at 5:00 PM"
function whenText(due, tz, now = new Date()) {
  return `${dayText(due, tz, now)} at ${timeText(due, tz)}`;
}

function label(a) {
  return a.course ? `${a.course}: ${a.title}` : a.title;
}

// Texts use plain characters only (no emoji, bullets or fancy dashes) so they're billed at the cheaper rate.
// One assignment:  "StuCal: Lab Report (Chem 101) is due tomorrow at 11:59 PM."
// Several:         "StuCal: You have 2 assignments due tomorrow:\n- Chem 101: Lab Report (11:59 PM)\n..."
function reminderText(items, tz, now = new Date()) {
  if (!Array.isArray(items)) items = [items];
  if (items.length === 1) {
    const a = items[0];
    const what = a.course ? `${a.title} (${a.course})` : a.title;
    return `StuCal: ${what} is due ${whenText(new Date(a.due_at), tz, now)}. ${FOOTER}`;
  }
  const days = new Set(items.map((a) => dayText(new Date(a.due_at), tz, now)));
  const when = days.size === 1 ? ` due ${[...days][0]}` : ' coming up';
  const lines = items.map((a) => {
    const due = new Date(a.due_at);
    const t = days.size === 1 ? timeText(due, tz) : whenText(due, tz, now);
    return `- ${label(a)} (${t})`;
  });
  return `StuCal: You have ${items.length} assignments${when}:\n${lines.join('\n')}\n${FOOTER}`;
}

// ---------- day-before reminders ----------

const findPending = db.prepare(`
  SELECT a.*, u.phone, u.timezone, u.remind_hours
  FROM assignments a JOIN users u ON u.id = a.user_id
  WHERE a.reminded_at IS NULL AND a.done = 0 AND a.due_at > ? AND u.opted_out = 0
  ORDER BY a.due_at
`);
const markSent = db.prepare(`UPDATE assignments SET reminded_at = ? WHERE id = ?`);
const markOptedOut = db.prepare(`UPDATE users SET opted_out = 1 WHERE id = ?`);

// Decides what to do after a failed send. Returns true if it's worth trying again next minute.
function handleSendError(e, userId, what) {
  if (e.optedOut) {
    markOptedOut.run(userId);
    console.log(`user ${userId} has texted STOP; no more texts until they text START`);
    return false;
  }
  console.error(`${what} failed for user ${userId}:`, e.message);
  return !e.permanent;
}

async function sendDueReminders(now = new Date()) {
  const nowIso = now.toISOString();
  const byUser = new Map();
  for (const a of findPending.all(nowIso)) {
    if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
    byUser.get(a.user_id).push(a);
  }

  let sent = 0;
  for (const pending of byUser.values()) {
    const { phone, timezone: tz, remind_hours } = pending[0];
    const ready = pending.filter((a) => new Date(a.due_at).getTime() - remind_hours * 3600e3 <= now.getTime());
    if (!ready.length) continue;
    // Pull in anything else due the same day so it all arrives in one text.
    const days = new Set(ready.map((a) => dayKey(new Date(a.due_at), tz)));
    const batch = pending.filter((a) => days.has(dayKey(new Date(a.due_at), tz)));

    for (const a of batch) markSent.run(nowIso, a.id); // mark first so a crash never double-texts
    try {
      await sms.sendSms(phone, reminderText(batch, tz, now));
      sent++;
    } catch (e) {
      if (handleSendError(e, batch[0].user_id, 'reminder')) {
        for (const a of batch) markSent.run(null, a.id); // retry next tick
      }
    }
  }
  return sent;
}

// ---------- Sunday night summary ----------

function weekdayName(date, tz) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(date);
}

function localHour(date, tz) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(date));
}

function summaryText(items, tz) {
  if (!items.length) return `StuCal: Your week ahead\nNothing due this week. Enjoy it!\n${FOOTER}`;
  items = [...items].sort((x, y) => x.due_at.localeCompare(y.due_at));
  const lines = [];
  let lastDay = null;
  for (const a of items.slice(0, SUMMARY_MAX_ITEMS)) {
    const due = new Date(a.due_at);
    const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(due);
    if (day !== lastDay) { lines.push(`\n${day}:`); lastDay = day; }
    lines.push(`- ${label(a)} (${timeText(due, tz)})`);
  }
  if (items.length > SUMMARY_MAX_ITEMS) lines.push(`\n+${items.length - SUMMARY_MAX_ITEMS} more on stucal`);
  const n = items.length;
  return `StuCal: Your week ahead - ${n} assignment${n === 1 ? '' : 's'}\n${lines.join('\n')}\n\n${FOOTER}`;
}

const summaryUsers = db.prepare(`SELECT * FROM users WHERE weekly_summary = 1 AND opted_out = 0`);
const weekItems = db.prepare(`
  SELECT * FROM assignments WHERE user_id = ? AND done = 0 AND due_at > ? AND due_at <= ? ORDER BY due_at
`);
const hasAnything = db.prepare(`SELECT 1 FROM assignments WHERE user_id = ? LIMIT 1`);
const markSummary = db.prepare(`UPDATE users SET last_summary_on = ? WHERE id = ?`);

async function sendWeeklySummaries(now = new Date()) {
  let sent = 0;
  for (const u of summaryUsers.all()) {
    const tz = u.timezone;
    if (weekdayName(now, tz) !== 'Sunday' || localHour(now, tz) < SUMMARY_HOUR) continue;
    const today = dayKey(now, tz);
    if (u.last_summary_on === today) continue;
    // Skip people who never set anything up instead of texting them "nothing due" forever.
    if (!u.calendar_url && !hasAnything.get(u.id)) continue;

    const items = weekItems.all(u.id, now.toISOString(), new Date(now.getTime() + 7 * 864e5).toISOString());
    markSummary.run(today, u.id);
    try {
      await sms.sendSms(u.phone, summaryText(items, tz));
      sent++;
    } catch (e) {
      if (handleSendError(e, u.id, 'weekly summary')) markSummary.run(u.last_summary_on, u.id); // retry next tick
    }
  }
  return sent;
}

module.exports = { sendDueReminders, sendWeeklySummaries, reminderText, summaryText, whenText };
