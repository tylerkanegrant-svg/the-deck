// SQLite database setup for user accounts and usage tracking.
// Uses better-sqlite3, which is synchronous - no callbacks/promises needed,
// which keeps this simple to read and use from server.js.
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database('data.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    plan TEXT NOT NULL DEFAULT 'trial',
    trial_ends_at TEXT,
    referral_code TEXT UNIQUE NOT NULL,
    referred_by INTEGER
  );

  CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    feature TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context TEXT NOT NULL,
    message TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    success INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
`);
// "detail" isn't in the original spec's usage table, but it's needed to
// remember *what* was searched so the admin dashboard can show the top
// searched card terms - without it there'd be no way to know which search
// each usage row was for. It's optional/nullable and only used for that.

function generateReferralCode() {
  // 8 chars, uppercase letters + digits - short enough to share, long
  // enough that collisions are very unlikely (and we still check).
  return crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
}

// Referral codes must be unique - generate and retry on the rare collision.
function uniqueReferralCode() {
  const existing = db.prepare('SELECT id FROM users WHERE referral_code = ?');
  for (let i = 0; i < 10; i++) {
    const code = generateReferralCode();
    if (!existing.get(code)) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

module.exports = { db, uniqueReferralCode };
