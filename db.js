// Database setup for user accounts and usage tracking.
//
// Uses @libsql/client (the Turso/libSQL driver) instead of better-sqlite3.
// The schema and every query below are still plain SQLite - libSQL is
// SQLite-compatible - but the client itself is async-only (no synchronous
// .get()/.all()/.run() like better-sqlite3 had), which is why every call
// site in server.js awaits these helpers instead of chaining .prepare().
//
// Locally (no TURSO_* env vars set) this reads/writes a plain local file,
// same as before. In production, set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN
// (see .env.example) to point at a real Turso database instead - that's
// what makes accounts survive a host like Render wiping its local disk on
// every redeploy, since the data then lives outside the app's container
// entirely.
const { createClient } = require('@libsql/client');
const crypto = require('crypto');

const url = process.env.TURSO_DATABASE_URL || `file:${process.env.DATA_DB_PATH || 'data.db'}`;
const authToken = process.env.TURSO_AUTH_TOKEN;

if (/^libsql:\/\//.test(url) && !authToken) {
  console.warn('WARNING: TURSO_DATABASE_URL is set but TURSO_AUTH_TOKEN is not - a remote Turso database almost always requires a token. Requests to it will likely fail.');
}

// intMode: 'number' matches better-sqlite3's old behavior (integer columns
// come back as plain JS numbers) - our ids/counts are all well within the
// safe integer range, and a few places (like the JWT payload) can't
// serialize a BigInt at all.
const client = createClient(
  authToken ? { url, authToken, intMode: 'number' } : { url, intMode: 'number' }
);

async function dbGet(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows[0];
}

async function dbAll(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows;
}

async function dbRun(sql, args = []) {
  const result = await client.execute({ sql, args });
  return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
}

// Resolves once the schema exists - server.js awaits this before it starts
// accepting requests, since table creation is now async (it used to run
// synchronously at require() time with better-sqlite3).
const ready = client.executeMultiple(`
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
`).then(() => {
  console.log(`Database ready (${authToken ? 'Turso' : 'local file'}: ${url}).`);
}).catch((err) => {
  console.error('Database setup failed:', err.message);
  throw err;
});
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
async function uniqueReferralCode() {
  for (let i = 0; i < 10; i++) {
    const code = generateReferralCode();
    const existing = await dbGet('SELECT id FROM users WHERE referral_code = ?', [code]);
    if (!existing) return code;
  }
  throw new Error('Could not generate a unique referral code');
}

module.exports = { dbGet, dbAll, dbRun, uniqueReferralCode, ready };
