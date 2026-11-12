const db = require('./db');
const { notifyUser, reachable, canText } = require('./notify');
const { friendlyCourse } = require('./subjects');

const SUMMARY_HOUR = 18;      // Sunday summary goes out at 6 PM local time
const SUMMARY_MAX_ITEMS = 12; // keep the text short enough to read (and cheap to send)
const REMINDER_MAX_ITEMS = 10;
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
  const course = friendlyCourse(a.course);
  return course ? `${course}: ${a.title}` : a.title;
}

// Texts use plain characters only (no emoji, bullets or fancy dashes) so they're billed at the cheaper rate.
// One assignment:  "StuCal: Lab Report (Chem 101) is due tomorrow at 11:59 PM."
// Several:         "StuCal: You have 2 assignments due tomorrow:\n- Chem 101: Lab Report (11:59 PM)\n..."
function reminderText(items, tz, now = new Date()) {
  if (!Array.isArray(items)) items = [items];
  if (items.length === 1) {
    const a = items[0];
    const course = friendlyCourse(a.course);
    const what = course ? `${a.title} (${course})` : a.title;
    return `StuCal: ${what} is due ${whenText(new Date(a.due_at), tz, now)}. ${FOOTER}`;
  }
  const days = new Set(items.map((a) => dayText(new Date(a.due_at), tz, now)));
  const when = days.size === 1 ? ` due ${[...days][0]}` : ' coming up';
  const lines = items.slice(0, REMINDER_MAX_ITEMS).map((a) => {
    const due = new Date(a.due_at);
    const t = days.size === 1 ? timeText(due, tz) : whenText(due, tz, now);
    return `- ${label(a)} (${t})`;
  });
  if (items.length > REMINDER_MAX_ITEMS) lines.push(`+${items.length - REMINDER_MAX_ITEMS} more on StuCal`);
  return `StuCal: You have ${items.length} assignments${when}:\n${lines.join('\n')}\n${FOOTER}`;
}

// Notification versions: a short title plus the details, no "Reply STOP" footer.
const PUSH_MAX_LINES = 6;

function reminderPush(items, tz, now = new Date()) {
  if (!Array.isArray(items)) items = [items];
  if (items.length === 1) {
    const a = items[0];
    const course = friendlyCourse(a.course);
    return { title: `Due ${whenText(new Date(a.due_at), tz, now)}`, body: course ? `${a.title} (${course})` : a.title, url: '/' };
  }
  const days = new Set(items.map((a) => dayText(new Date(a.due_at), tz, now)));
  const lines = items.slice(0, PUSH_MAX_LINES).map((a) => {
    const due = new Date(a.due_at);
    return `${label(a)} (${days.size === 1 ? timeText(due, tz) : whenText(due, tz, now)})`;
  });
  if (items.length > PUSH_MAX_LINES) lines.push(`+${items.length - PUSH_MAX_LINES} more`);
  const title = days.size === 1 ? `${items.length} assignments due ${[...days][0]}` : `${items.length} assignments coming up`;
  return { title, body: lines.join('\n'), url: '/' };
}

function summaryPush(items, tz) {
  if (!items.length) return { title: 'Your week ahead', body: 'Nothing due this week. Enjoy it!', url: '/' };
  items = [...items].sort((x, y) => x.due_at.localeCompare(y.due_at));
  const day = (a) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(new Date(a.due_at));
  const lines = items.slice(0, PUSH_MAX_LINES).map((a) => `${day(a)}: ${label(a)}`);
  if (items.length > PUSH_MAX_LINES) lines.push(`+${items.length - PUSH_MAX_LINES} more`);
  const n = items.length;
  return { title: `Your week ahead: ${n} assignment${n === 1 ? '' : 's'}`, body: lines.join('\n'), url: '/' };
}

// ---------- day-before reminders ----------

const findPending = db.prepare(`
  SELECT a.* FROM assignments a
  WHERE a.reminded_at IS NULL AND a.done = 0 AND a.due_at > ?
  ORDER BY a.due_at
`);
const getUser = db.prepare(`SELECT * FROM users WHERE id = ?`);
const markSent = db.prepare(`UPDATE assignments SET reminded_at = ? WHERE id = ?`);

