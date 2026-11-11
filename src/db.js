const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, '..', 'stucal.db'));

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    remind_hours INTEGER NOT NULL DEFAULT 24,   -- how far ahead to text
    calendar_url TEXT,                          -- Canvas/Blackboard/etc .ics feed
    plan TEXT NOT NULL DEFAULT 'trial',         -- trial | active | canceled
    trial_ends_at TEXT NOT NULL,
    stripe_customer_id TEXT,
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

  CREATE INDEX IF NOT EXISTS idx_assignments_due ON assignments(due_at) WHERE reminded_at IS NULL AND done = 0;
`);

module.exports = db;
