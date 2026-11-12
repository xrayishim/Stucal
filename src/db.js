const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'stucal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    phone TEXT UNIQUE,                          -- empty for notification-only accounts
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    remind_hours INTEGER NOT NULL DEFAULT 24,   -- how far ahead to text
    calendar_url TEXT,                          -- Canvas/Blackboard/etc .ics feed
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_codes (
    phone TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    course TEXT,
    due_at TEXT NOT NULL,          -- UTC ISO string
    source TEXT NOT NULL DEFAULT 'manual',  -- manual | calendar
    external_uid TEXT,             -- UID from calendar feed, for de-duping
    done INTEGER NOT NULL DEFAULT 0,
    reminded_at TEXT,
    UNIQUE (user_id, external_uid)
  );

  -- one row per rate-limited action (login code requests, auto-replies)
  CREATE TABLE IF NOT EXISTS rate_events (
    key TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_rate_events ON rate_events(key, at);

  CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_at) WHERE reminded_at IS NULL AND done = 0;

  -- phone/browser notification subscriptions (one person can have several devices)
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint TEXT UNIQUE NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- small app-wide values, e.g. the notification signing keys
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Columns added after the first version; ignore "duplicate column" on databases that already have them.
for (const sql of [
  `ALTER TABLE users ADD COLUMN weekly_summary INTEGER NOT NULL DEFAULT 1`, // Sunday night text on/off
  `ALTER TABLE users ADD COLUMN last_summary_on TEXT`,                      // local date of last Sunday text
  `ALTER TABLE users ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0`,      // texted STOP
]) {
  try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}

// The first versions required a phone number. Notification-only accounts don't
// have one, so rebuild the users table without that rule (SQLite can't drop
// NOT NULL in place). Foreign keys are paused so sessions and assignments survive.
const usersSql = db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get().sql;
if (/phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i.test(usersSql)) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec(usersSql.replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?users"?/i, 'CREATE TABLE users_new')
      .replace(/phone\s+TEXT\s+UNIQUE\s+NOT\s+NULL/i, 'phone TEXT UNIQUE'));
    db.exec(`INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

module.exports = db;