async function sendDueReminders(now = new Date()) {
  const nowIso = now.toISOString();
  const byUser = new Map();
  for (const a of findPending.all(nowIso)) {
    if (!byUser.has(a.user_id)) byUser.set(a.user_id, []);
    byUser.get(a.user_id).push(a);
  }

  let sent = 0;
  for (const [userId, pending] of byUser) {
    const user = getUser.get(userId);
    // Nobody to tell yet (no notifications turned on, texted STOP): leave it for when they are.
    if (!user || !reachable(user)) continue;
    const tz = user.timezone;
    const ready = pending.filter((a) => new Date(a.due_at).getTime() - user.remind_hours * 3600e3 <= now.getTime());
    if (!ready.length) continue;

    // Notification-only: one short notification per assignment, right at the time they picked.
    // (A bundled list gets cut off on a phone's lock screen.)
    if (!canText(user)) {
      for (const a of ready) {
        markSent.run(nowIso, a.id); // mark first so a crash never double-sends
        const result = await notifyUser(user, { push: { ...reminderPush([a], tz, now), tag: `a${a.id}` } });
        if (result.delivered) sent++;
        else if (result.retry) markSent.run(null, a.id); // try again next minute
      }
      continue;
    }

    // Texts: pull in anything else due the same day so it all arrives in one (cheaper) text.
    const days = new Set(ready.map((a) => dayKey(new Date(a.due_at), tz)));
    const batch = pending.filter((a) => days.has(dayKey(new Date(a.due_at), tz)));

    for (const a of batch) markSent.run(nowIso, a.id); // mark first so a crash never double-sends
    const result = await notifyUser(user, { text: reminderText(batch, tz, now), push: reminderPush(batch, tz, now) });
    if (result.delivered) sent++;
    else if (result.retry) for (const a of batch) markSent.run(null, a.id); // try again next minute
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
  if (items.length > SUMMARY_MAX_ITEMS) lines.push(`\n+${items.length - SUMMARY_MAX_ITEMS} more on StuCal`);
  const n = items.length;
  return `StuCal: Your week ahead - ${n} assignment${n === 1 ? '' : 's'}\n${lines.join('\n')}\n\n${FOOTER}`;
}

const summaryUsers = db.prepare(`SELECT * FROM users WHERE weekly_summary = 1`);
const weekItems = db.prepare(`
  SELECT * FROM assignments WHERE user_id = ? AND done = 0 AND due_at > ? AND due_at <= ? ORDER BY due_at
`);
const hasAnything = db.prepare(`SELECT 1 FROM assignments WHERE user_id = ? LIMIT 1`);
const markSummary = db.prepare(`UPDATE users SET last_summary_on = ? WHERE id = ?`);

function weekFor(userId, now) {
  return weekItems.all(userId, now.toISOString(), new Date(now.getTime() + 7 * 864e5).toISOString());
}

async function sendWeeklySummaries(now = new Date()) {
  let sent = 0;
  for (const u of summaryUsers.all()) {
    const tz = u.timezone;
    if (weekdayName(now, tz) !== 'Sunday' || localHour(now, tz) < SUMMARY_HOUR) continue;
    const today = dayKey(now, tz);
    if (u.last_summary_on === today) continue;
    // The weekly list is too long to read in a notification, so it's for texts only.
    if (!canText(u)) continue;
    // Skip people who never set anything up instead of sending them "nothing due" forever.
    if (!u.calendar_url && !hasAnything.get(u.id)) continue;

    const items = weekFor(u.id, now);
    markSummary.run(today, u.id);
    const result = await notifyUser(u, { text: summaryText(items, tz), push: summaryPush(items, tz) });
    if (result.delivered) sent++;
    else if (result.retry) markSummary.run(u.last_summary_on, u.id); // try again next minute
  }
  return sent;
}

module.exports = {
  sendDueReminders, sendWeeklySummaries, reminderText, summaryText, reminderPush, summaryPush, whenText, weekFor,
};
