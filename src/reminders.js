const db = require('./db');
const { sendSms } = require('./sms');

function dayKey(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(date); // YYYY-MM-DD
}

// "today at 11:59 PM", "tomorrow at 9:00 AM", "Friday at 5:00 PM"
function whenText(due, tz, now = new Date()) {
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(due);
  const today = dayKey(now, tz);
  const tomorrow = dayKey(new Date(now.getTime() + 864e5), tz);
  const day = dayKey(due, tz);
  if (day === today) return `today at ${time}`;
  if (day === tomorrow) return `tomorrow at ${time}`;
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long' }).format(due);
  return `${weekday} at ${time}`;
}

function reminderText(a, tz, now) {
  const what = a.course ? `${a.title} (${a.course})` : a.title;
  return `Stucal: ${what} is due ${whenText(new Date(a.due_at), tz, now)}. Reply STOP to opt out.`;
}

const findDue = db.prepare(`
  SELECT a.*, u.phone, u.timezone, u.remind_hours
  FROM assignments a JOIN users u ON u.id = a.user_id
  WHERE a.reminded_at IS NULL AND a.done = 0 AND a.due_at > ?
    AND (u.plan = 'active' OR (u.plan = 'trial' AND u.trial_ends_at > ?))
`);
const markSent = db.prepare(`UPDATE assignments SET reminded_at = ? WHERE id = ?`);

async function sendDueReminders(now = new Date()) {
  const nowIso = now.toISOString();
  let sent = 0;
  for (const a of findDue.all(nowIso, nowIso)) {
    const due = new Date(a.due_at).getTime();
    if (due - a.remind_hours * 3600e3 > now.getTime()) continue; // not yet
    markSent.run(nowIso, a.id); // mark first so a crash never double-texts
    try {
      await sendSms(a.phone, reminderText(a, a.timezone, now));
      sent++;
    } catch (e) {
      console.error(`reminder failed for assignment ${a.id}:`, e.message);
      markSent.run(null, a.id); // retry next tick
    }
  }
  return sent;
}

module.exports = { sendDueReminders, reminderText, whenText };
