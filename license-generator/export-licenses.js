// license-generator/export-licenses.js
// Exports active license keys to public/license-db.json for offline fallback validation
const path = require('path');
const fs   = require('fs');
const crypto = require('crypto');

const LICENSE_SECRET = 'options-tracker-secret-2024-CHANGE-THIS'; // must match all other files

let Database;
try { Database = require('better-sqlite3'); } catch {
  console.error('Run "npm install" in the license-generator folder first.');
  process.exit(1);
}

const dbPath  = path.join(__dirname, 'my-licenses.db');
const outPath = path.join(__dirname, '..', 'trade-tracker', 'public', 'license-db.json');

if (!fs.existsSync(dbPath)) {
  console.log('No licenses database found. Creating empty license-db.json...');
  fs.writeFileSync(outPath, JSON.stringify({ keys: [] }, null, 2));
  process.exit(0);
}

const db    = new Database(dbPath, { readonly: true });
const rows  = db.prepare("SELECT key, plan, expires FROM licenses WHERE active=1").all();

const output = {
  exported_at: new Date().toISOString(),
  keys: rows.map(r => ({
    key:     r.key,
    plan:    r.plan,
    expires: r.expires || null,
    active:  true,
  })),
};

fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(`Exported ${rows.length} active license(s) to ${outPath}`);
