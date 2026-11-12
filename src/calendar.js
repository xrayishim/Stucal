// Imports assignments from a school calendar feed (.ics).
// Canvas, Blackboard, Moodle, Schoology and Google Classroom all offer one.
const db = require('./db');

function unfold(text) {
  return text.replace(/\r?\n[ \t]/g, '');
}

function unescape(v) {
  return v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();
}

// Parses DTSTART/DUE values: 20261112T235900Z, 20261112T235900 (floating), 20261112 (all-day)
function parseIcsDate(value, params, fallbackTz) {
  const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const [, y, mo, d, h = '23', mi = '59', s = '00', z] = m;
  if (z) return new Date(Date.UTC(+y, mo - 1, +d, +h, +mi, +s));
  const tz = (params.match(/TZID=([^;:]+)/) || [])[1] || fallbackTz;
  return zonedToUtc(+y, +mo, +d, +h, +mi, +s, tz);
}

// Converts a wall-clock time in an IANA timezone to a UTC Date.
function zonedToUtc(y, mo, d, h, mi, s, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = 0;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(guess)).map((p) => [p.type, p.value])
    );
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    offset = asUtc - guess;
  } catch { /* unknown tz: treat as UTC */ }
  return new Date(guess - offset);
}

function parseIcs(text, fallbackTz) {
  const events = [];
  for (const block of unfold(text).split('BEGIN:VEVENT').slice(1)) {
    const body = block.split('END:VEVENT')[0];
    const ev = {};
    for (const line of body.split(/\r?\n/)) {
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const [name, ...params] = line.slice(0, idx).split(';');
      const value = line.slice(idx + 1);
      const p = params.join(';');
      if (name === 'UID') ev.uid = value.trim();
      else if (name === 'SUMMARY') ev.summary = unescape(value);
      else if (name === 'DUE' || (name === 'DTSTART' && !ev.due)) ev.due = parseIcsDate(value.trim(), p, fallbackTz);
    }
    if (ev.uid && ev.summary && ev.due) events.push(ev);
  }
  return events;
}

// Canvas titles look like "Lab Report 3 [CHEM-101-02]"; pull the course out.
function splitCourse(summary) {
  const m = summary.match(/^(.*?)\s*\[([^\]]+)\]\s*$/);
  return m ? { title: m[1], course: m[2] } : { title: summary, course: null };
}

const upsert = db.prepare(`
  INSERT INTO assignments (user_id, title, course, due_at, source, external_uid)
  VALUES (?, ?, ?, ?, 'calendar', ?)
  ON CONFLICT (user_id, external_uid) DO UPDATE SET
    title = excluded.title,
    course = excluded.course,
    -- if the teacher moved the deadline, allow a fresh reminder
    reminded_at = CASE WHEN assignments.due_at != excluded.due_at THEN NULL ELSE assignments.reminded_at END,
    due_at = excluded.due_at
`);

// Canvas feeds mix assignments ("event-assignment-123") with calendar events
// ("event-calendar-event-456"). Calendar events tagged with a class (like an
// in-class exam) are worth a reminder; untagged ones are school-wide dates such
// as "Thanksgiving Break" or "Graduation", which shouldn't be texted as "due".
function isWorthReminding(ev, course) {
  if (ev.uid.startsWith('event-calendar-event-') && !course) return false;
  return true;
}

const upcomingFromCalendar = db.prepare(`
  SELECT id, external_uid FROM assignments WHERE user_id = ? AND source = 'calendar' AND due_at > ?
`);
const removeAssignment = db.prepare(`DELETE FROM assignments WHERE id = ?`);

async function syncUser(user) {
  if (!user.calendar_url) return 0;
  const url = user.calendar_url.replace(/^webcal:/i, 'https:');
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Calendar feed returned ${res.status}`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("That link isn't a calendar feed");
  const events = parseIcs(text, user.timezone);
  const cutoff = Date.now(); // past-due assignments aren't imported
  const kept = new Set();
  let count = 0;
  for (const ev of events) {
    if (ev.due.getTime() < cutoff) continue;
    const { title, course } = splitCourse(ev.summary);
    if (!isWorthReminding(ev, course)) continue;
    upsert.run(user.id, title, course, ev.due.toISOString(), ev.uid);
    kept.add(ev.uid);
    count++;
  }
  // If a teacher deletes an assignment (or it was a school-wide event imported
  // before), drop it so nobody gets reminded about it. Past items are left alone.
  if (events.length) {
    for (const row of upcomingFromCalendar.all(user.id, new Date().toISOString())) {
      if (!kept.has(row.external_uid)) removeAssignment.run(row.id);
    }
  }
  return count;
}

async function syncAll() {
  const users = db.prepare(`SELECT * FROM users WHERE calendar_url IS NOT NULL`).all();
  for (const u of users) {
    try { await syncUser(u); } catch (e) { console.error(`calendar sync failed for user ${u.id}:`, e.message); }
  }
}

module.exports = { parseIcs, splitCourse, syncUser, syncAll, zonedToUtc };
