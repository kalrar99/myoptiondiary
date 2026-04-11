// license-generator/generate-license.js
// Manual license key generator — run via START-LICENSE-MANAGER.bat
const crypto   = require('crypto');
const path     = require('path');
const fs       = require('fs');

const LICENSE_SECRET = 'options-tracker-secret-2024-CHANGE-THIS'; // must match all other files

let Database;
try { Database = require('better-sqlite3'); } catch {
  console.error('Run "npm install" in the license-generator folder first.');
  process.exit(1);
}

const dbPath = path.join(__dirname, 'my-licenses.db');
const db     = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key          TEXT    NOT NULL UNIQUE,
    email        TEXT,
    plan         TEXT    NOT NULL DEFAULT 'Lifetime',
    expires      TEXT,
    active       INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    DEFAULT (datetime('now'))
  );
`);

// ── Generate a new key ────────────────────────────────────
function generateKey(plan = 'Lifetime', email = '', expiresDate = null) {
  const raw = crypto.randomBytes(16).toString('hex').toUpperCase();
  const key = `${raw.slice(0,4)}-${raw.slice(4,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}`;
  db.prepare('INSERT INTO licenses (key, email, plan, expires) VALUES (?,?,?,?)').run(key, email || null, plan, expiresDate || null);
  return key;
}

// ── List all licenses ─────────────────────────────────────
function listLicenses() {
  const rows = db.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
  if (!rows.length) { console.log('No licenses generated yet.'); return; }
  console.log('\n' + '─'.repeat(80));
  rows.forEach(r => {
    const status = r.active ? '✓ ACTIVE' : '✗ DISABLED';
    console.log(`[${status}] ${r.key}  |  ${r.plan}  |  ${r.email || '(no email)'}  |  expires: ${r.expires || 'never'}  |  created: ${r.created_at}`);
  });
  console.log('─'.repeat(80) + '\n');
}

// ── Disable a key ─────────────────────────────────────────
function disableKey(key) {
  const r = db.prepare("UPDATE licenses SET active=0 WHERE key=?").run(key.toUpperCase());
  if (r.changes) console.log('Key disabled: ' + key);
  else console.log('Key not found: ' + key);
}

// ── CLI interface ─────────────────────────────────────────
const [,, command, ...args] = process.argv;

if (!command || command === 'list') {
  listLicenses();
} else if (command === 'generate') {
  const plan    = args[0] || 'Lifetime';
  const email   = args[1] || '';
  const expires = args[2] || null;
  const key = generateKey(plan, email, expires);
  console.log('\n✓ License key generated:');
  console.log('  ' + key);
  console.log('  Plan: ' + plan);
  if (email)   console.log('  Email: ' + email);
  if (expires) console.log('  Expires: ' + expires);
  console.log('');
} else if (command === 'disable') {
  disableKey(args[0] || '');
} else {
  console.log(`
Options Tracker v5 — License Manager
Usage:
  node generate-license.js list
  node generate-license.js generate [plan] [email] [expires-date]
  node generate-license.js disable <KEY>

Examples:
  node generate-license.js generate Lifetime user@example.com
  node generate-license.js generate Annual buyer@mail.com 2025-12-31
  node generate-license.js disable XXXX-XXXX-XXXX-XXXX
`);
}
