// trade-tracker-backend.js
// ── MODULE PATH FIX (Electron packaged mode) ─────────────
if (process.env.OTT_ELECTRON === '1') {
  const path = require('path');
  const resourcesPath = process.env.OTT_RESOURCES || (() => {
    try { return require('path').join(__dirname, '..'); } catch { return null; }
  })();
  if (resourcesPath) {
    const backendModules  = path.join(resourcesPath, 'backend', 'node_modules');
    const unpackedModules = path.join(resourcesPath, 'app.asar.unpacked', 'node_modules');
    const fallbackModules = path.join(resourcesPath, 'app', 'node_modules');
    const extras = [backendModules, unpackedModules, fallbackModules].filter(p => {
      try { require('fs').accessSync(p); return true; } catch { return false; }
    });
    if (extras.length > 0) module.paths = extras.concat(module.paths || []);
  }
}

const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');
const os        = require('os');
const http      = require('http');
const https     = require('https');
const initSqlJs = require('sql.js');
// Local date ISO — avoids UTC timezone shift
function localDateISO(d = new Date()) {
  const yr = d.getFullYear(), mo = String(d.getMonth()+1).padStart(2,'0'), dy = String(d.getDate()).padStart(2,'0');
  return `${yr}-${mo}-${dy}`;
}

const PORT           = 3002;
const HOST           = '127.0.0.1';
let   activePort     = PORT;  // updated by tryListen when dynamic port is selected
const LICENSE_SECRET    = process.env.LICENSE_SECRET || 'ee93a86d7abeaa74c6255244ee4470fac127c94b96dd08e1c4ee4abd3ed189c3'; // Auto-generated — do not share or commit to git
const GUMROAD_PRODUCT_PERMALINK = 'rdmiu'; // Replace with your Gumroad product permalink after setup
const IS_ELECTRON    = process.env.OTT_ELECTRON === '1';

// ══════════════════════════════════════════════════════════════
//  SECURITY LAYER — Tamper-resistant license enforcement
//
//  Layer 1: HMAC-signed files  — every sensitive file carries a
//            signature; any edit breaks the sig → treated as tampered.
//  Layer 2: Backend-side Paddle validation — the backend calls Paddle
//            itself on every activation; the frontend cannot
//            lie about a key being valid.
//  Layer 3: Machine fingerprint — license bound to the machine that
//            activated it; copying license.json to another PC fails.
//  Layer 4: Clock skew detection — system clock wound back > 1 day
//            relative to the last-seen timestamp → trial expired.
//  Layer 5: Trial anchored in DB — start date also stored in SQLite
//            inside the encrypted database; deleting trial.json alone
//            is not enough.
//  Layer 6: Encrypted storage — files encrypted with AES-256-GCM;
//            Notepad shows only ciphertext.
//  Layer 7: DevTools blocked in production (handled in main.js).
// ══════════════════════════════════════════════════════════════

const appDataDir = process.env.LOCALAPPDATA
  ? path.join(process.env.LOCALAPPDATA, 'MyOptionDiary')
  : path.join(os.homedir(), '.myoptiondiary');
const dataDir    = path.join(appDataDir, 'data');
const licenseDir = path.join(appDataDir, 'license');
[appDataDir, dataDir, licenseDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

const logFile = path.join(appDataDir, 'startup.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch {}
}

log('Backend starting...');

const dbPathLegacy = path.join(dataDir, 'trades');          // old filename (no extension)
const dbPath       = path.join(dataDir, 'trades.db');        // current filename

// ── Legacy db migration ──────────────────────────────────────────────────
// If the old 'trades' file exists, migrate it to 'trades.db'.
// This happens once — after that the app always uses 'trades.db'.
try {
  const legacyExists = fs.existsSync(dbPathLegacy);
  const newExists    = fs.existsSync(dbPath);
  if (legacyExists && !newExists) {
    fs.renameSync(dbPathLegacy, dbPath);
    log('Migrated database: trades → trades.db');
  } else if (legacyExists && newExists) {
    // Both exist — keep the newer one as trades.db, discard the older legacy file
    const legacyMtime = fs.statSync(dbPathLegacy).mtimeMs;
    const newMtime    = fs.statSync(dbPath).mtimeMs;
    if (legacyMtime > newMtime) {
      // Legacy is newer — overwrite trades.db with it
      fs.copyFileSync(dbPathLegacy, dbPath);
      log('Migrated database: legacy trades was newer, overwrote trades.db');
    }
    fs.unlinkSync(dbPathLegacy);
    log('Removed legacy trades file after migration');
  }
} catch (e) {
  log('DB migration warning: ' + e.message);
}

let db;

function saveDb() {
  try { fs.writeFileSync(dbPath, Buffer.from(db.export())); } catch (e) { log('DB save warning: ' + e.message); }
}

function dbRun(sql, params = []) {
  try {
    // Use prepare/run to get reliable lastInsertRowid in sql.js
    const stmt = db.prepare(sql);
    stmt.run(params);
    stmt.free();
    const rowid = db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? null;
    saveDb();
    return { lastInsertRowid: rowid };
  } catch(e) {
    log('dbRun ERROR: ' + e.message + ' | SQL: ' + sql.slice(0,80));
    throw e;
  }
}

function dbGet(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res[0] || !res[0].values[0]) return undefined;
  const obj = {};
  res[0].columns.forEach((c, i) => { obj[c] = res[0].values[0][i]; });
  return obj;
}

function dbAll(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res[0]) return [];
  return res[0].values.map(row => {
    const obj = {};
    res[0].columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS purchase_lots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, shares REAL NOT NULL,
    avg_cost REAL NOT NULL, purchase_date TEXT, close_date TEXT, close_price REAL, notes TEXT,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, lot_id INTEGER,
    strategy TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', entry_date TEXT, exit_date TEXT,
    expiration TEXT, entry_price REAL, exit_price REAL, contracts INTEGER DEFAULT 1,
    strike_buy REAL, strike_sell REAL, delta REAL, gamma REAL, theta REAL, vega REAL,
    iv_entry REAL, pnl REAL, notes TEXT, roll_parent_id INTEGER, roll_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS import_history (
    file_hash TEXT PRIMARY KEY, file_name TEXT, broker TEXT,
    trade_count INTEGER, imported_at TEXT DEFAULT (datetime('now'))
  );
`;

const trialFile    = path.join(licenseDir, 'trial.json');
const licenseFile  = path.join(licenseDir, 'license.json');
const salesFile    = path.join(licenseDir, 'sales-log.json');
const settingsFile  = path.join(dataDir, 'settings.json');
const credsFile     = path.join(licenseDir, 'creds.json');   // encrypted API keys
const schwabTokenFile = path.join(dataDir, 'schwab-token.json');

// ── Schwab OAuth helpers ──────────────────────────────────
// Schwab Developer API (formerly TD Ameritrade) uses OAuth 2.0.
// Docs: https://developer.schwab.com
// Flow:
//   1. User visits authorization URL in their browser
//   2. Schwab redirects to our local callback with ?code=...
//   3. We exchange code for access_token + refresh_token
//   4. We store tokens encrypted and refresh automatically

function getSchwabTokens() { return readSecure(schwabTokenFile); }

function saveSchwabTokens(tokens) {
  writeSecure(schwabTokenFile, {
    access_token:  tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at:    tokens.expires_at,
    saved_at:      new Date().toISOString(),
  });
}

async function refreshSchwabToken(clientId, clientSecret) {
  const tokens = getSchwabTokens();
  if (!tokens?.refresh_token) return null;
  const body = new URLSearchParams({
    grant_type:    'refresh_token',
    refresh_token: tokens.refresh_token,
  }).toString();
  return new Promise((resolve) => {
    const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const opts = {
      hostname: 'api.schwabapi.com',
      path:     '/v1/oauth/token',
      method:   'POST',
      headers:  {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': `Basic ${auth}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.access_token) {
            const newTokens = {
              access_token:  parsed.access_token,
              refresh_token: parsed.refresh_token || tokens.refresh_token,
              expires_at:    new Date(Date.now() + (parsed.expires_in || 1800) * 1000).toISOString(),
            };
            saveSchwabTokens(newTokens);
            resolve(newTokens);
          } else { resolve(null); }
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function getSchwabAccessToken(clientId, clientSecret) {
  let tokens = getSchwabTokens();
  if (!tokens) return null;
  // Refresh if expiring within 5 minutes
  const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
  if (Date.now() > expiresAt - 5 * 60 * 1000) {
    log('Schwab: refreshing access token');
    tokens = await refreshSchwabToken(clientId, clientSecret);
  }
  return tokens?.access_token || null;
}

async function fetchSchwabPrices(trades, clientId, clientSecret) {
  const prices   = {};
  const token    = await getSchwabAccessToken(clientId, clientSecret);
  if (!token) { log('Schwab: no valid access token'); return prices; }

  const headers  = { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' };
  const tickers  = [...new Set(trades.map(t => t.ticker))];

  // Step 1: Stock quotes — batch all tickers
  try {
    const symbols = tickers.join('%2C');
    const data    = await httpGet(
      `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${symbols}&fields=quote`,
      headers
    );
    tickers.forEach(ticker => {
      const q = data[ticker]?.quote;
      if (q) {
        const stockVal = q.lastPrice || q.closePrice;
        if (stockVal) {
          prices[ticker] = { stock: stockVal };
          // Write to each trade with this ticker so getStkPrice(trade.id) works
          trades.filter(t => t.ticker === ticker).forEach(t => {
            if (!prices[t.id]) prices[t.id] = {};
            prices[t.id].stock = stockVal;
          });
        }
      }
    });
  } catch (e) { log('Schwab stock quotes error: ' + e.message); }

  // Step 2: Option quotes — all strategies including IC/Cal/Straddle legs
  // buildTradierOptionSymbol now handles all strategies (same OCC format)
  const optTrades = trades.filter(t => t.expiration);
  for (const trade of optTrades) {
    const result = buildTradierOptionSymbol(trade);
    if (!result) continue;

    const entries = Array.isArray(result) ? result : [{ symbol: result, legKey: 'main' }];
    const legResults = {};

    for (const entry of entries) {
      if (!entry.symbol) continue;
      try {
        const data = await httpGet(
          `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(entry.symbol)}&fields=quote`,
          headers
        );
        const q = data[entry.symbol]?.quote;
        if (q) {
          const mid = (q.bidPrice && q.askPrice) ? (q.bidPrice + q.askPrice) / 2 : (q.lastPrice || 0);
          if (mid > 0) legResults[entry.legKey] = { mid, delta: q.delta, theta: q.theta, iv: q.volatility, gamma: q.gamma, vega: q.vega };
        }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }

    if (Object.keys(legResults).length === 0) continue;
    if (!prices[trade.id]) prices[trade.id] = {};

    if (legResults.short != null && legResults.long != null) {
      // All spread strategies: |short − long| = net spread (positive for both credit & debit)
      prices[trade.id].option = Math.round(Math.abs(legResults.short.mid - legResults.long.mid) * 100) / 100;
      // Greeks: short leg dominates
      const gr = legResults.short;
      if (gr.delta != null) prices[trade.id].delta = gr.delta;
      if (gr.theta != null) prices[trade.id].theta = gr.theta;
      if (gr.iv    != null) prices[trade.id].iv    = gr.iv;
    } else if (legResults.call && legResults.put) {
      prices[trade.id].option = Math.round((legResults.call.mid + legResults.put.mid) * 100) / 100;
      const ivC = legResults.call.iv, ivP = legResults.put.iv;
      if (ivC != null && ivP != null) prices[trade.id].iv = Math.round((ivC + ivP) / 2 * 10) / 10;
      const dC = legResults.call.delta, dP = legResults.put.delta;
      if (dC != null && dP != null) prices[trade.id].delta = Math.round((dC + dP) * 100) / 100;
    } else {
      const r = legResults.main || legResults.short || legResults.call || legResults.put;
      prices[trade.id].option = Math.round(r.mid * 100) / 100;
      if (r.delta != null) prices[trade.id].delta = r.delta;
      if (r.theta != null) prices[trade.id].theta = r.theta;
      if (r.iv    != null) prices[trade.id].iv    = r.iv;
      if (r.gamma != null) prices[trade.id].gamma = r.gamma;
      if (r.vega  != null) prices[trade.id].vega  = r.vega;
    }
  }
  return prices;
}

// ── Encryption helpers ───────────────────────────────────────
// Derive a file-specific key from LICENSE_SECRET + filename so each
// file has a unique encryption key even if the secret is the same.
function fileKey(filePath) {
  return crypto.createHash('sha256')
    .update(LICENSE_SECRET + ':' + path.basename(filePath))
    .digest();
}

// AES-256-GCM encrypt → base64 string  {iv, tag, data}
function encrypt(plaintext, filePath) {
  const iv  = crypto.randomBytes(12);
  const key = fileKey(filePath);
  const c   = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return JSON.stringify({
    v:    2,
    iv:   iv.toString('hex'),
    tag:  tag.toString('hex'),
    data: enc.toString('hex'),
  });
}

// AES-256-GCM decrypt → plaintext string, or null on any failure
function decrypt(ciphertext, filePath) {
  try {
    const obj = JSON.parse(ciphertext);
    if (obj.v !== 2) return null; // legacy plain file — reject
    const key = fileKey(filePath);
    const d   = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(obj.iv, 'hex')
    );
    d.setAuthTag(Buffer.from(obj.tag, 'hex'));
    return d.update(Buffer.from(obj.data, 'hex')) + d.final('utf8');
  } catch { return null; }
}

// HMAC of the plaintext payload — stored INSIDE the encrypted blob
// so tampering with the ciphertext (which breaks AES-GCM auth) AND
// editing the plaintext before re-encrypting (which breaks HMAC)
// are both detected.
function sign(payload) {
  return crypto.createHmac('sha256', LICENSE_SECRET)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
}

function readSecure(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const plain = decrypt(raw, file);
    if (!plain) { log('SECURITY: decrypt failed for ' + path.basename(file)); return null; }
    const obj = JSON.parse(plain);
    // Verify inner HMAC
    const { _sig, ...data } = obj;
    if (!_sig) { log('SECURITY: missing sig in ' + path.basename(file)); return null; }
    const expected = sign(data);
    if (!crypto.timingSafeEqual(Buffer.from(_sig, 'hex'), Buffer.from(expected, 'hex'))) {
      log('SECURITY: HMAC mismatch in ' + path.basename(file) + ' — tampered');
      return null;
    }
    return data;
  } catch { return null; }
}

function writeSecure(file, data) {
  try {
    const payload = { ...data, _sig: sign(data) };
    fs.writeFileSync(file, encrypt(JSON.stringify(payload), file));
    return true;
  } catch { return false; }
}

// Legacy plain readJSON still used for non-sensitive files (settings, sales-log)
function readJSON(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeJSON(file, data) { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); return true; } catch { return false; } }

// ── Machine fingerprint ───────────────────────────────────
// Stable identifier derived from hostname + CPU model + platform.
// Not cryptographically strong but raises the bar significantly
// against copying license files between machines.
function getMachineId() {
  const cpus = os.cpus();
  const raw  = [
    os.hostname(),
    cpus.length > 0 ? cpus[0].model : '',
    os.platform(),
    os.arch(),
  ].join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

// ── Clock skew detection ──────────────────────────────────
// If the system clock has been wound back more than 25 hours
// relative to the last time we saw a valid timestamp, treat
// the trial as tampered.
function isClockTampered(lastSeenIso) {
  if (!lastSeenIso) return false;
  const lastSeen = new Date(lastSeenIso).getTime();
  const now      = Date.now();
  return now < lastSeen - 25 * 3600 * 1000; // >25h in the past
}

// ── Paddle server-side license validation ─────────────────
// The backend calls Paddle directly — the frontend cannot lie.
// Paddle license keys are validated via the /licenses/activate endpoint.
// Each key supports a configurable number of activations (set in Paddle dashboard).
// ── Gumroad server-side license validation ─────────────────
// The backend calls Gumroad directly — the frontend cannot lie.
// Gumroad license keys are validated via the /v2/licenses/verify endpoint.
// increment_uses_count=true tracks how many machines have activated this key.
async function validateWithGumroad(key) {
  return new Promise((resolve) => {
    const body = new URLSearchParams({
      product_permalink:    process.env.GUMROAD_PRODUCT_PERMALINK || GUMROAD_PRODUCT_PERMALINK,
      license_key:          key,
      increment_uses_count: 'true',
    }).toString();
    const opts = {
      hostname: 'api.gumroad.com',
      path:     '/v2/licenses/verify',
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Accept':         'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 8000,
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          // Gumroad returns { success: true, purchase: { ... } } on valid key
          if (parsed.success === true) {
            const purchase = parsed.purchase || {};
            // Check if refunded or chargebacked — treat as invalid
            if (purchase.refunded || purchase.chargebacked) {
              resolve({
                valid:   false,
                error:   'refunded',
                message: 'This license has been refunded and is no longer valid.',
              });
              return;
            }
            resolve({
              valid:   true,
              plan:    'MyOptionDiary',
              expires: null, // Gumroad one-time purchases do not expire
              email:   purchase.email || null,
              error:   null,
            });
          } else {
            // Gumroad error — key not found or already used too many times
            resolve({
              valid:   false,
              error:   'invalid_key',
              message: parsed.message || 'License key is not valid.',
            });
          }
        } catch { resolve({ valid: false, error: 'parse_error' }); }
      });
    });
    req.on('error', () => resolve({ valid: false, error: 'network_error' }));
    req.on('timeout', () => { req.destroy(); resolve({ valid: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function checkAccess() {
  // ── 1. Check license file (encrypted + HMAC signed) ────
  const lic = readSecure(licenseFile);
  if (lic?.key) {
    // Verify machine fingerprint — stops copying license.json between PCs
    const currentMachine = getMachineId();
    if (lic.machine_id && lic.machine_id !== currentMachine) {
      log('SECURITY: license machine_id mismatch — file copied from another machine');
      // Don't reveal why — just fall through to trial check
    } else {
      if (!lic.expires) return { allowed: true, mode: 'licensed', reason: null };
      if (Math.ceil((new Date(lic.expires) - Date.now()) / 86400000) > 0) {
        return { allowed: true, mode: 'licensed', reason: null };
      }
      // License expired
      return { allowed: false, mode: 'license_expired', reason: 'license_expired' };
    }
  }

  // ── 2. Check trial file (encrypted + HMAC signed) ──────
  let trial = readSecure(trialFile);

  // If trial file missing or tampered, check DB anchor
  if (!trial) {
    const dbTrial = safeDbGet("SELECT value FROM _meta WHERE key='trial_start'");
    if (dbTrial?.value) {
      log('SECURITY: trial.json missing/tampered — restoring from DB anchor');
      trial = { start_date: dbTrial.value, started_at: dbTrial.value + 'T00:00:00.000Z', last_seen: new Date().toISOString() };
      writeSecure(trialFile, trial);
    }
  }

  // If still no trial, start fresh
  if (!trial) {
    const today = localDateISO();
    trial = { start_date: today, started_at: new Date().toISOString(), last_seen: new Date().toISOString() };
    writeSecure(trialFile, trial);
    // Also anchor in DB
    try { db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES ('trial_start', ?)", [today]); saveDb(); } catch {}
  }

  // ── 3. Clock tamper check ───────────────────────────────
  if (isClockTampered(trial.last_seen)) {
    log('SECURITY: clock wound back — treating trial as expired');
    return { allowed: false, mode: 'expired', reason: 'trial_expired' };
  }

  // Update last_seen timestamp (detects future clock rewinds)
  trial.last_seen = new Date().toISOString();
  writeSecure(trialFile, trial);

  // ── 4. Calculate days remaining ─────────────────────────
  const daysRemaining = Math.max(0, 14 - Math.floor((Date.now() - new Date(trial.start_date)) / 86400000));
  if (daysRemaining > 0) return { allowed: true, mode: 'trial', reason: null, daysRemaining };
  return { allowed: false, mode: 'expired', reason: 'trial_expired' };
}

// Safe DB query — doesn't throw if table doesn't exist yet
function safeDbGet(sql, params = []) {
  try { return dbGet(sql, params); } catch { return null; }
}

function httpGet(url, headers = {}, _redirects = 0) {
  // Follow up to 5 redirects — Yahoo consent wall and URL changes return 301/302.
  // Without this, httpGet gets back HTML instead of JSON and throws "Invalid JSON".
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers }, resp => {
      const { statusCode, headers: respHeaders } = resp;
      // Follow redirects (301/302/303/307/308)
      if ([301, 302, 303, 307, 308].includes(statusCode) && respHeaders.location) {
        resp.resume(); // drain response
        if (_redirects >= 5) return reject(new Error('Too many redirects'));
        const next = respHeaders.location.startsWith('http')
          ? respHeaders.location
          : new URL(respHeaders.location, url).href;
        return resolve(httpGet(next, headers, _redirects + 1));
      }
      let data = '';
      resp.on('data', d => data += d);
      resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('Request timed out')); });
  });
}

// ── Server-side trade validation ─────────────────────────────────────────────
// Mirrors the frontend validation rules so the database never receives bad data
// even if a request comes from outside the UI (API clients, imports, etc.)
const CREDIT_STRATS_BE  = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly']);
const SPREAD_STRATS_BE  = new Set(['Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread','Bear Put Spread']);
const NO_LOT_STRATS_BE  = new Set(['Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread','Bear Put Spread','Long Call','Long Put','Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread']);
const LONG_STRATS_BE    = new Set(['Long Call','Long Put','Long Straddle','Long Strangle','Bull Call Spread','Bear Put Spread','Calendar Spread','Diagonal Spread']);

// IC leg-closure exemption: closed IC legs sharing condor_chain_id with an open
// parent may have a future expiration (they were closed early within a live chain).
// These are bypassed for the "closed trade must have past expiry" check.
function isICLegClose(d) {
  return ['Iron Condor','Iron Butterfly'].includes(d.strategy) && d.status === 'closed' && d.condor_chain_id != null;
}

function validateTrade(d, isUpdate = false) {
  const errors = [];
  const today = localDateISO();

  const strategy  = d.strategy || '';
  const status    = d.status   || 'open';
  const isOpen    = status === 'open';
  const isClosed  = status === 'closed';
  const isSpread  = SPREAD_STRATS_BE.has(strategy);
  const noLot     = NO_LOT_STRATS_BE.has(strategy);
  const isLong    = LONG_STRATS_BE.has(strategy);
  const isCC      = strategy === 'Covered Call';
  const isCSP     = strategy === 'Cash-Secured Put';

  const entryDate = d.entry_date;
  const expiry    = d.expiration;
  const exitDate  = d.exit_date;
  const ep        = parseFloat(d.entry_price);
  const xp        = parseFloat(d.exit_price);

  // Date checks
  if (entryDate && entryDate > today && !isUpdate)
    errors.push('entry_date cannot be in the future');
  if (!expiry)
    errors.push('expiration is required');
  if (entryDate && expiry && expiry <= entryDate)
    errors.push('expiration must be after entry_date');
  if (isOpen && expiry && expiry < today && !d.historical_mode)
    errors.push('open trade cannot have a past expiration');
  if (isClosed && !exitDate && !isICLegClose(d))
    errors.push('exit_date is required for closed trades');
  if (isClosed && exitDate && entryDate && exitDate < entryDate)
    errors.push('exit_date cannot be before entry_date');
  if (isClosed && exitDate && expiry && exitDate > expiry && !isICLegClose(d))
    errors.push('exit_date cannot be after expiration');

  // Price checks
  // Cal/Diagonal: entry_price = cal_long_cost − cal_short_credit computed by frontend submit().
  // IC/IB: entry_price = put_credit + call_credit computed by frontend submit().
  // Both arrive as computed positive values — validate them with the same > 0 check.
  const isCalDiagBE = ['Calendar Spread','Diagonal Spread'].includes(strategy);
  const isICBE       = ['Iron Condor','Iron Butterfly'].includes(strategy);
  if (!d.entry_price || isNaN(ep) || ep <= 0)
    errors.push('entry_price is required and must be > 0');
  if (isClosed && (d.exit_price === undefined || d.exit_price === null || d.exit_price === ''))
    errors.push('exit_price is required for closed trades');
  if (d.exit_price != null && d.exit_price !== '' && !isNaN(xp) && xp < 0)
    errors.push('exit_price cannot be negative');

  // Contract checks
  const contracts = parseInt(d.contracts);
  if (isNaN(contracts) || contracts < 1)
    errors.push('contracts must be >= 1');

  // option_type required for Calendar / Diagonal
  if (['Calendar Spread','Diagonal Spread'].includes(strategy)) {
    if (!d.option_type || !['call','put'].includes(d.option_type))
      errors.push('option_type is required for Calendar/Diagonal — must be "call" or "put"');
    // Calendar: front month expiry must be before back month
    if (d.expiration_back && expiry && d.expiration_back <= expiry)
      errors.push('expiration_back (back month) must be after expiration (front month)');
  }

  // Strike checks
  if (isCC && (!d.strike_sell || parseFloat(d.strike_sell) <= 0))
    errors.push('strike_sell is required for Covered Calls');
  if (isCSP && (!d.strike_buy || parseFloat(d.strike_buy) <= 0))
    errors.push('strike_buy is required for Cash-Secured Puts');
  if (isSpread) {
    const sb = parseFloat(d.strike_buy), ss = parseFloat(d.strike_sell);
    if (!d.strike_buy  || isNaN(sb) || sb <= 0) errors.push('strike_buy required for spread');
    if (!d.strike_sell || isNaN(ss) || ss <= 0) errors.push('strike_sell required for spread');
    if (!isNaN(sb) && !isNaN(ss)) {
      if (strategy === 'Bull Put Spread'  && ss <= sb) errors.push('Bull Put Spread: strike_sell must be > strike_buy');
      if (strategy === 'Bear Call Spread' && sb <= ss) errors.push('Bear Call Spread: strike_buy must be > strike_sell');
      if (strategy === 'Bull Call Spread' && ss <= sb) errors.push('Bull Call Spread: strike_sell must be > strike_buy');
      if (strategy === 'Bear Put Spread'  && sb <= ss) errors.push('Bear Put Spread: strike_buy must be > strike_sell');
    }
  }

  return errors;
}

// Normalise any common broker date format to YYYY-MM-DD
// Handles: YYYY-MM-DD, MM/DD/YYYY, MM/DD/YY, DDMMMYY (IBKR), DDMMMYYYY
function normaliseExpiry(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // Already YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY or MM/DD/YY
  const slash = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (slash) {
    const [, m, d, y] = slash;
    const yr = y.length === 2 ? (parseInt(y) > 50 ? '19' + y : '20' + y) : y;
    return `${yr}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
  }

  // DDMMMYY or DDMMMYYYY — IBKR format e.g. 17JAN25 or 17JAN2025
  const ibkr = s.match(/^(\d{1,2})([A-Za-z]{3})(\d{2,4})$/);
  if (ibkr) {
    const months = { JAN:'01',FEB:'02',MAR:'03',APR:'04',MAY:'05',JUN:'06',
                     JUL:'07',AUG:'08',SEP:'09',OCT:'10',NOV:'11',DEC:'12' };
    const [, d, mon, y] = ibkr;
    const m = months[mon.toUpperCase()];
    if (m) {
      const yr = y.length === 2 ? '20' + y : y;
      return `${yr}-${m}-${d.padStart(2,'0')}`;
    }
  }

  // YYYYMMDD (no separators)
  if (/^\d{8}$/.test(s)) return `${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`;

  return null; // unrecognised — return null to skip symbol build
}

// buildTradierOptionSymbol returns one OCC symbol string for simple strategies,
// or an array of { symbol, tradeId, legKey } for multi-leg strategies.
// Returns null if the trade has insufficient data to build a symbol.
function buildTradierOptionSymbol(trade) {
  const strat = trade.strategy;
  const exp   = trade.expiration;
  const ss    = parseFloat(trade.strike_sell) || 0;
  const sb    = parseFloat(trade.strike_buy)  || 0;

  if (!exp) return null;

  const normDate = normaliseExpiry(exp);
  if (!normDate) {
    log(`buildTradierOptionSymbol: unrecognised expiry "${exp}" for trade ${trade.id}`);
    return null;
  }
  const expStr = normDate.replace(/-/g, '').slice(2); // YYMMDD

  function occ(ticker, strikeVal, isCallFlag) {
    if (!strikeVal || strikeVal <= 0) return null;
    const strikePad = String(Math.round(strikeVal * 1000)).padStart(8, '0');
    return `${ticker}${expStr}${isCallFlag ? 'C' : 'P'}${strikePad}`;
  }

  // ── Simple single-leg strategies ──────────────────────────
  if (['Covered Call','Long Call'].includes(strat))
    return occ(trade.ticker, ss || sb, true);
  if (['Cash-Secured Put','Long Put'].includes(strat))
    return occ(trade.ticker, sb || ss, false);

  // ── 2-leg vanilla spreads: return [{short},{long}] like IC/IB ──
  // Credit spreads: short=ss, long=sb
  if (strat === 'Bull Put Spread') {
    const results = [];
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, false), legKey: 'short' });
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, false), legKey: 'long'  });
    return results.length > 0 ? results : null;
  }
  if (strat === 'Bear Call Spread') {
    const results = [];
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, true),  legKey: 'short' });
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, true),  legKey: 'long'  });
    return results.length > 0 ? results : null;
  }
  // Debit spreads: long=sb (expensive leg), short=ss (cap)
  if (strat === 'Bull Call Spread') {
    const results = [];
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, true),  legKey: 'long'  });
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, true),  legKey: 'short' });
    return results.length > 0 ? results : null;
  }
  if (strat === 'Bear Put Spread') {
    const results = [];
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, false), legKey: 'long'  });
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, false), legKey: 'short' });
    return results.length > 0 ? results : null;
  }

  // ── IC / IB chain legs ────────────────────────────────────
  // Each IC leg record has both strike_sell (short) and strike_buy (long wing).
  // Return an array of two symbols so fetchTradierPrices can compute net spread.
  if (['Iron Condor','Iron Butterfly'].includes(strat)) {
    const leg    = trade.condor_leg;
    const isCall = (leg === 'call' || leg === 'full');
    const results = [];
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, isCall), legKey: 'short' });
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, isCall), legKey: 'long'  });
    return results.length > 0 ? results : null;
  }

  // ── Calendar / Diagonal ───────────────────────────────────
  if (['Calendar Spread','Diagonal Spread'].includes(strat)) {
    const leg      = trade.cal_leg;
    const isCallOt = trade.option_type !== 'put'; // default to call if not set
    const expBack  = normaliseExpiry(trade.expiration_back || exp);
    if (leg === 'short') return occ(trade.ticker, ss || sb, isCallOt);
    if (leg === 'long') {
      const expBackStr = (expBack || normDate).replace(/-/g, '').slice(2);
      const strike = sb || ss;
      if (!strike) return null;
      const cpChar = isCallOt ? 'C' : 'P';
      return `${trade.ticker}${expBackStr}${cpChar}${String(Math.round(strike * 1000)).padStart(8, '0')}`;
    }
    // No cal_leg set — use strike_sell
    return occ(trade.ticker, ss || sb, isCallOt);
  }

  // ── Straddle / Strangle — return both legs as an array ────
  // fetchTradierPrices handles the array case below.
  if (['Long Straddle','Long Strangle'].includes(strat)) {
    const results = [];
    if (ss > 0) results.push({ symbol: occ(trade.ticker, ss, true),  legKey: 'call' });
    if (sb > 0) results.push({ symbol: occ(trade.ticker, sb, false), legKey: 'put'  });
    return results.length > 0 ? results : null;
  }

  return null;
}

async function fetchTradierPrices(trades, apiKey) {
  const prices = {};
  const stockSymbols = [...new Set(trades.map(t => t.ticker))].join(',');

  // Build flat list of { symbol, tradeId, legKey } for all option trades
  const optionEntries = [];
  trades.forEach(trade => {
    const result = buildTradierOptionSymbol(trade);
    if (!result) return;
    if (Array.isArray(result)) {
      result.forEach(r => { if (r.symbol) optionEntries.push({ symbol: r.symbol, tradeId: trade.id, legKey: r.legKey, strat: trade.strategy }); });
    } else {
      optionEntries.push({ symbol: result, tradeId: trade.id, legKey: 'main', strat: trade.strategy });
    }
  });
  const optionSymbols = [...new Set(optionEntries.map(e => e.symbol))].join(',');

  try {
    if (stockSymbols) {
      const data = await httpGet(`https://api.tradier.com/v1/markets/quotes?symbols=${stockSymbols}`, { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' });
      [].concat(data.quotes?.quote || []).forEach(q => {
        const stockVal = q.last || q.close;
        if (stockVal) {
          prices[q.symbol] = { stock: stockVal };
          // Also write to each trade with this ticker so getStkPrice(trade.id) works
          trades.filter(t => t.ticker === q.symbol).forEach(t => {
            if (!prices[t.id]) prices[t.id] = {};
            prices[t.id].stock = stockVal;
          });
        }
      });
    }
  } catch {}

  try {
    if (optionSymbols) {
      const data = await httpGet(`https://api.tradier.com/v1/markets/quotes?symbols=${optionSymbols}&greeks=true`, { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' });
      const quotes = [].concat(data.quotes?.quote || []);

      // Group entries by tradeId to handle Straddle/Strangle multi-leg averaging
      const byTrade = {};
      optionEntries.forEach(e => {
        if (!byTrade[e.tradeId]) byTrade[e.tradeId] = { entries: [], strat: e.strat };
        byTrade[e.tradeId].entries.push(e);
      });

      Object.entries(byTrade).forEach(([tradeId, { entries, strat }]) => {
        const legMids = {};
        const legGreeks = {};
        entries.forEach(e => {
          const q = quotes.find(q => q.symbol === e.symbol);
          if (!q) return;
          const bid = parseFloat(q.bid) || 0;
          const ask = parseFloat(q.ask) || 0;
          const last = parseFloat(q.last) || 0;
          let mid = null;
          if (bid > 0 && ask > 0 && ask >= bid) mid = (bid + ask) / 2;
          else if (last > 0) mid = last;
          if (mid != null && mid > 0) {
            legMids[e.legKey] = Math.round(mid * 100) / 100;
            legGreeks[e.legKey] = {
              delta: q.greeks?.delta ?? null,
              theta: q.greeks?.theta ?? null,
              iv:    q.greeks?.smv_vol || q.greeks?.mid_iv || null,
            };
          }
        });

        if (Object.keys(legMids).length === 0) return;

        if (!prices[tradeId]) prices[tradeId] = {};

        if (legMids.short != null && legMids.long != null) {
          // All spread strategies: |short − long| = net spread (positive for credit & debit)
          prices[tradeId].option = Math.round(Math.abs(legMids.short - legMids.long) * 100) / 100;
          // Greeks: short leg dominates
          const gr = legGreeks.short;
          if (gr?.delta != null) prices[tradeId].delta = gr.delta;
          if (gr?.theta != null) prices[tradeId].theta = gr.theta;
          if (gr?.iv    != null) prices[tradeId].iv    = gr.iv;
        } else if (legMids.call != null && legMids.put != null) {
          // Straddle/Strangle: combined premium, averaged IV/delta
          prices[tradeId].option = Math.round((legMids.call + legMids.put) * 100) / 100;
          const ivC = legGreeks.call?.iv, ivP = legGreeks.put?.iv;
          if (ivC != null && ivP != null) prices[tradeId].iv = Math.round((ivC + ivP) / 2 * 10) / 10;
          const dC = legGreeks.call?.delta, dP = legGreeks.put?.delta;
          if (dC != null && dP != null) prices[tradeId].delta = Math.round((dC + dP) * 100) / 100;
        } else {
          const mid = legMids.main ?? legMids.short ?? legMids.call ?? legMids.put;
          const gr  = legGreeks.main ?? legGreeks.short ?? legGreeks.call ?? legGreeks.put;
          prices[tradeId].option = mid;
          if (gr?.delta != null) prices[tradeId].delta = gr.delta;
          if (gr?.theta != null) prices[tradeId].theta = gr.theta;
          if (gr?.iv    != null) {
            prices[tradeId].iv = gr.iv;
            // Also write IV under ticker key for CC/CSP recommendation strip
            if (t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put') {
              const tk = t.ticker?.toUpperCase();
              if (tk) {
                if (!prices[tk]) prices[tk] = {};
                prices[tk].iv = gr.iv;
              }
            }
          }
        }
      });
    }
  } catch {}
  return prices;
}

async function fetchPolygonPrices(trades, apiKey) {
  // Polygon free tier: stock prices only — no option quotes available.
  // Option prices must be entered manually by the user.
  const prices = {};
  const tickers = [...new Set(trades.map(t => t.ticker))];
  for (const ticker of tickers) {
    try {
      const data = await httpGet(`https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${ticker}?apiKey=${apiKey}`);
      const price = data.ticker?.day?.c || data.ticker?.prevDay?.c;
      if (price) {
        prices[ticker] = { stock: price };
        // Write to each trade with this ticker so getStkPrice(trade.id) works
        trades.filter(t => t.ticker === ticker).forEach(t => {
          if (!prices[t.id]) prices[t.id] = {};
          prices[t.id].stock = price;
        });
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  return prices;
}

async function init() {
  try {
    // Resolve sql-wasm.wasm path — it can be in different locations depending
    // on how electron-builder packed the app. Check all candidates in order.
    const resources = process.env.OTT_RESOURCES || path.join(__dirname, '..');
    const wasmCandidates = IS_ELECTRON
      ? [
          // Candidate 1: backend node_modules (most common with extraResources config)
          path.join(resources, 'backend', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
          // Candidate 2: app.asar.unpacked (asarUnpack config)
          path.join(resources, 'app.asar.unpacked', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
          // Candidate 3: same directory as the backend script
          path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
          // Candidate 4: resources root
          path.join(resources, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        ]
      : [
          path.join(__dirname, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
        ];

    const wasmPath = wasmCandidates.find(p => fs.existsSync(p));
    log('WASM search paths: ' + wasmCandidates.join(' | '));
    log('WASM found at: ' + (wasmPath || 'NOT FOUND — will use default'));

    const locateFile = wasmPath
      ? (filename) => filename === 'sql-wasm.wasm' ? wasmPath : filename
      : undefined;

    const SQL = await initSqlJs(locateFile ? { locateFile } : {});
    db = fs.existsSync(dbPath) ? new SQL.Database(fs.readFileSync(dbPath)) : new SQL.Database();
    db.run(SCHEMA);
    try { db.run('ALTER TABLE trades ADD COLUMN roll_parent_id INTEGER'); } catch {}
    try { db.run('ALTER TABLE trades ADD COLUMN roll_count INTEGER DEFAULT 0'); } catch {}
    // Calendar Spread chain fields (mirrors IC condor_chain model)
    try { db.run('ALTER TABLE trades ADD COLUMN expiration_back TEXT'); } catch {}       // back month expiry (long leg)
    try { db.run('ALTER TABLE trades ADD COLUMN cal_chain_id INTEGER'); } catch {}       // groups all legs of one calendar campaign
    try { db.run('ALTER TABLE trades ADD COLUMN cal_leg TEXT'); } catch {}               // 'short' | 'long' | 'full'
    try { db.run('ALTER TABLE trades ADD COLUMN cal_seq INTEGER DEFAULT 0'); } catch {}  // adjustment sequence (0=original, 1,2,3=adjustments)
    try { db.run("CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); } catch {}
    // ── Iron Condor chain columns (parallel to roll chain — do NOT touch roll_parent_id) ──
    try { db.run('ALTER TABLE trades ADD COLUMN condor_chain_id INTEGER'); } catch {}
    try { db.run("ALTER TABLE trades ADD COLUMN condor_leg TEXT"); } catch {}
    try { db.run('ALTER TABLE trades ADD COLUMN condor_seq INTEGER DEFAULT 0'); } catch {}
    try { db.run('ALTER TABLE trades ADD COLUMN contracts_original INTEGER'); } catch {}
    try { db.run('ALTER TABLE trades ADD COLUMN contracts_open INTEGER'); } catch {}
    try { db.run('ALTER TABLE trades ADD COLUMN contracts_closed INTEGER DEFAULT 0'); } catch {}
    try { db.run("ALTER TABLE trades ADD COLUMN option_type TEXT"); } catch {} // 'call' | 'put' for Calendar/Diagonal
    try { db.run('ALTER TABLE trades ADD COLUMN partial_close_pnl REAL DEFAULT 0'); } catch {}
    saveDb();
    log('Database ready: ' + dbPath);
  } catch (e) {
    log('FATAL: Database failed to initialize: ' + e.message);
    process.exit(1);
  }

  const app = express();
  app.use(cors({ origin: (origin, cb) => {
    // Allow localhost on any port 3000-3010 (dynamic port selection)
    if (!origin || /^http:\/\/127\.0\.0\.1:(3\d{3}|30[0-9]{2})$/.test(origin) || /^http:\/\/localhost:(3\d{3}|30[0-9]{2})$/.test(origin) || origin === 'app://') {
      cb(null, true);
    } else {
      cb(null, false);
    }
  }}));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 500, standardHeaders: true, legacyHeaders: false }));

  app.post('/api/webhook/gumroad', express.json(), (req, res) => {
    try {
      // Gumroad sends a POST with seller_id, product_permalink, license_key, email etc.
      const { license_key, email, product_name, sale_id } = req.body;
      const sales = readJSON(salesFile) || [];
      sales.push({
        event:       'sale',
        license_key: license_key ? license_key.slice(0, 8) + '...' : 'unknown',
        email:       email || null,
        product:     product_name || 'MyOptionDiary',
        sale_id:     sale_id || null,
        at:          new Date().toISOString(),
      });
      writeJSON(salesFile, sales);
      log('Gumroad webhook received: sale for ' + (email || 'unknown'));
      res.json({ ok: true });
    } catch (e) {
      log('Gumroad webhook error: ' + e.message);
      res.status(400).json({ error: 'webhook_error' });
    }
  });

  app.use(express.json({ limit: '10kb' }));

  const LICENSE_ROUTES = ['/api/license/trial', '/api/license/trial/start', '/api/license/activate', '/api/license/status', '/api/webhook/gumroad'];

  app.get('/api/license/trial', (req, res) => {
    // checkAccess() already updates last_seen — just read current state
    const access = checkAccess();
    const trial  = readSecure(trialFile);
    if (!trial) return res.json({ trial_start: null, days_used: 0, days_remaining: 14, expired: false });
    const daysUsed = Math.floor((Date.now() - new Date(trial.start_date)) / 86400000);
    res.json({ trial_start: trial.start_date, days_used: daysUsed, days_remaining: Math.max(0, 14 - daysUsed), expired: daysUsed >= 14 });
  });
  app.post('/api/license/trial/start', (req, res) => {
    if (readSecure(trialFile)) return res.json({ ok: true, message: 'Trial already started' });
    const today = localDateISO();
    writeSecure(trialFile, { start_date: today, started_at: new Date().toISOString(), last_seen: new Date().toISOString() });
    // Anchor in DB too
    try { db.run("INSERT OR REPLACE INTO _meta (key, value) VALUES ('trial_start', ?)", [today]); saveDb(); } catch {}
    res.json({ ok: true });
  });
  app.post('/api/license/activate', async (req, res) => {
    if (!req.body.key) return res.status(400).json({ error: 'key required' });
    const key = req.body.key.trim();

    // Backend validates key with Lemon Squeezy directly — frontend cannot lie
    log('License activation attempt for key: ' + key.slice(0,8) + '...');
    const result = await validateWithGumroad(key);

    if (!result.valid) {
      // Network error — allow offline fallback via license-db.json only
      if (result.error === 'network_error' || result.error === 'timeout') {
        log('Paddle unreachable — attempting offline fallback');
        // Offline fallback is handled by the frontend; backend records a pending state
        // but does NOT grant access without at least one successful online validation.
        return res.status(503).json({ error: 'offline', message: 'Cannot reach validation server. Check your internet connection.' });
      }
      log('License validation failed: ' + result.error);
      return res.status(402).json({ error: 'invalid_key', message: result.error || 'License key is not valid.' });
    }

    // Key is valid — write encrypted license with machine fingerprint
    const licData = {
      key,
      plan:         result.plan,
      expires:      result.expires || null,
      machine_id:   getMachineId(),
      activated_at: new Date().toISOString(),
      validated_at: new Date().toISOString(),
    };
    writeSecure(licenseFile, licData);
    log('License activated: ' + result.plan + (result.expires ? ' expires ' + result.expires : ' lifetime'));
    res.json({ ok: true, plan: result.plan, expires: result.expires });
  });
  app.get('/api/license/status', (req, res) => res.json(checkAccess()));

  app.use('/api', (req, res, next) => {
    if (LICENSE_ROUTES.some(r => req.path.startsWith(r.replace('/api', '')))) return next();
    const current = checkAccess();
    if (!current.allowed) return res.status(402).json({ error: 'access_denied', reason: current.reason });
    next();
  });

  app.get('/health', (req, res) => {
    const access = checkAccess();
    if (!access.allowed) return res.status(402).json({ status: 'payment_required' });
    res.json({ status: 'ok', db: 'connected', timestamp: new Date().toISOString() });
  });

  // Client-side error reporting — ErrorBoundary posts here so crashes are logged
  app.post('/api/client-error', express.json(), (req, res) => {
    const { component, error, stack } = req.body || {};
    log(`CLIENT ERROR in [${component}]: ${error}`);
    if (stack) log(`  Stack: ${stack.slice(0, 300)}`);
    res.json({ ok: true });
  });

  // General frontend event log — for non-error events worth tracking
  app.post('/api/log', express.json(), (req, res) => {
    const { event, detail } = req.body || {};
    if (event) log(`[UI] ${event}${detail ? ': ' + detail : ''}`);
    res.json({ ok: true });
  });

  app.get('/api/lots', (req, res) => res.json(dbAll('SELECT * FROM purchase_lots ORDER BY ticker, purchase_date')));
  app.get('/api/lots/:id', (req, res) => { const lot = dbGet('SELECT * FROM purchase_lots WHERE id=?', [req.params.id]); lot ? res.json(lot) : res.status(404).json({ error: 'not found' }); });
  app.post('/api/lots', (req, res) => {
    const { ticker, shares, avg_cost, purchase_date, close_date, close_price, notes } = req.body;
    const today = localDateISO();
    const errs = [];
    if (!ticker || !String(ticker).trim())                        errs.push('ticker is required');
    if (!shares || isNaN(parseFloat(shares)) || parseFloat(shares) < 1) errs.push('shares must be >= 1');
    if (!avg_cost || isNaN(parseFloat(avg_cost)) || parseFloat(avg_cost) <= 0) errs.push('avg_cost must be > 0');
    if (!purchase_date)                                           errs.push('purchase_date is required');
    if (purchase_date && purchase_date > today)                   errs.push('purchase_date cannot be in the future');
    if (close_date && purchase_date && close_date < purchase_date) errs.push('close_date cannot be before purchase_date');
    if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
    const r = dbRun('INSERT INTO purchase_lots (ticker,shares,avg_cost,purchase_date,close_date,close_price,notes) VALUES (?,?,?,?,?,?,?)',
      [String(ticker).toUpperCase(), shares, avg_cost, purchase_date||null, close_date||null, close_price||null, notes||null]);
    res.json(dbGet('SELECT * FROM purchase_lots WHERE id=?', [r.lastInsertRowid]));
  });
  app.put('/api/lots/:id', (req, res) => {
    const { ticker, shares, avg_cost, purchase_date, close_date, close_price, notes } = req.body;
    const today = localDateISO();
    const errs = [];
    if (!ticker || !String(ticker).trim())                        errs.push('ticker is required');
    if (!shares || isNaN(parseFloat(shares)) || parseFloat(shares) < 1) errs.push('shares must be >= 1');
    if (!avg_cost || isNaN(parseFloat(avg_cost)) || parseFloat(avg_cost) <= 0) errs.push('avg_cost must be > 0');
    if (!purchase_date)                                           errs.push('purchase_date is required');
    if (close_date && purchase_date && close_date < purchase_date) errs.push('close_date cannot be before purchase_date');
    if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
    dbRun('UPDATE purchase_lots SET ticker=?,shares=?,avg_cost=?,purchase_date=?,close_date=?,close_price=?,notes=?,updated_at=datetime("now") WHERE id=?',
      [String(ticker).toUpperCase(), shares, avg_cost, purchase_date||null, close_date||null, close_price||null, notes||null, req.params.id]);
    res.json(dbGet('SELECT * FROM purchase_lots WHERE id=?', [req.params.id]));
  });
  app.delete('/api/lots/:id', (req, res) => {
    const id = req.params.id;
    // Block deletion if any open trades are linked to this lot
    const openLinked = dbAll(
      "SELECT id, strategy, expiration FROM trades WHERE lot_id=? AND status='open'",
      [id]
    );
    if (openLinked.length > 0) {
      const list = openLinked.map(t => `${t.strategy} (exp ${t.expiration || '?'})`).join(', ');
      return res.status(409).json({
        error: `Cannot remove lot — ${openLinked.length} open trade(s) linked: ${list}. Close or delete those trades first.`
      });
    }
    dbRun('DELETE FROM purchase_lots WHERE id=?', [id]);
    res.json({ ok: true });
  });

  app.get('/api/trades', (req, res) => res.json(dbAll('SELECT * FROM trades ORDER BY ticker, entry_date DESC')));
  app.get('/api/trades/:id', (req, res) => { const t = dbGet('SELECT * FROM trades WHERE id=?', [req.params.id]); t ? res.json(t) : res.status(404).json({ error: 'not found' }); });
  app.post('/api/trades', (req, res) => {
    const d = req.body;
    const errs = validateTrade(d, false);
    if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
    const expiry = d.expiration ? (normaliseExpiry(d.expiration) || d.expiration) : null;
    // Auto-calculate pnl for closed imported trades that don't have it set.
    // Handles expired/assigned/called_away event rows from CSV import.
    const CREDIT_BE = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread',
      'Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread','Bear Put Spread']);
    let autoPnl = d.pnl ?? null;
    if (autoPnl == null && d.status === 'closed' && d.entry_price && parseFloat(d.entry_price) > 0.01) {
      const ep = parseFloat(d.entry_price);
      const xp = parseFloat(d.exit_price) || 0;
      const ct = parseInt(d.contracts) || 1;
      const isCredit = CREDIT_BE.has(d.strategy);
      const notes = (d.notes || '').toLowerCase();
      const sb = parseFloat(d.strike_buy)  || 0;
      const ss = parseFloat(d.strike_sell) || 0;
      const isAssignOrCallAway = (sb > 0 && Math.abs(xp - sb) < 0.01) ||
                                 (ss > 0 && Math.abs(xp - ss) < 0.01) ||
                                 notes.includes('assigned') || notes.includes('called away');
      const isExpired = xp === 0;
      if (isAssignOrCallAway) {
        autoPnl = Math.round(ep * ct * 100 * 100) / 100;
      } else if (isExpired) {
        autoPnl = isCredit
          ? Math.round(ep * ct * 100 * 100) / 100
          : Math.round(-ep * ct * 100 * 100) / 100;
      } else {
        autoPnl = isCredit
          ? Math.round((ep - xp) * ct * 100 * 100) / 100
          : Math.round((xp - ep) * ct * 100 * 100) / 100;
      }
      log('Auto-pnl: ' + d.ticker + ' ' + d.strategy + ' pnl=' + autoPnl);
    }

    let r;
    try {
      r = dbRun(`INSERT INTO trades (ticker,lot_id,strategy,status,entry_date,exit_date,expiration,expiration_back,entry_price,exit_price,contracts,strike_buy,strike_sell,delta,gamma,theta,vega,iv_entry,pnl,notes,roll_parent_id,roll_count,condor_chain_id,condor_leg,condor_seq,cal_chain_id,cal_leg,cal_seq,contracts_original,contracts_open,contracts_closed,partial_close_pnl,option_type) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [d.ticker,d.lot_id||null,d.strategy,d.status||'open',d.entry_date||null,d.exit_date||null,expiry,d.expiration_back||null,d.entry_price||null,d.exit_price||null,d.contracts||1,d.strike_buy||null,d.strike_sell||null,d.delta||null,d.gamma||null,d.theta||null,d.vega||null,d.iv_entry||null,(autoPnl != null ? autoPnl : d.pnl)||null,d.notes||null,d.roll_parent_id||null,d.roll_count||0,d.condor_chain_id||null,d.condor_leg||null,d.condor_seq||null,d.cal_chain_id||null,d.cal_leg||null,d.cal_seq||null,d.contracts_original||null,d.contracts_open||null,d.contracts_closed||null,d.partial_close_pnl||null,d.option_type||null]);
    } catch(insertErr) {
      log('INSERT trades error: ' + insertErr.message);
      return res.status(500).json({ error: 'Insert error: ' + insertErr.message });
    }
    const created = r?.lastInsertRowid ? dbGet('SELECT * FROM trades WHERE id=?', [r.lastInsertRowid]) : null;
    if (!created) return res.status(500).json({ error: 'Insert failed — trade not saved. rowid=' + r?.lastInsertRowid });
    res.json(created);
  });
  app.put('/api/trades/:id', (req, res) => {
    const d = req.body;
    const errs = validateTrade(d, true);
    if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
    const expiry = d.expiration ? (normaliseExpiry(d.expiration) || d.expiration) : null;
    // FIX HIGH: Include all IC and Calendar chain fields in UPDATE so new IC/Cal trades get
    // their chain fields seeded correctly (handleSaveTrade does a second PUT after INSERT).
    dbRun(`UPDATE trades SET ticker=?,lot_id=?,strategy=?,status=?,entry_date=?,exit_date=?,
      expiration=?,expiration_back=?,entry_price=?,exit_price=?,contracts=?,strike_buy=?,strike_sell=?,
      delta=?,gamma=?,theta=?,vega=?,iv_entry=?,pnl=?,notes=?,roll_parent_id=?,roll_count=?,
      condor_chain_id=?,condor_leg=?,condor_seq=?,
      cal_chain_id=?,cal_leg=?,cal_seq=?,
      contracts_original=?,contracts_open=?,contracts_closed=?,partial_close_pnl=?,option_type=?,
      updated_at=datetime('now') WHERE id=?`,
      [d.ticker, d.lot_id||null, d.strategy, d.status||'open',
       d.entry_date||null, d.exit_date||null, expiry, d.expiration_back||null,
       d.entry_price||null, d.exit_price||null, d.contracts||1,
       d.strike_buy||null, d.strike_sell||null,
       d.delta||null, d.gamma||null, d.theta||null, d.vega||null, d.iv_entry||null,
       d.pnl||null, d.notes||null, d.roll_parent_id||null, d.roll_count||0,
       d.condor_chain_id||null, d.condor_leg||null, d.condor_seq||null,
       d.cal_chain_id||null, d.cal_leg||null, d.cal_seq||null,
       d.contracts_original||null, d.contracts_open||null, d.contracts_closed||null,
       d.partial_close_pnl||null, d.option_type||null,
       req.params.id]);
    res.json(dbGet('SELECT * FROM trades WHERE id=?', [req.params.id]));
  });
  app.delete('/api/trades/:id', (req, res) => { dbRun('DELETE FROM trades WHERE id=?', [req.params.id]); res.json({ ok: true }); });

  app.get('/api/stats', (req, res) => {
    const closed = dbAll("SELECT pnl FROM trades WHERE status='closed' AND pnl IS NOT NULL").map(r => r.pnl);
    const open = (dbGet("SELECT COUNT(*) as n FROM trades WHERE status='open'") || {}).n || 0;
    const wins = closed.filter(p => p > 0), losses = closed.filter(p => p < 0);
    // Add partial_close_pnl from still-open IC/Cal chain legs (reduce_position partial closes)
    const partialChainPnl = dbAll("SELECT COALESCE(partial_close_pnl,0) as p FROM trades WHERE status='open' AND (condor_chain_id IS NOT NULL OR cal_chain_id IS NOT NULL)")
      .reduce((s, r) => s + (r.p || 0), 0);
    const totalPnl = closed.reduce((s, p) => s + p, 0) + partialChainPnl;
    const avgWin = wins.length ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
    const avgLoss = losses.length ? losses.reduce((s, p) => s + p, 0) / losses.length : 0;
    res.json({ totalPnl, openTrades: open, closedTrades: closed.length, winRate: closed.length ? wins.length / closed.length * 100 : 0, avgWin, avgLoss, profitFactor: avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : avgWin > 0 ? 999 : 0, bestTrade: closed.length ? Math.max(...closed) : 0, worstTrade: closed.length ? Math.min(...closed) : 0 });
  });

  app.get('/api/import-history/:hash', (req, res) => { const row = dbGet('SELECT * FROM import_history WHERE file_hash=?', [req.params.hash]); row ? res.json(row) : res.status(404).json(null); });
  app.post('/api/import-history', (req, res) => {
    try {
      dbRun('INSERT OR IGNORE INTO import_history (file_hash,file_name,broker,trade_count) VALUES (?,?,?,?)',
        [req.body.file_hash, req.body.file_name, req.body.broker, req.body.trade_count]);
      log(`Import: ${req.body.trade_count} trades from ${req.body.broker} (${req.body.file_name})`);
      if (req.body.lot_linked != null)    log(`Import lot-match: ${req.body.lot_linked} auto-linked, ${req.body.lot_ambiguous || 0} need manual review`);
    } catch {}
    res.json({ ok: true });
  });

  // POST /api/data/clear-all — wipe all trades, lots, and import history from the DB.
  // Requires { confirm: 'DELETE_ALL_MY_DATA' } in the request body as a safety gate.
  app.post('/api/data/clear-all', (req, res) => {
    const { confirm } = req.body || {};
    if (confirm !== 'DELETE_ALL_MY_DATA') {
      return res.status(400).json({ error: 'Safety confirmation required.' });
    }
    try {
      dbRun('DELETE FROM trades');
      dbRun('DELETE FROM purchase_lots');
      dbRun('DELETE FROM import_history');
      saveDb();
      log('All data cleared by user request.');
      res.json({ ok: true, message: 'All trades, lots and import history have been deleted.' });
    } catch (e) {
      log('Clear-all error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });
  // Settings — provider + UI prefs stored plain, API keys encrypted separately
  app.get('/api/settings', (req, res) => {
    const plain = readJSON(settingsFile) || {};
    const creds = readSecure(credsFile) || {};
    // Return merged but never expose the raw key — return a masked version for display
    const apiKeyMasked = creds.apiKey ? creds.apiKey.slice(0, 4) + '****' + creds.apiKey.slice(-4) : '';
    res.json({ provider: 'none', firstLaunchDone: false, ...plain, apiKey: apiKeyMasked, _hasKey: !!creds.apiKey });
  });
  app.post('/api/settings', (req, res) => {
    const { apiKey, schwabClientId, schwabClientSecret, ...plainFields } = req.body;
    // Save non-sensitive fields plainly
    writeJSON(settingsFile, { ...(readJSON(settingsFile) || {}), ...plainFields });
    // Save credentials encrypted — only update if a new key was actually provided (not the masked version)
    if (apiKey && !apiKey.includes('****')) {
      const existingCreds = readSecure(credsFile) || {};
      writeSecure(credsFile, { ...existingCreds, apiKey, schwabClientId, schwabClientSecret });
    } else if (schwabClientId || schwabClientSecret) {
      const existingCreds = readSecure(credsFile) || {};
      writeSecure(credsFile, { ...existingCreds, schwabClientId, schwabClientSecret });
    }
    res.json({ ok: true });
  });

  app.post('/api/live/test', async (req, res) => {
    const { provider, apiKey, schwabClientId, schwabClientSecret } = req.body;
    try {
      if (provider === 'tradier') {
        const data = await httpGet(`https://api.tradier.com/v1/markets/quotes?symbols=AAPL`, { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' });
        return data.quotes?.quote?.symbol ? res.json({ ok: true, message: 'Tradier connected successfully.' }) : res.status(400).json({ error: 'Invalid API key.' });
      }
      if (provider === 'polygon') {
        const data = await httpGet(`https://api.polygon.io/v2/aggs/ticker/AAPL/prev?apiKey=${apiKey}`);
        return data.resultsCount > 0 ? res.json({ ok: true, message: 'Polygon.io connected successfully.' }) : res.status(400).json({ error: 'Invalid API key.' });
      }
      if (provider === 'schwab') {
        const token = await getSchwabAccessToken(schwabClientId, schwabClientSecret);
        if (!token) return res.status(400).json({ error: 'Not authorized. Please complete Schwab OAuth first.' });
        const data = await httpGet('https://api.schwabapi.com/marketdata/v1/quotes?symbols=AAPL&fields=quote', { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' });
        return data.AAPL?.quote ? res.json({ ok: true, message: 'Schwab connected successfully.' }) : res.status(400).json({ error: 'Connected but could not fetch quotes.' });
      }
      res.status(400).json({ error: 'Unknown provider' });
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  app.get('/api/live/market-status', (req, res) => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const mins = et.getHours() * 60 + et.getMinutes();
    res.json({ is_open: et.getDay() >= 1 && et.getDay() <= 5 && mins >= 570 && mins < 960, time_et: et.toTimeString().slice(0, 5) });
  });

  // ── Schwab OAuth routes ──────────────────────────────────
  // Step 1: frontend requests the auth URL to open in browser
  app.post('/api/schwab/auth-url', (req, res) => {
    const { clientId } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });
    // Use activePort so the redirect URI matches whichever port the backend actually bound to.
    // This is critical: Schwab rejects any redirect URI not registered in the developer portal,
    // and the registered URI must include the exact port.
    const redirectUri = `https://127.0.0.1:${activePort}/api/schwab/callback`;
    const url = `https://api.schwabapi.com/v1/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=readonly`;
    res.json({ url, redirectUri });
  });

  // Step 2: Schwab redirects here after user authorizes
  // We exchange the code for tokens, save them, then redirect to app
  app.get('/api/schwab/callback', async (req, res) => {
    const { code, error } = req.query;
    if (error || !code) {
      return res.send('<html><body><h2 style="font-family:sans-serif;color:#c0392b">Authorization failed: ' + (error || 'no code') + '</h2><p>Close this tab and try again.</p></body></html>');
    }

    const settings = readJSON(settingsFile) || {};
    const { schwabClientId: clientId, schwabClientSecret: clientSecret } = settings;
    if (!clientId || !clientSecret) {
      return res.send('<html><body><h2 style="font-family:sans-serif;color:#c0392b">Missing Schwab credentials</h2><p>Please re-enter your Client ID and Secret in the app settings.</p></body></html>');
    }

    const redirectUri = `https://127.0.0.1:${activePort}/api/schwab/callback`;
    const body = new URLSearchParams({
      grant_type:   'authorization_code',
      code,
      redirect_uri: redirectUri,
    }).toString();

    try {
      const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const tokenData = await new Promise((resolve, reject) => {
        const opts = {
          hostname: 'api.schwabapi.com',
          path:     '/v1/oauth/token',
          method:   'POST',
          headers:  {
            'Content-Type':   'application/x-www-form-urlencoded',
            'Authorization':  `Basic ${auth}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 10000,
        };
        const req2 = https.request(opts, (r) => {
          let d = '';
          r.on('data', c => d += c);
          r.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('parse error')); } });
        });
        req2.on('error', reject);
        req2.on('timeout', () => { req2.destroy(); reject(new Error('timeout')); });
        req2.write(body);
        req2.end();
      });

      if (!tokenData.access_token) throw new Error(tokenData.error_description || 'No access token returned');

      saveSchwabTokens({
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token,
        expires_at:    new Date(Date.now() + (tokenData.expires_in || 1800) * 1000).toISOString(),
      });

      log('Schwab: OAuth authorization successful');
      res.send('<html><body style="font-family:sans-serif;text-align:center;padding-top:80px"><h2 style="color:#1a7a4a">✓ Schwab Connected!</h2><p style="color:#6b6860">Authorization successful. You can close this tab — the app is now connected.</p><script>setTimeout(()=>window.close(),3000)</script></body></html>');
    } catch (e) {
      log('Schwab OAuth error: ' + e.message);
      res.send('<html><body><h2 style="font-family:sans-serif;color:#c0392b">Authorization failed</h2><p>' + e.message + '</p></body></html>');
    }
  });

  // Step 3: check if Schwab is connected
  app.get('/api/schwab/status', (req, res) => {
    const tokens = getSchwabTokens();
    if (!tokens?.access_token) return res.json({ connected: false });
    const expiresAt = tokens.expires_at ? new Date(tokens.expires_at).getTime() : 0;
    const expired   = Date.now() > expiresAt && !tokens.refresh_token;
    res.json({ connected: !expired, expires_at: tokens.expires_at });
  });

  // Step 4: disconnect Schwab
  app.post('/api/schwab/disconnect', (req, res) => {
    try { require('fs').unlinkSync(schwabTokenFile); } catch {}
    res.json({ ok: true });
  });

  app.post('/api/live/prices', async (req, res) => {
    const { provider, apiKey, schwabClientId, schwabClientSecret } = req.body;
    const trades = dbAll("SELECT * FROM trades WHERE status='open'");
    if (!trades.length) return res.json({});
    try {
      if (provider === 'tradier')  return res.json(await fetchTradierPrices(trades, apiKey));
      if (provider === 'polygon')  return res.json(await fetchPolygonPrices(trades, apiKey));
      if (provider === 'schwab')   return res.json(await fetchSchwabPrices(trades, schwabClientId, schwabClientSecret));
      res.json({});
    }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ── Option chain endpoint — used by RollModal chain viewer ──────────────
  // Returns array of { strike, bid, ask, mid, iv, delta, theta } for all strikes
  // near the requested expiry. Provider hierarchy: Tradier → Schwab → (caller falls back to Yahoo/MarketData)
  app.post('/api/live/option-chain', async (req, res) => {
    const { ticker, expiration, isCall, provider, apiKey, schwabClientId, schwabClientSecret } = req.body;
    if (!ticker || !expiration) return res.status(400).json({ error: 'ticker and expiration required' });

    try {
      if (provider === 'tradier' && apiKey) {
        // Tradier: /v1/markets/options/chains returns all strikes for an expiry
        const exp = normaliseExpiry(expiration) || expiration; // YYYY-MM-DD
        const callPut = isCall ? 'call' : 'put';
        const data = await httpGet(
          `https://api.tradier.com/v1/markets/options/chains?symbol=${encodeURIComponent(ticker)}&expiration=${exp}&greeks=true`,
          { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
        );
        const options = [].concat(data?.options?.option || [])
          .filter(o => o.option_type === callPut)
          .map(o => ({
            strike:  o.strike,
            bid:     o.bid    ?? 0,
            ask:     o.ask    ?? 0,
            mid:     o.bid != null && o.ask != null ? Math.round((o.bid + o.ask) * 50) / 100 : (o.last ?? 0),
            iv:      o.greeks?.smv_vol   != null ? Math.round(o.greeks.smv_vol * 1000) / 10 : null,
            delta:   o.greeks?.delta     ?? null,
            theta:   o.greeks?.theta     ?? null,
            volume:  o.volume            ?? 0,
            oi:      o.open_interest     ?? 0,
          }))
          .filter(o => o.strike > 0)
          .sort((a, b) => a.strike - b.strike);
        return res.json({ source: 'Tradier', options });
      }

      if (provider === 'schwab' && schwabClientId) {
        // Schwab: /marketdata/v1/chains returns full option chain
        const token = await refreshSchwabToken(schwabClientId, schwabClientSecret);
        if (!token) return res.json({ source: 'schwab', options: [], error: 'Token refresh failed' });
        const callPut = isCall ? 'CALL' : 'PUT';
        const data = await httpGet(
          `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(ticker)}&contractType=${callPut}&fromDate=${expiration}&toDate=${expiration}&includeUnderlyingQuote=false`,
          { 'Authorization': `Bearer ${token}` }
        );
        const map = isCall ? data?.callExpDateMap : data?.putExpDateMap;
        const options = [];
        if (map) {
          Object.values(map).forEach(strikeMap => {
            Object.entries(strikeMap).forEach(([strike, arr]) => {
              const o = arr?.[0];
              if (!o) return;
              options.push({
                strike:  parseFloat(strike),
                bid:     o.bid     ?? 0,
                ask:     o.ask     ?? 0,
                mid:     o.bid != null && o.ask != null ? Math.round((o.bid + o.ask) * 50) / 100 : (o.last ?? 0),
                iv:      o.volatility != null ? Math.round(o.volatility * 1000) / 10 : null,
                delta:   o.delta    ?? null,
                theta:   o.theta    ?? null,
                volume:  o.totalVolume ?? 0,
                oi:      o.openInterest ?? 0,
              });
            });
          });
          options.sort((a, b) => a.strike - b.strike);
        }
        return res.json({ source: 'Schwab', options });
      }

      // Polygon and no-broker: signal caller to use client-side Yahoo/MarketData fetch
      return res.json({ source: 'none', options: [] });
    } catch (e) {
      log(`option-chain error: ${e.message}`);
      res.json({ source: 'error', options: [], error: e.message });
    }
  });



  // ══════════════════════════════════════════════════════
  //  YAHOO FINANCE PROXY ENDPOINTS
  //  Routes Yahoo calls through Node.js backend to avoid:
  //  1. CORS restrictions in Electron renderer
  //  2. Yahoo blocking browser User-Agent / crumb issues
  //  3. Corporate firewall restrictions on direct fetch
  // ══════════════════════════════════════════════════════

  const YAHOO_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': 'https://finance.yahoo.com',
    'Referer': 'https://finance.yahoo.com/',
  };

  // ── Yahoo crumb — required for v7/finance/options since late 2024 ────────────
  // Yahoo returns 401/empty without a valid crumb+cookie pair.
  // We fetch the crumb once on first use, cache it for 55 minutes, then refresh.
  let yahooCrumb      = null;
  let yahooCookie     = null;
  let yahooCrumbExpiry = 0;

  async function getYahooCrumb() {
    const now = Date.now();
    if (yahooCrumb && yahooCookie && now < yahooCrumbExpiry) return { crumb: yahooCrumb, cookie: yahooCookie };

    try {
      // Step 1: hit the consent/options page to get a session cookie
      const cookieRes = await new Promise((resolve, reject) => {
        const req = https.get('https://finance.yahoo.com/quote/AAPL/options', {
          headers: {
            'User-Agent': YAHOO_HEADERS['User-Agent'],
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
          }
        }, resp => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => resolve({ headers: resp.headers, body }));
        });
        req.on('error', reject);
        req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      const setCookie = cookieRes.headers['set-cookie'] || [];
      const cookieStr = setCookie.map(c => c.split(';')[0]).join('; ');
      if (!cookieStr) { log('Yahoo crumb: no cookie received'); return null; }

      // Step 2: fetch crumb using the cookie
      const crumbRes = await new Promise((resolve, reject) => {
        const req = https.get('https://query1.finance.yahoo.com/v1/test/getcrumb', {
          headers: {
            ...YAHOO_HEADERS,
            'Cookie': cookieStr,
          }
        }, resp => {
          let body = '';
          resp.on('data', d => body += d);
          resp.on('end', () => resolve(body.trim()));
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      });

      if (!crumbRes || crumbRes.length < 3 || crumbRes.includes('<')) {
        log('Yahoo crumb: invalid crumb response');
        return null;
      }

      yahooCrumb       = crumbRes;
      yahooCookie      = cookieStr;
      yahooCrumbExpiry = now + 55 * 60 * 1000; // cache 55 min
      // crumb acquired silently
      return { crumb: yahooCrumb, cookie: yahooCookie };
    } catch (e) {
      log(`Yahoo crumb fetch failed: ${e.message}`);
      return null;
    }
  }

  // httpGetWithCrumb — like httpGet but adds crumb+cookie for Yahoo options endpoints
  async function httpGetYahooOptions(url) {
    const auth = await getYahooCrumb();
    const headers = { ...YAHOO_HEADERS };
    if (auth) {
      headers['Cookie'] = auth.cookie;
      // Append crumb to URL
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}crumb=${encodeURIComponent(auth.crumb)}`;
    }
    return httpGet(url, headers);
  }

  // POST /api/yahoo/stock — fetch stock price for a ticker
  // Body: { ticker: 'AAPL' }
  // Returns: { price: 248.50 } or { price: null }
  app.post('/api/yahoo/stock', async (req, res) => {
    const { ticker } = req.body;
    if (!ticker) return res.json({ price: null });
    try {
      // Use crumb+cookie auth — Yahoo now requires auth on more endpoints.
      // httpGetYahooOptions handles crumb acquisition and attaches cookie+crumb to URL.
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}?interval=1d&range=1d`;
      const data = await httpGetYahooOptions(url);
      const meta  = data?.chart?.result?.[0]?.meta;
      // regularMarketPrice is null on weekends (market closed) — fall back to previousClose
      const price = meta?.regularMarketPrice || meta?.previousClose || null;
      if (price && price > 0) return res.json({ price });
    } catch (e) {
      log(`Yahoo stock fetch (crumb) failed for ${ticker}: ${e.message}`);
    }
    // Fallback: plain httpGet without crumb (works in some regions/endpoints)
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.toUpperCase())}?interval=1d&range=1d`;
      const data = await httpGet(url, YAHOO_HEADERS);
      const meta  = data?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice || meta?.previousClose || null;
      res.json({ price: price && price > 0 ? price : null });
    } catch (e) {
      log(`Yahoo stock fetch failed for ${ticker}: ${e.message}`);
      res.json({ price: null });
    }
  });

  // POST /api/yahoo/option — fetch option quote for a single strike/expiry
  // Body: { ticker, strike, expiration, isCall }
  // Returns: { mid, iv, delta, theta } or { mid: null }
  app.post('/api/yahoo/option', async (req, res) => {
    const { ticker, strike, expiration, isCall } = req.body;
    if (!ticker || !strike || !expiration) return res.json({ mid: null });
    try {
      const expUnix = Math.floor(new Date(expiration).getTime() / 1000);
      const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker.toUpperCase())}?date=${expUnix}`;
      const data = await httpGetYahooOptions(url);
      const result = data?.optionChain?.result?.[0];
      if (!result) return res.json({ mid: null });

      // Yahoo may return nearest available expiry — search all option dates for best match
      const allOptions = result.options || [];
      const expiryDates = result.expirationDates || [];
      // Find the option chain closest to requested expiry
      let chain = allOptions[0];
      if (expiryDates.length > 0) {
        const nearest = expiryDates.reduce((prev, cur) =>
          Math.abs(cur - expUnix) < Math.abs(prev - expUnix) ? cur : prev
        );
        const nearestIdx = expiryDates.indexOf(nearest);
        if (nearestIdx >= 0 && allOptions[nearestIdx]) chain = allOptions[nearestIdx];
      }
      if (!chain) return res.json({ mid: null });

      const legs = isCall ? (chain.calls || []) : (chain.puts || []);
      const targetStrike = parseFloat(strike);
      // Use adaptive tolerance: $5 for strikes > $200, $2.50 otherwise
      const tolerance = targetStrike > 200 ? 5 : 2.5;
      const best = legs.reduce((prev, cur) => {
        const dPrev = Math.abs((prev?.strike || Infinity) - targetStrike);
        const dCur  = Math.abs((cur?.strike  || Infinity) - targetStrike);
        return dCur < dPrev ? cur : prev;
      }, null);

      if (!best || Math.abs((best.strike || 0) - targetStrike) > tolerance) return res.json({ mid: null });

      const bid = best.bid || 0;
      const ask = best.ask || 0;
      // Prefer mid from bid/ask; fall back to lastPrice for illiquid options
      const mid = (bid > 0 && ask > 0)
        ? (bid + ask) / 2
        : (best.lastPrice > 0 ? best.lastPrice : 0);
      if (mid <= 0) return res.json({ mid: null });

      res.json({
        mid:   Math.round(mid * 100) / 100,
        // Yahoo v7 does not return delta/theta — only impliedVolatility
        iv:    best.impliedVolatility ? Math.round(best.impliedVolatility * 1000) / 10 : null,
        delta: null,
        theta: null,
      });
    } catch (e) {
      log(`Yahoo option fetch failed for ${ticker}: ${e.message}`);
      res.json({ mid: null });
    }
  });

  // POST /api/yahoo/chain — fetch full option chain for chain viewer
  // Body: { ticker, expiration, isCall }
  // Returns: { source: 'Yahoo', options: [...] }
  app.post('/api/yahoo/chain', async (req, res) => {
    const { ticker, expiration, isCall } = req.body;
    if (!ticker || !expiration) return res.json({ source: 'Yahoo', options: [] });
    try {
      const expUnix = Math.floor(new Date(expiration).getTime() / 1000);
      const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(ticker.toUpperCase())}?date=${expUnix}`;
      const data = await httpGetYahooOptions(url);
      const result = data?.optionChain?.result?.[0];
      if (!result) return res.json({ source: 'Yahoo', options: [] });
      // Find chain closest to requested expiry
      const allOptions = result.options || [];
      const expiryDates = result.expirationDates || [];
      let chain = allOptions[0];
      if (expiryDates.length > 0) {
        const nearest = expiryDates.reduce((prev, cur) =>
          Math.abs(cur - expUnix) < Math.abs(prev - expUnix) ? cur : prev
        );
        const nearestIdx = expiryDates.indexOf(nearest);
        if (nearestIdx >= 0 && allOptions[nearestIdx]) chain = allOptions[nearestIdx];
      }
      if (!chain) return res.json({ source: 'Yahoo', options: [] });

      // Guard: reject chain if Yahoo snapped to wrong expiry (> 7 days off).
      // e.g. requesting May-22 weekly → Yahoo returns May-15 monthly instead.
      // Wrong-expiry prices produce incorrect unrealised P&L (different DTE/theta).
      // Return empty so the caller falls back to BSM with the correct expiry.
      if (chain.expirationDate != null) {
        const chainExpUnix = chain.expirationDate;
        const diffDays = Math.round(Math.abs(chainExpUnix - expUnix) / 86400);
        if (Math.abs(chainExpUnix - expUnix) >= 7 * 86400) {
          return res.json({ source: 'Yahoo', options: [] });
        }
      } else {
      }

      const legs = isCall ? (chain.calls || []) : (chain.puts || []);
      const options = legs.map(o => {
        const bid = o.bid ?? 0;
        const ask = o.ask ?? 0;
        const mid = bid > 0 && ask > 0 ? Math.round((bid + ask) * 50) / 100 : (o.lastPrice ?? 0);
        return {
          strike: o.strike,
          bid:    Math.round(bid * 100) / 100,
          ask:    Math.round(ask * 100) / 100,
          mid:    Math.round(mid * 100) / 100,
          iv:     o.impliedVolatility != null ? Math.round(o.impliedVolatility * 1000) / 10 : null,
          delta:  o.delta  ?? null,
          theta:  o.theta  ?? null,
          volume: o.volume ?? 0,
          oi:     o.openInterest ?? 0,
        };
      }).filter(o => o.strike > 0 && o.mid >= 0)
        .sort((a, b) => a.strike - b.strike);

      res.json({ source: 'Yahoo Finance', options });
    } catch (e) {
      log(`Yahoo chain fetch failed for ${ticker}: ${e.message}`);
      res.json({ source: 'Yahoo', options: [] });
    }
  });

  // ══════════════════════════════════════════════════════
  //  IRON CONDOR CHAIN ENDPOINTS
  //  Parallel to roll chain — does NOT touch roll_parent_id
  // ══════════════════════════════════════════════════════

  // GET /api/trades/ic-chain/:chain_id — all records in chain + computed P&L
  app.get('/api/trades/ic-chain/:chain_id', (req, res) => {
    try {
      const chainId = parseInt(req.params.chain_id);
      const trades  = dbAll('SELECT * FROM trades WHERE condor_chain_id = ? ORDER BY condor_seq ASC, id ASC', [chainId]);
      if (!trades.length) return res.status(404).json({ error: 'Chain not found' });

      let realisedPnL = 0;
      trades.forEach(t => {
        const closed = t.contracts_closed || 0;
        if (closed > 0 && t.exit_price != null) {
          realisedPnL += (t.entry_price - t.exit_price) * closed * 100;
        }
        realisedPnL += t.partial_close_pnl || 0;
      });

      const chainClosed = trades.every(t => (t.contracts_open || 0) === 0);
      const openLegs    = trades.filter(t => (t.contracts_open || 0) > 0).map(t => t.condor_leg);
      const status      = chainClosed ? 'fully_closed'
                        : trades.some(t => t.contracts_closed > 0) ? 'partial'
                        : 'open';

      res.json({ trades, realisedPnL, chainClosed, openLegs, status });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // POST /api/trades/ic-adjust — handles all 6 adjustment types
  app.post('/api/trades/ic-adjust', async (req, res) => {
    const {
      chain_id, adjustment_type, leg,
      contracts_to_close, close_price,
      close_put_price, close_call_price,
      new_strike_buy, new_strike_sell, new_expiry, new_premium,
      new_contracts, date, notes,
    } = req.body;

    if (!chain_id || !adjustment_type) return res.status(400).json({ error: 'chain_id and adjustment_type required' });

    // FIX #6: For roll adjustments that create a new leg, enforce new_expiry >= today
    const ROLL_TYPES = ['roll_one_leg','roll_full','roll_resize'];
    if (ROLL_TYPES.includes(adjustment_type)) {
      if (!new_expiry) return res.status(400).json({ error: 'new_expiry is required for roll adjustments' });
      const today = localDateISO();
      if (new_expiry < today) return res.status(400).json({ error: 'new_expiry must be in the future' });
    }

    try {
      // Load all chain records
      const chainTrades = dbAll('SELECT * FROM trades WHERE condor_chain_id = ? ORDER BY condor_seq ASC, id ASC', [chain_id]);
      if (!chainTrades.length) return res.status(404).json({ error: 'Chain not found' });

      // Helper: find the latest open record for a given leg
      const findOpenLeg = (legName) => {
        const candidates = chainTrades.filter(t =>
          (t.condor_leg === legName || t.condor_leg === 'full') &&
          (t.contracts_open || 0) > 0
        );
        return candidates.sort((a, b) => b.condor_seq - a.condor_seq)[0] || null;
      };

      const maxSeq = Math.max(...chainTrades.map(t => t.condor_seq || 0));

      // Helper: close N contracts on a leg record
      const closeLegContracts = (trade, numClose, exitPx, exitDt) => {
        const avail = trade.contracts_open || 0;
        // Guard: leg already fully closed — skip UPDATE entirely (double-POST protection).
        if (avail <= 0) return { isFullClose: false, legPnl: 0 };
        // Clamp numClose to what is actually available.
        const realClose = Math.min(numClose || avail, avail);
        const newOpen   = avail - realClose;
        // Cap contracts_closed at contracts_original — cannot exceed original size.
        const maxClosed = trade.contracts_original || trade.contracts || realClose;
        const newClosed = Math.min((trade.contracts_closed || 0) + realClose, maxClosed);
        const isFullClose = newOpen <= 0;
        const legPnl = (trade.entry_price - exitPx) * realClose * 100;

        if (isFullClose) {
          // Absorb any prior partial_close_pnl into final pnl, reset partial to 0
          const totalPnl = legPnl + (trade.partial_close_pnl || 0);
          db.run(
            `UPDATE trades SET contracts_open=0, contracts_closed=?, exit_price=?, exit_date=?,
             status='closed', pnl=?, partial_close_pnl=0, updated_at=datetime('now') WHERE id=?`,
            [newClosed, exitPx, exitDt, totalPnl, trade.id]
          );
        } else {
          // Partial close — accumulate in partial_close_pnl
          db.run(
            `UPDATE trades SET contracts_open=?, contracts_closed=?,
             partial_close_pnl=COALESCE(partial_close_pnl,0)+?, updated_at=datetime('now') WHERE id=?`,
            [newOpen, newClosed, legPnl, trade.id]
          );
        }
        return { isFullClose, legPnl };
      };

      // Helper: insert a new chain leg record
      const insertNewLeg = (sourceTrade, legName, seq, entryPx, contracts, strikeB, strikeS, expiry, notesTxt) => {
        const r = dbRun(
          `INSERT INTO trades (ticker, lot_id, strategy, status, entry_date, expiration,
           entry_price, contracts, strike_buy, strike_sell, pnl, notes,
           condor_chain_id, condor_leg, condor_seq, contracts_original, contracts_open, contracts_closed, partial_close_pnl,
           roll_parent_id, roll_count, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,NULL,0,datetime('now'),datetime('now'))`,
          [
            sourceTrade.ticker, sourceTrade.lot_id || null,
            sourceTrade.strategy || 'Iron Condor', 'open',
            date || localDateISO(),
            expiry || null,
            entryPx, contracts,
            strikeB || null, strikeS || null,
            null, notesTxt || '',
            chain_id, legName, seq,
            sourceTrade.contracts_original ?? sourceTrade.contracts ?? contracts, contracts,
          ]
        );
        return r.lastInsertRowid;
      };

      // ── Execute adjustment type ────────────────────────
      const adj = adjustment_type;
      const numClose = parseInt(contracts_to_close) || 0;
      const closePx  = parseFloat(close_price) || 0;
      const newConts = parseInt(new_contracts) || numClose;
      const adjustDate = date || localDateISO();

      if (adj === 'roll_one_leg') {
        // Close one leg, reopen at new strikes/expiry
        const legRec = findOpenLeg(leg);
        if (!legRec) return res.status(400).json({ error: `No open ${leg} leg found` });
        closeLegContracts(legRec, legRec.contracts_open, closePx, adjustDate);
        // IB: sell strike must always be the ATM body — fall back to source leg's strike_sell if not sent.
        const resolvedSellOL = new_strike_sell || (legRec.strategy === 'Iron Butterfly' ? legRec.strike_sell : null);
        insertNewLeg(legRec, leg, maxSeq + 1, parseFloat(new_premium) || 0, legRec.contracts_original, new_strike_buy, resolvedSellOL, new_expiry, notes || `Rolled ${leg} leg from ${legRec.expiration}`);

      } else if (adj === 'roll_full') {
        // Close all 4 legs with per-leg buy-back prices, reopen both wings.
        // Uses 4-strike fields: roll_full_put_sell/buy (put wing) + roll_full_call_sell/buy (call wing)
        const putLeg   = findOpenLeg('put')  || findOpenLeg('full');
        const callLeg  = findOpenLeg('call') || (putLeg?.condor_leg === 'full' ? null : findOpenLeg('full'));
        const putPx    = parseFloat(close_put_price)  || closePx;
        const callPx   = parseFloat(close_call_price) || closePx;
        if (putLeg)  closeLegContracts(putLeg,  putLeg.contracts_open,  putPx,  adjustDate);
        if (callLeg && callLeg.id !== putLeg?.id) closeLegContracts(callLeg, callLeg.contracts_open, callPx, adjustDate);
        const rollConts = putLeg?.contracts_original || 1;
        const rfPutSell  = req.body.roll_full_put_sell  || null;
        const rfPutBuy   = req.body.roll_full_put_buy   || null;
        const rfPutCred  = parseFloat(req.body.roll_full_put_credit)  || 0;
        const rfCallSell = req.body.roll_full_call_sell || null;
        const rfCallBuy  = req.body.roll_full_call_buy  || null;
        const rfCallCred = parseFloat(req.body.roll_full_call_credit) || 0;
        insertNewLeg(putLeg || chainTrades[0],  'put',  maxSeq + 1, rfPutCred  || parseFloat(new_premium) || 0, rollConts, rfPutBuy,  rfPutSell,  new_expiry, notes || 'Rolled condor — put wing');
        insertNewLeg(putLeg || chainTrades[0],  'call', maxSeq + 2, rfCallCred || parseFloat(new_premium) || 0, rollConts, rfCallBuy, rfCallSell, new_expiry, notes || 'Rolled condor — call wing');

      } else if (adj === 'reduce_one') {
        // Close N contracts on ONE leg (partial or full)
        const legRec = findOpenLeg(leg);
        if (!legRec) return res.status(400).json({ error: `No open ${leg} leg found` });
        closeLegContracts(legRec, Math.min(numClose, legRec.contracts_open), closePx, adjustDate);

      } else if (adj === 'reduce_both' || adj === 'reduce_position') {
        // reduce_both (legacy) / reduce_position (new): per-leg prices + independent contract counts
        const putLeg  = findOpenLeg('put')  || findOpenLeg('full');
        const callLeg = findOpenLeg('call');
        const putPx   = parseFloat(close_put_price)  || closePx;
        const callPx  = parseFloat(close_call_price) || closePx;
        const putN    = adj === 'reduce_position' ? (parseInt(req.body.put_contracts_to_close)  || numClose) : numClose;
        const callN   = adj === 'reduce_position' ? (parseInt(req.body.call_contracts_to_close) || numClose) : numClose;
        if (putLeg  && putN  > 0) closeLegContracts(putLeg,  Math.min(putN,  putLeg.contracts_open),  putPx,  adjustDate);
        if (callLeg && callN > 0) closeLegContracts(callLeg, Math.min(callN, callLeg.contracts_open), callPx, adjustDate);

      } else if (adj === 'roll_resize') {
        // Close tested side fully, reopen with fewer contracts
        const legRec = findOpenLeg(leg);
        if (!legRec) return res.status(400).json({ error: `No open ${leg} leg found` });
        closeLegContracts(legRec, legRec.contracts_open, closePx, adjustDate);
        // IB: sell strike must always be the ATM body — fall back to source leg's strike_sell if not sent.
        const resolvedSellRR = new_strike_sell || (legRec.strategy === 'Iron Butterfly' ? legRec.strike_sell : null);
        insertNewLeg(legRec, leg, maxSeq + 1, parseFloat(new_premium) || 0, newConts, new_strike_buy, resolvedSellRR, new_expiry, notes || `Rolled & resized ${leg} leg`);

      } else if (adj === 'close_one') {
        // Close one leg entirely, chain stays alive
        const legRec = findOpenLeg(leg);
        if (!legRec) return res.status(400).json({ error: `No open ${leg} leg found` });
        closeLegContracts(legRec, legRec.contracts_open, closePx, adjustDate);

      } else if (adj === 'take_profit' || adj === 'close_position') {
        // take_profit (legacy) / close_position (new): close all open legs with per-leg prices
        const putLeg  = findOpenLeg('put')  || findOpenLeg('full');
        const callLeg = findOpenLeg('call') || (putLeg?.condor_leg === 'full' ? null : findOpenLeg('full'));
        const putPx   = parseFloat(close_put_price)  || closePx;
        const callPx  = parseFloat(close_call_price) || closePx;
        if (putLeg)  closeLegContracts(putLeg,  putLeg.contracts_open,  putPx,  adjustDate);
        if (callLeg && callLeg.id !== putLeg?.id) closeLegContracts(callLeg, callLeg.contracts_open, callPx, adjustDate);

      } else {
        return res.status(400).json({ error: 'Unknown adjustment_type: ' + adj });
      }

      saveDb();

      // Return updated chain
      const updatedTrades = dbAll('SELECT * FROM trades WHERE condor_chain_id = ? ORDER BY condor_seq ASC, id ASC', [chain_id]);
      let realisedPnL = 0;
      updatedTrades.forEach(t => {
        if ((t.contracts_closed || 0) > 0 && t.exit_price != null) {
          realisedPnL += (t.entry_price - t.exit_price) * t.contracts_closed * 100;
        }
        realisedPnL += t.partial_close_pnl || 0;
      });
      const chainClosed = updatedTrades.every(t => (t.contracts_open || 0) === 0);
      const openLegs    = updatedTrades.filter(t => (t.contracts_open || 0) > 0).map(t => t.condor_leg);
      const status      = chainClosed ? 'fully_closed'
                        : updatedTrades.some(t => (t.contracts_closed || 0) > 0) ? 'partial'
                        : 'open';

      log(`IC adjust [${adj}] chain ${chain_id} — status: ${status}`);
      res.json({ ok: true, trades: updatedTrades, realisedPnL, chainClosed, openLegs, status });

    } catch (e) {
      log('IC adjust error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/trades/cal-adjust — Calendar Spread adjustment handler
  // Adjustment types: roll_short_leg, close_one_leg, close_both, take_profit, convert_diagonal, convert_to_calendar
  app.post('/api/trades/cal-adjust', async (req, res) => {
    const {
      chain_id, adjustment_type,
      close_short_price, close_long_price,
      new_short_strike, new_short_expiry, new_short_premium,
      new_long_strike,  new_long_expiry,  new_long_premium,
      reduce_short_contracts, reduce_long_contracts,
      reduce_short_price, reduce_long_price,
      date, notes,
    } = req.body;

    if (!chain_id || !adjustment_type) return res.status(400).json({ error: 'chain_id and adjustment_type required' });

    try {
      const chainTrades = dbAll('SELECT * FROM trades WHERE cal_chain_id = ? ORDER BY cal_seq ASC, id ASC', [chain_id]);
      if (!chainTrades.length) return res.status(404).json({ error: 'Calendar chain not found' });

      const maxSeq   = Math.max(...chainTrades.map(t => t.cal_seq || 0));
      const adjDate  = date || localDateISO();
      const adj      = adjustment_type;

      // Find latest open leg by type
      const findLeg = (legType) => chainTrades
        .filter(t => t.cal_leg === legType && (t.contracts_open || t.contracts || 0) > 0)
        .sort((a, b) => (b.cal_seq || 0) - (a.cal_seq || 0))[0] || null;

      // Close a leg — full or partial
      const closeLeg = (trade, exitPx, nClose) => {
        const avail = trade.contracts_open ?? trade.contracts ?? 1;
        // Guard: leg already fully closed — double-POST protection.
        if (avail <= 0) return 0;
        const realN = nClose != null ? Math.min(nClose, avail) : avail;
        const newOpen = avail - realN;
        const isFullClose = newOpen <= 0;
        const pnl = Math.round((trade.cal_leg === 'short'
          ? (trade.entry_price - exitPx) * realN * 100
          : (exitPx - trade.entry_price) * realN * 100) * 100) / 100;
        // Cap contracts_closed at contracts_original.
        const maxClosed = trade.contracts_original || trade.contracts || realN;
        const newClosed = Math.min((trade.contracts_closed||0) + realN, maxClosed);
        if (isFullClose) {
          // Absorb prior partial_close_pnl into final pnl, reset to 0
          const totalPnl = pnl + (trade.partial_close_pnl || 0);
          db.run(
            `UPDATE trades SET status='closed', exit_price=?, exit_date=?, pnl=?,
             contracts_open=0, contracts_closed=?, partial_close_pnl=0, updated_at=datetime('now') WHERE id=?`,
            [exitPx, adjDate, totalPnl, newClosed, trade.id]
          );
        } else {
          // Partial close — accumulate in partial_close_pnl
          db.run(
            `UPDATE trades SET contracts_open=?, contracts_closed=?,
             partial_close_pnl=COALESCE(partial_close_pnl,0)+?, updated_at=datetime('now') WHERE id=?`,
            [newOpen, newClosed, pnl, trade.id]
          );
        }
        return pnl;
      };

      // Insert a new leg into the chain
      const insertLeg = (src, legType, seq, strike, expiry, expiryBack, premium, legNotes) => {
        const r = dbRun(
          `INSERT INTO trades (ticker, lot_id, strategy, status, entry_date, expiration, expiration_back,
           entry_price, contracts, strike_buy, strike_sell, pnl, notes,
           cal_chain_id, cal_leg, cal_seq, contracts_original, contracts_open, contracts_closed, partial_close_pnl,
           roll_parent_id, roll_count, option_type, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,NULL,0,?,datetime('now'),datetime('now'))`,
          [
            src.ticker, null, src.strategy || 'Calendar Spread', 'open',
            adjDate, expiry, expiryBack || null,
            premium, src.contracts_open ?? src.contracts ?? 1,
            legType === 'long'  ? strike : null,   // long = buy = strike_buy
            legType === 'short' ? strike : null,   // short = sell = strike_sell
            null, legNotes || '',
            chain_id, legType, seq,
            src.contracts_original ?? src.contracts ?? 1, src.contracts_open ?? src.contracts ?? 1,
            src.option_type || null,   // carry option_type from source leg to all rolled legs
          ]
        );
        return r.lastInsertRowid;
      };

      if (adj === 'roll_short_leg') {
        const shortLeg = findLeg('short');
        if (!shortLeg) return res.status(400).json({ error: 'No open short leg found' });
        closeLeg(shortLeg, parseFloat(close_short_price) || 0);
        insertLeg(shortLeg, 'short', maxSeq + 1,
          parseFloat(new_short_strike) || shortLeg.strike_sell,
          new_short_expiry || shortLeg.expiration,
          null,
          parseFloat(new_short_premium) || 0,
          notes || `Rolled short: ${shortLeg.expiration} → ${new_short_expiry || shortLeg.expiration}`);

      } else if (adj === 'convert_to_calendar') {
        const moveLeg = req.body.move_leg || 'short';
        if (moveLeg === 'short') {
          const shortLeg = findLeg('short');
          if (!shortLeg) return res.status(400).json({ error: 'No open short leg found' });
          const longLeg = findLeg('long');
          closeLeg(shortLeg, parseFloat(close_short_price) || 0);
          insertLeg(shortLeg, 'short', maxSeq + 1,
            parseFloat(longLeg?.strike_buy) || shortLeg.strike_sell,
            new_short_expiry || shortLeg.expiration,
            null,
            parseFloat(new_short_premium) || 0,
            notes || `Converted to calendar (move short) → ${longLeg?.strike_buy}`);
        } else {
          const longLeg = findLeg('long');
          if (!longLeg) return res.status(400).json({ error: 'No open long leg found' });
          const shortLeg = findLeg('short');
          closeLeg(longLeg, parseFloat(close_long_price) || 0);
          insertLeg(longLeg, 'long', maxSeq + 1,
            parseFloat(shortLeg?.strike_sell) || longLeg.strike_buy,
            new_long_expiry || longLeg.expiration,
            new_long_expiry,
            parseFloat(new_long_premium) || 0,
            notes || `Converted to calendar (move long) → ${shortLeg?.strike_sell}`);
        }

      } else if (adj === 'roll_long_out') {
        // Roll long leg out in time — same strike, later expiry. Extends the back month anchor.
        const longLeg = findLeg('long');
        if (!longLeg) return res.status(400).json({ error: 'No open long leg found' });
        closeLeg(longLeg, parseFloat(close_long_price) || 0);
        insertLeg(longLeg, 'long', maxSeq + 1,
          longLeg.strike_buy || longLeg.strike_sell,    // same strike — locked
          new_long_expiry || longLeg.expiration,
          new_long_expiry,
          parseFloat(new_long_premium) || 0,
          notes || `Rolled long out: ${longLeg.expiration} → ${new_long_expiry}`);

      } else if (adj === 'convert_diagonal') {
        // Roll both strike and expiry on the long leg — transforms calendar to diagonal.
        // Used when trader wants directional bias or to manage IV differential.
        const longLeg = findLeg('long');
        if (!longLeg) return res.status(400).json({ error: 'No open long leg found' });
        closeLeg(longLeg, parseFloat(close_long_price) || 0);
        insertLeg(longLeg, 'long', maxSeq + 1,
          parseFloat(new_long_strike) || longLeg.strike_buy,
          new_long_expiry || longLeg.expiration_back || longLeg.expiration,
          new_long_expiry,
          parseFloat(new_long_premium) || 0,
          notes || `Converted to diagonal — long leg rolled to ${new_long_strike}/${new_long_expiry}`);

      } else if (adj === 'close_both') {
        // Close entire position — both short and long legs simultaneously.
        const shortLeg = findLeg('short');
        const longLeg  = findLeg('long');
        if (shortLeg) closeLeg(shortLeg, parseFloat(close_short_price) || 0);
        if (longLeg)  closeLeg(longLeg,  parseFloat(close_long_price)  || 0);

      } else if (adj === 'close_one_leg') {
        const closeSide = req.body.close_side || 'short';
        if (closeSide === 'short') {
          const shortLeg = findLeg('short');
          if (!shortLeg) return res.status(400).json({ error: 'No open short leg found on this chain.' });
          closeLeg(shortLeg, parseFloat(close_short_price) || 0);
        } else {
          const longLeg = findLeg('long');
          if (!longLeg) return res.status(400).json({ error: 'No open long leg found on this chain.' });
          closeLeg(longLeg, parseFloat(close_long_price) || 0);
        }

      } else if (adj === 'take_profit') {
        // Same as close_both but with explicit profit-target framing in notes.
        const shortLeg = findLeg('short');
        const longLeg  = findLeg('long');
        if (shortLeg) closeLeg(shortLeg, parseFloat(close_short_price) || 0);
        if (longLeg)  closeLeg(longLeg,  parseFloat(close_long_price)  || 0);

      } else if (adj === 'reduce_position') {
        // Partial close — close N contracts on each leg, leave remainder open.
        const shortLeg = findLeg('short');
        const longLeg  = findLeg('long');
        const sn = parseInt(reduce_short_contracts) || 0;
        const ln = parseInt(reduce_long_contracts)  || 0;
        const sp = parseFloat(reduce_short_price)   || 0;
        const lp = parseFloat(reduce_long_price)    || 0;
        if (shortLeg && sn > 0) closeLeg(shortLeg, sp, sn);
        if (longLeg  && ln > 0) closeLeg(longLeg,  lp, ln);

      } else {
        return res.status(400).json({ error: 'Unknown adjustment_type: ' + adj });
      }

      saveDb();

      // Return updated chain with P&L summary
      const updatedTrades = dbAll('SELECT * FROM trades WHERE cal_chain_id = ? ORDER BY cal_seq ASC, id ASC', [chain_id]);
      let realisedPnL = 0;
      updatedTrades.forEach(t => {
        if (t.pnl != null) realisedPnL += t.pnl;
        realisedPnL += t.partial_close_pnl || 0;
      });
      const chainClosed = updatedTrades.every(t => (t.contracts_open || 0) === 0 && t.status === 'closed');
      log(`Cal adjust [${adj}] chain ${chain_id} — P&L: ${realisedPnL}`);
      res.json({ ok: true, trades: updatedTrades, realisedPnL, chainClosed });

    } catch (e) {
      log('Cal adjust error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  if (IS_ELECTRON) {
    // Resolve the React build directory for all three scenarios:
    //   S2 (ELECTRON-DEV, not packaged): OTT_RESOURCES = trade-tracker/ → build/
    //   S3 (shipped .exe, packaged):     OTT_RESOURCES = resources/     → app/
    // process.resourcesPath is NOT reliable in dev (points to Electron binary resources)
    const migRes = process.env.OTT_RESOURCES || path.join(__dirname, '..');
    const IS_PACKAGED_ENV = !!process.env.OTT_RESOURCES && process.env.OTT_RESOURCES.includes('resources');
    const buildDir = path.join(migRes, IS_PACKAGED_ENV ? 'app' : 'build');
    if (fs.existsSync(buildDir)) {
      app.use(express.static(buildDir));
      app.get('*', (req, res) => { if (!req.path.startsWith('/api') && !req.path.startsWith('/health')) res.sendFile(path.join(buildDir, 'index.html')); });
      log('Serving static build from: ' + buildDir);
    } else {
      log('WARNING: React build dir not found: ' + buildDir);
    }
  }

  // ── Dynamic port selection ────────────────────────────────
  // Try PORT (3002) first, then 3003..3010 until a free port is found.
  // Announce the chosen port on stdout so Electron can read it.
  function tryListen(port, remaining) {
    const server = app.listen(port, HOST, () => {
      activePort = port;  // record the actual port we bound to
      log(`Backend listening on http://${HOST}:${port}`);
      // Signal chosen port to Electron main process via stdout
      process.stdout.write(`BACKEND_PORT=${port}\n`);
      setInterval(saveDb, 30000);
      process.on('SIGTERM', () => { saveDb(); server.close(); });
    });
    server.on('error', e => {
      if ((e.code === 'EADDRINUSE' || e.code === 'EACCES') && remaining.length > 0) {
        log(`Port ${port} in use, trying ${remaining[0]}...`);
        tryListen(remaining[0], remaining.slice(1));
      } else {
        log('Server error: ' + e.message);
        process.exit(1);
      }
    });
  }
  const FALLBACK_PORTS = [3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];
  tryListen(PORT, FALLBACK_PORTS);

  // ══════════════════════════════════════════════════════
  //  BACKUP ROUTES
  // ══════════════════════════════════════════════════════

  // GET /api/backup/status — returns last backup date + reminder setting
  app.get('/api/backup/status', (req, res) => {
    const settings = readJSON(settingsFile) || {};
    res.json({
      lastBackup:     settings.lastBackup     || null,
      backupReminder: settings.backupReminder !== false, // default true
      lastBackupSize: settings.lastBackupSize || null,
    });
  });

  // POST /api/backup/settings — save reminder preference
  app.post('/api/backup/settings', (req, res) => {
    const current = readJSON(settingsFile) || {};
    writeJSON(settingsFile, { ...current, backupReminder: req.body.backupReminder });
    res.json({ ok: true });
  });

  // POST /api/backup/record — record that a backup was just taken
  app.post('/api/backup/record', (req, res) => {
    const current = readJSON(settingsFile) || {};
    writeJSON(settingsFile, {
      ...current,
      lastBackup:     new Date().toISOString(),
      lastBackupSize: req.body.size || null,
    });
    res.json({ ok: true });
  });

  // GET /api/export/csv — export all trades as CSV
  app.get('/api/export/csv', (req, res) => {
    try {
      const trades = dbAll('SELECT * FROM trades ORDER BY ticker, entry_date DESC');
      const headers = [
        'ID','Ticker','Strategy','Status',
        'Entry Date','Expiration','Exit Date',
        'Strike Sell','Strike Buy','Entry Price','Exit Price',
        'Contracts','P&L',
        'Delta','Gamma','Theta','Vega','IV %',
        'Roll Count','Roll Parent ID','Lot ID',
        'Notes',
      ];
      const rows = trades.map(t => [
        t.id, t.ticker, t.strategy, t.status,
        t.entry_date||'', t.expiration||'', t.exit_date||'',
        t.strike_sell??'', t.strike_buy??'',
        t.entry_price??'', t.exit_price??'',
        t.contracts, t.pnl??'',
        t.delta??'', t.gamma??'', t.theta??'', t.vega??'', t.iv_entry??'',
        t.roll_count??0, t.roll_parent_id??'', t.lot_id??'',
        (t.notes||'').replace(/"/g,'""'),
      ]);
      const csv = [headers, ...rows]
        .map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))
        .join('\n');
      const filename = `myoptiondiary-export-${localDateISO()}.csv`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      log(`CSV export: ${trades.length} trades`);
      res.send(csv);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });


// ── Dynamic sample CSV generator ─────────────────────────────────────────────
// All 5 broker sample files generated dynamically with:
//   1. Dates relative to today (open positions always have future expiry)
//   2. Strikes and premiums derived from actual Yahoo Finance historical prices
//      so the numbers are realistic regardless of when the app is run.
//   3. Fallback to hardcoded reasonable prices if Yahoo is unavailable.

// ── Historical price cache (module-level, refreshed each server start) ────────
let samplePriceCache = null;    // { AAPL: { '-95': 218.50, '-60': 222.10, ... }, ... }
let samplePriceFetching = null; // Promise — prevents parallel fetches

async function fetchHistoricalClose(ticker, unixTimestamp) {
  // Fetch daily bar containing the given timestamp from Yahoo Finance v8 chart API
  const period1 = unixTimestamp - 86400 * 3; // 3 days before to handle weekends/holidays
  const period2 = unixTimestamp + 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&period1=${period1}&period2=${period2}`;
  try {
    const data = await new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
        },
        timeout: 8000,
      }, resp => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { reject(new Error('JSON parse error')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
    const result = data?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    // Return the last valid close in the window
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null && closes[i] > 0) return Math.round(closes[i] * 100) / 100;
    }
    return null;
  } catch { return null; }
}

async function buildSamplePriceCache() {
  const today = new Date();
  function unixAt(offsetDays) {
    const d = new Date(today);
    d.setDate(d.getDate() + offsetDays);
    return Math.floor(d.getTime() / 1000);
  }

  // Tickers and the date offsets we need prices for
  const needs = {
    AAPL: [-95, -60, -35, -8],
    NVDA: [-65, -20],
    MSFT: [-38],
    TSLA: [-68, -60, -35],
    META: [-29],
    AMZN: [-14],
    SPY:  [-20],
  };

  // Fallback prices if Yahoo is unavailable — reasonable early-2026 estimates
  const FALLBACK = {
    AAPL: 220, NVDA: 175, MSFT: 395,
    TSLA: 372, META: 580, AMZN: 205, SPY: 653,
  };

  const cache = {};
  const fetches = [];

  for (const [ticker, offsets] of Object.entries(needs)) {
    cache[ticker] = {};
    for (const offset of offsets) {
      fetches.push(
        fetchHistoricalClose(ticker, unixAt(offset)).then(price => {
          cache[ticker][offset] = price ?? FALLBACK[ticker];
        }).catch(() => {
          cache[ticker][offset] = FALLBACK[ticker];
        })
      );
    }
  }

  // Run all fetches in parallel with a 10s overall timeout
  try {
    await Promise.race([
      Promise.all(fetches),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000)),
    ]);
  } catch {
    // Fill any missing entries with fallbacks
    for (const [ticker, offsets] of Object.entries(needs)) {
      for (const offset of offsets) {
        if (cache[ticker][offset] == null) cache[ticker][offset] = FALLBACK[ticker];
      }
    }
  }

  return cache;
}

async function getSamplePrices() {
  if (samplePriceCache) return samplePriceCache;
  if (samplePriceFetching) return samplePriceFetching;
  samplePriceFetching = buildSamplePriceCache().then(c => {
    samplePriceCache = c;
    samplePriceFetching = null;
    return c;
  });
  return samplePriceFetching;
}

// Warm the cache on startup (non-blocking)
setTimeout(() => getSamplePrices().catch(() => {}), 3000);

// ── Strike / premium calculators ──────────────────────────────────────────────
// Snap to nearest realistic options increment based on stock price level
// < $50: $0.50  |  $50–$100: $1  |  $100–$200: $2.50  |  $200+: $5
function snapInc(price) { return price < 50 ? 0.5 : price < 100 ? 1 : price < 200 ? 2.5 : 5; }
function snapK(raw, spotPrice) { const i = snapInc(spotPrice); return Math.round(Math.round(raw/i)*i*100)/100; }
function cspStrike(price)    { return snapK(price * 0.93, price); }  // ~7% OTM put
function ccStrike(price)     { return snapK(price * 1.05, price); }  // ~5% OTM call
function longCallStrike(p)   { return snapK(p * 1.05,    p); }      // ~5% OTM call
function longPutStrike(p)    { return snapK(p * 0.95,    p); }      // ~5% OTM put
function spyCspStrike(p)     { return snapK(p * 0.91,    p); }      // ~9% OTM put (index)

// Premium: simplified vol-based estimate (credit strategies)
// Formula: price × annualVol × sqrt(DTE/365) × 0.4 (rough ATM delta adjustment)
function creditPremium(price, dte, volPct, contracts) {
  const raw = price * volPct * Math.sqrt(dte / 365) * 0.4;
  const rounded = Math.round(raw * 20) / 20; // round to nearest $0.05
  return Math.max(0.50, rounded);
}
function debitPremium(price, dte, volPct) {
  const raw = price * volPct * Math.sqrt(dte / 365) * 0.35;
  return Math.max(0.50, Math.round(raw * 20) / 20);
}

// Vol assumptions per ticker (historical rough estimates)
const VOL = { AAPL: 0.28, NVDA: 0.55, MSFT: 0.28, TSLA: 0.70, META: 0.38, AMZN: 0.38, SPY: 0.18 };

function generateSampleCSV(broker, prices) {
  const today = new Date();

  // ── Friday-snapping helpers (mirrors tradingCalendar.js) ─────────────────
  function toISO(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function easterSunday(year) {
    const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4;
    const f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30;
    const i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
    return { month:Math.floor((h+l-7*m+114)/31), day:((h+l-7*m+114)%31)+1 };
  }
  const _hc={};
  function fridayHolidays(year) {
    if (_hc[year]) return _hc[year];
    const s=new Set(), {month:em,day:ed}=easterSunday(year);
    const gf=new Date(year,em-1,ed); gf.setDate(gf.getDate()-2); s.add(toISO(gf));
    for (const [mo,da] of [[1,1],[7,4],[12,25]]) {
      const hd=new Date(year,mo-1,da);
      if (hd.getDay()===6){hd.setDate(hd.getDate()-1);s.add(toISO(hd));}
    }
    return (_hc[year]=s);
  }
  function isHol(iso){return fridayHolidays(parseInt(iso.slice(0,4),10)).has(iso);}
  // Snap forward to next valid expiry Friday
  function nextFri(baseDate){
    const d=new Date(baseDate.getFullYear(),baseDate.getMonth(),baseDate.getDate());
    while(d.getDay()!==5)d.setDate(d.getDate()+1);
    // If this Friday is a market holiday, advance 7 days to the next Friday
    if(isHol(toISO(d)))d.setDate(d.getDate()+7);
    return d;
  }
  // Snap backward to most recent valid expiry Friday
  function prevFri(baseDate){
    const d=new Date(baseDate.getFullYear(),baseDate.getMonth(),baseDate.getDate());
    while(d.getDay()!==5)d.setDate(d.getDate()-1);
    // If this Friday is a market holiday, go back 7 days to the previous Friday
    if(isHol(toISO(d)))d.setDate(d.getDate()-7);
    return d;
  }
  // Entry/trade dates: plain offset, no snap needed (entries happen any weekday)
  function eDate(offsetDays){
    return new Date(today.getFullYear(),today.getMonth(),today.getDate()+offsetDays);
  }
  // Past expiry: snap to most recent Friday on or before the offset date
  function xPast(daysAgo){return prevFri(eDate(-daysAgo));}
  // Future expiry: snap to next Friday at least daysOut from today
  function xFuture(daysOut){return nextFri(eDate(daysOut));}

  // Format a Date object in various broker formats
  function dt(dateObj, style) {
    const d = dateObj;
    const yr4=d.getFullYear(), yr2=String(yr4).slice(2);
    const mm=String(d.getMonth()+1).padStart(2,'0'), dd=String(d.getDate()).padStart(2,'0');
    const m=d.getMonth()+1, day=d.getDate();
    const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
    if (!style||style==='YYYY-MM-DD') return `${yr4}-${mm}-${dd}`;
    if (style==='MM/DD/YYYY') return `${mm}/${dd}/${yr4}`;
    if (style==='M/D/YY')     return `${m}/${day}/${yr2}`;
    if (style==='M/D/YYYY')   return `${m}/${day}/${yr4}`;
    if (style==='YYYYMMDD')   return `${yr4}${mm}${dd}`;
    if (style==='MON')        return `${MON} ${String(day).padStart(2,'0')} ${yr4}`;
    if (style==='IBKR')       return `${yr4}-${mm}-${dd};09:30:00`;
    return `${yr4}-${mm}-${dd}`;
  }

  // ── Compute all dates ─────────────────────────────────────────────────────
  // Entry/assignment/exit: plain offset (any day OK for entry/exit)
  // Expiry: snapped to valid Friday via xPast/xFuture
  const D = {
    // Entry/trade dates (any weekday)
    aCSPe: eDate(-95),  aCC1e: eDate(-60),  aCC1b: eDate(-39),
    aCC2e: eDate(-35),  aCC2x: xPast(10),
    nCSPe: eDate(-65),
    mCSPe: eDate(-38),  mCSPb: eDate(-29),
    tBuy:  eDate(-68),  tCC1e: eDate(-60),  tCC2e: eDate(-35),  tCC2x: xPast(10),
    metaE: eDate(-29),  metaX: xPast(14),
    amznE: eDate(-14),
    n2Buy: eDate(-25),  n2CCe: eDate(-20),
    spyCe: eDate(-20),
    a2Ce:  eDate(-8),
    // Expiry dates — snapped to valid Fridays
    aCSPx: xPast(65),   aCC1x: xPast(39),   aCC2x: xPast(10),
    nCSPx: xPast(38),
    mCSPx: xPast(29),
    tCC1x: xPast(38),   tCC2x: xPast(10),
    metaX: xPast(14),
    amznX: xPast(7),
    n2CCx: xFuture(37),
    spyCx: xFuture(72),
    a2Cx:  xFuture(72),
  };

  // ── Prices from cache ─────────────────────────────────────────────────────
  const P = prices || {};
  const aCSPprice = P.AAPL?.[D.aCSPe] || 220;
  const aCC1price = P.AAPL?.[D.aCC1e] || 220;
  const aCC2price = P.AAPL?.[D.aCC2e] || 220;
  const a2price   = P.AAPL?.[D.a2Ce]  || 220;
  const nCSPprice = P.NVDA?.[D.nCSPe] || 175;
  const n2price   = P.NVDA?.[D.n2CCe] || 175;
  const mCSPprice = P.MSFT?.[D.mCSPe] || 395;
  const tBuyPx    = P.TSLA?.[D.tBuy]  || 372;
  const tCC1price = P.TSLA?.[D.tCC1e] || 372;
  const tCC2price = P.TSLA?.[D.tCC2e] || 372;
  const metaPrice = P.META?.[D.metaE] || 580;
  const amznPrice = P.AMZN?.[D.amznE] || 205;
  const spyPrice  = P.SPY?.[D.spyCe]  || 653;

  // ── Strikes ───────────────────────────────────────────────────────────────
  const aCSPk = cspStrike(aCSPprice);
  const aCC1k = ccStrike(aCC1price);
  const aCC2k = ccStrike(aCC2price);
  const a2K   = cspStrike(a2price);
  const nCSPk = cspStrike(nCSPprice);
  const n2CCk = ccStrike(n2price);
  const mCSPk = cspStrike(mCSPprice);
  const tBuyP = Math.round(tBuyPx / 5) * 5;
  const tCC1k = ccStrike(tCC1price);
  const tCC2k = ccStrike(tCC2price);
  const metaK = longCallStrike(metaPrice);
  const amznK = longPutStrike(amznPrice);
  const spyK  = spyCspStrike(spyPrice);

  // ── Premiums (DTE from entry to expiry) ───────────────────────────────────
  const aCSPprem  = creditPremium(aCSPprice, 30, VOL.AAPL, 2);
  const aCC1prem  = creditPremium(aCC1price, 40, VOL.AAPL, 2);
  const aCC1exit  = Math.round(aCC1prem * 0.5 * 20) / 20;   // BTC at ~50%
  const aCC2prem  = creditPremium(aCC2price, 42, VOL.AAPL, 2);
  const a2prem    = creditPremium(a2price,   72, VOL.AAPL, 1);
  const nCSPprem  = creditPremium(nCSPprice, 27, VOL.NVDA, 2);
  const n2CCprem  = creditPremium(n2price,   37, VOL.NVDA, 1);
  const mCSPprem  = creditPremium(mCSPprice, 19, VOL.MSFT, 1);
  const mCSPexit  = Math.round(mCSPprem * 0.5 * 20) / 20;
  const tCC1prem  = creditPremium(tCC1price, 28, VOL.TSLA, 1);
  const tCC2prem  = creditPremium(tCC2price, 43, VOL.TSLA, 1);
  const metaPrem  = debitPremium(metaPrice,  15, VOL.META);
  const metaExit  = Math.round(metaPrem * 0.55 * 20) / 20;  // sell at ~55% of entry
  const amznPrem  = debitPremium(amznPrice,   7, VOL.AMZN);
  const spyPrem   = creditPremium(spyPrice,  72, VOL.SPY,  2);

  // P&L calculations
  const aCC1pnl  = Math.round((aCC1prem - aCC1exit) * 2 * 100);
  const mCSPpnl  = Math.round((mCSPprem - mCSPexit) * 1 * 100);
  const tCC1pnl  = Math.round(tCC1prem * 1 * 100);
  const metaPnl  = Math.round((metaExit - metaPrem) * 1 * 100);
  const nCSPpnl  = Math.round(nCSPprem * 2 * 100);
  const amznPnl  = Math.round(-amznPrem * 1 * 100);

  // ── Format helpers ────────────────────────────────────────────────────────
  const sch  = (t,d,k,cp) => `${t} ${dt(d,'MM/DD/YYYY')} ${k.toFixed(2)} ${cp}`;
  const schD = (n,d,k,cp) => `${n}  ${dt(d,'MM/DD/YYYY')} $${k} ${cp==='C'?'Call':'Put'}`;
  const tt   = (t,d,k,cp) => `${t} ${dt(d,'M/D/YY')} ${cp}${k}`;
  const ibkr = (t,d,k,cp) => `${t} ${dt(d,'YYYYMMDD')} ${cp}${String(Math.round(k*1000)).padStart(8,'0')}`;
  const rh   = (t,d,k,cp) => `${t}${dt(d,'M/D/YY')}${cp}${k}`;
  const rhD  = (n,d,k,cp) => `${n} ${dt(d,'MON')} $${k.toFixed(2)} ${cp==='C'?'Call':'Put'}`;

  if (broker === 'schwab-sample.csv') {
    return [
      `Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount`,
      `"${dt(D.aCSPe,'MM/DD/YYYY')}","Sell to Open","${sch('AAPL',D.aCSPx,aCSPk,'P')}","${schD('APPLE INC',D.aCSPx,aCSPk,'P')}",2,${aCSPprem},1.30,"${-(aCSPprem*200).toFixed(2)}"`,
      `"${dt(D.aCSPx,'MM/DD/YYYY')}","Assigned","${sch('AAPL',D.aCSPx,aCSPk,'P')}","${schD('APPLE INC',D.aCSPx,aCSPk,'P')}",2,0,0,"0.00"`,
      `"${dt(D.aCC1e,'MM/DD/YYYY')}","Sell to Open","${sch('AAPL',D.aCC1x,aCC1k,'C')}","${schD('APPLE INC',D.aCC1x,aCC1k,'C')}",2,${aCC1prem},1.30,"${-(aCC1prem*200).toFixed(2)}"`,
      `"${dt(D.aCC1b,'MM/DD/YYYY')}","Buy to Close","${sch('AAPL',D.aCC1x,aCC1k,'C')}","${schD('APPLE INC',D.aCC1x,aCC1k,'C')}",2,${aCC1exit},1.30,"${(aCC1exit*200).toFixed(2)}"`,
      `"${dt(D.aCC2e,'MM/DD/YYYY')}","Sell to Open","${sch('AAPL',D.aCC2x,aCC2k,'C')}","${schD('APPLE INC',D.aCC2x,aCC2k,'C')}",2,${aCC2prem},1.30,"${-(aCC2prem*200).toFixed(2)}"`,
      `"${dt(D.aCC2x,'MM/DD/YYYY')}","Assigned","${sch('AAPL',D.aCC2x,aCC2k,'C')}","${schD('APPLE INC',D.aCC2x,aCC2k,'C')}",2,0,0,"0.00"`,
      `END`,
      `"${dt(D.nCSPe,'MM/DD/YYYY')}","Sell to Open","${sch('NVDA',D.nCSPx,nCSPk,'P')}","${schD('NVIDIA CORP',D.nCSPx,nCSPk,'P')}",2,${nCSPprem},1.30,"${-(nCSPprem*200).toFixed(2)}"`,
      `"${dt(D.nCSPx,'MM/DD/YYYY')}","Expired","${sch('NVDA',D.nCSPx,nCSPk,'P')}","${schD('NVIDIA CORP',D.nCSPx,nCSPk,'P')}",2,0,0,"0.00"`,
      `END`,
      `"${dt(D.mCSPe,'MM/DD/YYYY')}","Sell to Open","${sch('MSFT',D.mCSPx,mCSPk,'P')}","${schD('MICROSOFT CORP',D.mCSPx,mCSPk,'P')}",1,${mCSPprem},0.65,"${-(mCSPprem*100).toFixed(2)}"`,
      `"${dt(D.mCSPb,'MM/DD/YYYY')}","Buy to Close","${sch('MSFT',D.mCSPx,mCSPk,'P')}","${schD('MICROSOFT CORP',D.mCSPx,mCSPk,'P')}",1,${mCSPexit},0.65,"${(mCSPexit*100).toFixed(2)}"`,
      `END`,
      `"${dt(D.tBuy,'MM/DD/YYYY')}","Buy","TSLA","TESLA INC",100,${tBuyP}.00,0,"-${(tBuyP*100).toFixed(2)}"`,
      `"${dt(D.tCC1e,'MM/DD/YYYY')}","Sell to Open","${sch('TSLA',D.tCC1x,tCC1k,'C')}","${schD('TESLA INC',D.tCC1x,tCC1k,'C')}",1,${tCC1prem},0.65,"${-(tCC1prem*100).toFixed(2)}"`,
      `"${dt(D.tCC1x,'MM/DD/YYYY')}","Expired","${sch('TSLA',D.tCC1x,tCC1k,'C')}","${schD('TESLA INC',D.tCC1x,tCC1k,'C')}",1,0,0,"0.00"`,
      `"${dt(D.tCC2e,'MM/DD/YYYY')}","Sell to Open","${sch('TSLA',D.tCC2x,tCC2k,'C')}","${schD('TESLA INC',D.tCC2x,tCC2k,'C')}",1,${tCC2prem},0.65,"${-(tCC2prem*100).toFixed(2)}"`,
      `"${dt(D.tCC2x,'MM/DD/YYYY')}","Assigned","${sch('TSLA',D.tCC2x,tCC2k,'C')}","${schD('TESLA INC',D.tCC2x,tCC2k,'C')}",1,0,0,"0.00"`,
      `END`,
      `"${dt(D.metaE,'MM/DD/YYYY')}","Buy to Open","${sch('META',D.metaX,metaK,'C')}","${schD('META PLATFORMS',D.metaX,metaK,'C')}",1,${metaPrem},0.65,"${-(metaPrem*100).toFixed(2)}"`,
      `"${dt(D.metaX,'MM/DD/YYYY')}","Sell to Close","${sch('META',D.metaX,metaK,'C')}","${schD('META PLATFORMS',D.metaX,metaK,'C')}",1,${metaExit},0.65,"${(metaExit*100).toFixed(2)}"`,
      `END`,
      `"${dt(D.amznE,'MM/DD/YYYY')}","Buy to Open","${sch('AMZN',D.amznX,amznK,'P')}","${schD('AMAZON COM',D.amznX,amznK,'P')}",1,${amznPrem},0.65,"${-(amznPrem*100).toFixed(2)}"`,
      `"${dt(D.amznX,'MM/DD/YYYY')}","Expired","${sch('AMZN',D.amznX,amznK,'P')}","${schD('AMAZON COM',D.amznX,amznK,'P')}",1,0,0,"0.00"`,
      `END`,
      `"${dt(D.n2Buy,'MM/DD/YYYY')}","Buy","NVDA","NVIDIA CORP",100,${n2price.toFixed(2)},0,"-${(n2price*100).toFixed(2)}"`,
      `"${dt(D.n2CCe,'MM/DD/YYYY')}","Sell to Open","${sch('NVDA',D.n2CCx,n2CCk,'C')}","${schD('NVIDIA CORP',D.n2CCx,n2CCk,'C')}",1,${n2CCprem},0.65,"${-(n2CCprem*100).toFixed(2)}"`,
      `END`,
      `"${dt(D.spyCe,'MM/DD/YYYY')}","Sell to Open","${sch('SPY',D.spyCx,spyK,'P')}","${schD('S&P 500 ETF',D.spyCx,spyK,'P')}",2,${spyPrem},1.30,"${-(spyPrem*200).toFixed(2)}"`,
      `END`,
      `"${dt(D.a2Ce,'MM/DD/YYYY')}","Sell to Open","${sch('AAPL',D.a2Cx,a2K,'P')}","${schD('APPLE INC',D.a2Cx,a2K,'P')}",1,${a2prem},0.65,"${-(a2prem*100).toFixed(2)}"`,
      `END`,
      `"${dt(D.aCSPe,'MM/DD/YYYY')}","Cash Dividend","AAPL","APPLE INC CASH DIV",,,,50.00`,
      `"${dt(D.mCSPe,'MM/DD/YYYY')}","Bank Interest","SCHWAB BANK INT","BANK INTEREST",,,,18.42`,
      `"${dt(D.n2Buy,'MM/DD/YYYY')}","Wire Funds Received","INCOMING WIRE","WIRE TRANSFER IN",,,,25000.00`,
    ].join('\n');
  }

  if (broker === 'tastytrade-sample.csv') {
    return [
      `Date,Type,Sub Type,Symbol,Average Price,Quantity,Value,Description`,
      `${dt(D.aCSPe)},Trade,Sell to Open,${tt('AAPL',D.aCSPx,aCSPk,'P')},${aCSPprem},-2,${-(aCSPprem*200).toFixed(2)},Sell 2 AAPL CSP`,
      `${dt(D.aCSPx)},Receive Deliver,Assignment,${tt('AAPL',D.aCSPx,aCSPk,'P')},0,2,0.00,AAPL CSP Assigned`,
      `${dt(D.aCSPx)},Receive Deliver,Buy to Open,AAPL,${aCSPk}.00,200,${(aCSPk*200).toFixed(2)},AAPL Shares Received`,
      `END`,
      `${dt(D.aCC1e)},Trade,Sell to Open,${tt('AAPL',D.aCC1x,aCC1k,'C')},${aCC1prem},-2,${-(aCC1prem*200).toFixed(2)},Sell 2 AAPL CC`,
      `${dt(D.aCC1b)},Trade,Buy to Close,${tt('AAPL',D.aCC1x,aCC1k,'C')},${aCC1exit},2,${(aCC1exit*200).toFixed(2)},Buy back AAPL CC`,
      `${dt(D.aCC2e)},Trade,Sell to Open,${tt('AAPL',D.aCC2x,aCC2k,'C')},${aCC2prem},-2,${-(aCC2prem*200).toFixed(2)},Sell 2 AAPL CC`,
      `${dt(D.aCC2x)},Receive Deliver,Assignment,${tt('AAPL',D.aCC2x,aCC2k,'C')},0,2,0.00,AAPL CC Called Away`,
      `${dt(D.aCC2x)},Receive Deliver,Sell to Close,AAPL,${aCC2k}.00,-200,${-(aCC2k*200).toFixed(2)},AAPL Shares Delivered`,
      `END`,
      `${dt(D.nCSPe)},Trade,Sell to Open,${tt('NVDA',D.nCSPx,nCSPk,'P')},${nCSPprem},-2,${-(nCSPprem*200).toFixed(2)},Sell 2 NVDA CSP`,
      `${dt(D.nCSPx)},Receive Deliver,Expiration,${tt('NVDA',D.nCSPx,nCSPk,'P')},0,2,0.00,NVDA CSP Expired Worthless`,
      `END`,
      `${dt(D.mCSPe)},Trade,Sell to Open,${tt('MSFT',D.mCSPx,mCSPk,'P')},${mCSPprem},-1,${-(mCSPprem*100).toFixed(2)},Sell 1 MSFT CSP`,
      `${dt(D.mCSPb)},Trade,Buy to Close,${tt('MSFT',D.mCSPx,mCSPk,'P')},${mCSPexit},1,${(mCSPexit*100).toFixed(2)},Buy back MSFT CSP early`,
      `END`,
      `${dt(D.tBuy)},Receive Deliver,Buy to Open,TSLA,${tBuyP}.00,100,${(tBuyP*100).toFixed(2)},Buy 100 TSLA shares`,
      `${dt(D.tCC1e)},Trade,Sell to Open,${tt('TSLA',D.tCC1x,tCC1k,'C')},${tCC1prem},-1,${-(tCC1prem*100).toFixed(2)},Sell 1 TSLA CC`,
      `${dt(D.tCC1x)},Receive Deliver,Expiration,${tt('TSLA',D.tCC1x,tCC1k,'C')},0,1,0.00,TSLA CC Expired Worthless`,
      `${dt(D.tCC2e)},Trade,Sell to Open,${tt('TSLA',D.tCC2x,tCC2k,'C')},${tCC2prem},-1,${-(tCC2prem*100).toFixed(2)},Sell 1 TSLA CC`,
      `${dt(D.tCC2x)},Receive Deliver,Assignment,${tt('TSLA',D.tCC2x,tCC2k,'C')},0,1,0.00,TSLA CC Called Away`,
      `${dt(D.tCC2x)},Receive Deliver,Sell to Close,TSLA,${tCC2k}.00,-100,${-(tCC2k*100).toFixed(2)},TSLA Shares Delivered`,
      `END`,
      `${dt(D.metaE)},Trade,Buy to Open,${tt('META',D.metaX,metaK,'C')},${metaPrem},1,${(metaPrem*100).toFixed(2)},Buy 1 META Long Call`,
      `${dt(D.metaX)},Trade,Sell to Close,${tt('META',D.metaX,metaK,'C')},${metaExit},-1,${-(metaExit*100).toFixed(2)},Sell META Long Call`,
      `END`,
      `${dt(D.amznE)},Trade,Buy to Open,${tt('AMZN',D.amznX,amznK,'P')},${amznPrem},1,${(amznPrem*100).toFixed(2)},Buy 1 AMZN Long Put`,
      `${dt(D.amznX)},Receive Deliver,Expiration,${tt('AMZN',D.amznX,amznK,'P')},0,1,0.00,AMZN Long Put Expired`,
      `END`,
      `${dt(D.n2Buy)},Receive Deliver,Buy to Open,NVDA,${n2price.toFixed(2)},100,${(n2price*100).toFixed(2)},Buy 100 NVDA shares`,
      `${dt(D.n2CCe)},Trade,Sell to Open,${tt('NVDA',D.n2CCx,n2CCk,'C')},${n2CCprem},-1,${-(n2CCprem*100).toFixed(2)},Sell 1 NVDA CC open`,
      `END`,
      `${dt(D.spyCe)},Trade,Sell to Open,${tt('SPY',D.spyCx,spyK,'P')},${spyPrem},-2,${-(spyPrem*200).toFixed(2)},Sell 2 SPY CSP open`,
      `END`,
      `${dt(D.a2Ce)},Trade,Sell to Open,${tt('AAPL',D.a2Cx,a2K,'P')},${a2prem},-1,${-(a2prem*100).toFixed(2)},Sell 1 AAPL CSP open`,
      `END`,
      `${dt(D.aCSPe)},Money Movement,Credit,,,,,Monthly interest credit`,
      `${dt(D.mCSPe)},Money Movement,Credit,,,,,Dividend credit AAPL`,
      `${dt(D.n2Buy)},Money Movement,Deposit,,,,,ACH deposit`,
      `${dt(D.mCSPb)},Money Movement,Debit,,,,,Monthly platform fee`,
    ].join('\n');
  }

  if (broker === 'ibkr-sample.csv') {
    const acct = 'U1234567';
    const oi = (sym,entryD,qty,price,comm,basis,rpnl,code) =>
      `Trades,Data,Order,Equity and Index Options,USD,${acct},${sym},${dt(entryD,'IBKR')},CBOE,${qty},${price},${price},${(qty*price*-1).toFixed(2)},${comm},${basis},${rpnl},0,${code}`;
    const st = (sym,entryD,qty,price,comm,code) =>
      `Trades,Data,Order,Stocks,USD,${acct},${sym},${dt(entryD,'IBKR')},NASDAQ,${qty},${price},${price},${(qty*price).toFixed(2)},${comm},${(qty*price*-1).toFixed(2)},0,0,${code}`;
    return [
      `Statement,Header,Field Name,Field Value`,
      `Statement,Data,BrokerName,Interactive Brokers`,
      `Statement,Data,AccountID,${acct}`,
      `Statement,Data,FromDate,${dt(-120)}`,
      `Statement,Data,ToDate,${dt(0)}`,
      `Trades,Header,DataDiscriminator,Asset Category,Currency,Account,Symbol,Date/Time,Exchange,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code`,
      oi(ibkr('AAPL',D.aCSPx,aCSPk,'P'), D.aCSPe, -2, aCSPprem, -1.30, aCSPprem*200, 0, 'O'),
      oi(ibkr('AAPL',D.aCSPx,aCSPk,'P'), D.aCSPx,  2, 0, 0, 0, aCSPprem*200, 'A'),
      st('AAPL', D.aCSPx, 200, aCSPk, 0, 'A'),
      oi(ibkr('AAPL',D.aCC1x,aCC1k,'C'), D.aCC1e, -2, aCC1prem, -1.30, aCC1prem*200, 0, 'O'),
      oi(ibkr('AAPL',D.aCC1x,aCC1k,'C'), D.aCC1b,  2, aCC1exit, -1.30, -aCC1prem*200, (aCC1prem-aCC1exit)*200-2.60, 'C'),
      oi(ibkr('AAPL',D.aCC2x,aCC2k,'C'), D.aCC2e, -2, aCC2prem, -1.30, aCC2prem*200, 0, 'O'),
      oi(ibkr('AAPL',D.aCC2x,aCC2k,'C'), D.aCC2x,  2, 0, 0, 0, aCC2prem*200, 'A'),
      st('AAPL', D.aCC2x, -200, aCC2k, 0, 'A'),
      `END`,
      oi(ibkr('NVDA',D.nCSPx,nCSPk,'P'), D.nCSPe, -2, nCSPprem, -1.30, nCSPprem*200, 0, 'O'),
      oi(ibkr('NVDA',D.nCSPx,nCSPk,'P'), D.nCSPx,  2, 0, 0, 0, nCSPprem*200, 'Ep'),
      `END`,
      oi(ibkr('MSFT',D.mCSPx,mCSPk,'P'), D.mCSPe, -1, mCSPprem, -0.65, mCSPprem*100, 0, 'O'),
      oi(ibkr('MSFT',D.mCSPx,mCSPk,'P'), D.mCSPb,  1, mCSPexit, -0.65, -mCSPprem*100, (mCSPprem-mCSPexit)*100-1.30, 'C'),
      `END`,
      st('TSLA', D.tBuy, 100, tBuyP, -1.00, 'O'),
      oi(ibkr('TSLA',D.tCC1x,tCC1k,'C'), D.tCC1e, -1, tCC1prem, -0.65, tCC1prem*100, 0, 'O'),
      oi(ibkr('TSLA',D.tCC1x,tCC1k,'C'), D.tCC1x,  1, 0, 0, 0, tCC1prem*100, 'Ep'),
      oi(ibkr('TSLA',D.tCC2x,tCC2k,'C'), D.tCC2e, -1, tCC2prem, -0.65, tCC2prem*100, 0, 'O'),
      oi(ibkr('TSLA',D.tCC2x,tCC2k,'C'), D.tCC2x,  1, 0, 0, 0, tCC2prem*100, 'A'),
      st('TSLA', D.tCC2x, -100, tCC2k, 0, 'A'),
      `END`,
      oi(ibkr('META',D.metaX,metaK,'C'), D.metaE,  1, metaPrem, -0.65, -metaPrem*100, 0, 'O'),
      oi(ibkr('META',D.metaX,metaK,'C'), D.metaX, -1, metaExit, -0.65, metaPrem*100, (metaExit-metaPrem)*100-1.30, 'C'),
      `END`,
      oi(ibkr('AMZN',D.amznX,amznK,'P'), D.amznE,  1, amznPrem, -0.65, -amznPrem*100, 0, 'O'),
      oi(ibkr('AMZN',D.amznX,amznK,'P'), D.amznX, -1, 0, 0, 0, -amznPrem*100, 'Ep'),
      `END`,
      st('NVDA', D.n2Buy, 100, n2price.toFixed(2), -1.00, 'O'),
      oi(ibkr('NVDA',D.n2CCx,n2CCk,'C'), D.n2CCe, -1, n2CCprem, -0.65, n2CCprem*100, 0, 'O'),
      `END`,
      oi(ibkr('SPY',D.spyCx,spyK,'P'), D.spyCe, -2, spyPrem, -1.30, spyPrem*200, 0, 'O'),
      `END`,
      oi(ibkr('AAPL',D.a2Cx,a2K,'P'), D.a2Ce, -1, a2prem, -0.65, a2prem*100, 0, 'O'),
      `END`,
      `Cash Report,Header,Currency Summary,Currency,Total,Securities,Futures,Month to Date,Year to Date`,
      `Cash Report,Data,Ending Cash,USD,75000.00,75000.00,0,75000.00,75000.00`,
    ].join('\n');
  }

  if (broker === 'robinhood-sample.csv') {
    const p1 = (d) => dt(d+1,'MM/DD/YYYY');
    const p2 = (d) => dt(d+2,'MM/DD/YYYY');
    const row = (d,inst,desc,code,qty,price,amt) =>
      `${dt(d,'MM/DD/YYYY')},${p1(d)},${p2(d)},${inst},${desc},${code},${qty},${price},${amt}`;
    return [
      `Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount`,
      row(D.aCSPe, rh('AAPL',D.aCSPx,aCSPk,'P'), rhD('AAPL',D.aCSPx,aCSPk,'P'), 'STO', 2, `$${aCSPprem}`, `-$${(aCSPprem*200).toFixed(2)}`),
      row(D.aCSPx, rh('AAPL',D.aCSPx,aCSPk,'P'), rhD('AAPL',D.aCSPx,aCSPk,'P'), 'OASGN', 2, '$0.00', '$0.00'),
      row(D.aCSPx, 'AAPL', 'AAPL Shares Assigned', 'BUY', 200, `$${aCSPk}.00`, `-$${(aCSPk*200).toFixed(2)}`),
      row(D.aCC1e, rh('AAPL',D.aCC1x,aCC1k,'C'), rhD('AAPL',D.aCC1x,aCC1k,'C'), 'STO', 2, `$${aCC1prem}`, `-$${(aCC1prem*200).toFixed(2)}`),
      row(D.aCC1b, rh('AAPL',D.aCC1x,aCC1k,'C'), rhD('AAPL',D.aCC1x,aCC1k,'C'), 'BTC', 2, `$${aCC1exit}`, `$${(aCC1exit*200).toFixed(2)}`),
      row(D.aCC2e, rh('AAPL',D.aCC2x,aCC2k,'C'), rhD('AAPL',D.aCC2x,aCC2k,'C'), 'STO', 2, `$${aCC2prem}`, `-$${(aCC2prem*200).toFixed(2)}`),
      row(D.aCC2x, rh('AAPL',D.aCC2x,aCC2k,'C'), rhD('AAPL',D.aCC2x,aCC2k,'C'), 'OASGN', 2, '$0.00', '$0.00'),
      row(D.aCC2x, 'AAPL', 'AAPL Shares Called Away', 'SELL', 200, `$${aCC2k}.00`, `$${(aCC2k*200).toFixed(2)}`),
      `END`,
      row(D.nCSPe, rh('NVDA',D.nCSPx,nCSPk,'P'), rhD('NVDA',D.nCSPx,nCSPk,'P'), 'STO', 2, `$${nCSPprem}`, `-$${(nCSPprem*200).toFixed(2)}`),
      row(D.nCSPx, rh('NVDA',D.nCSPx,nCSPk,'P'), rhD('NVDA',D.nCSPx,nCSPk,'P'), 'OEXP', 2, '$0.00', '$0.00'),
      `END`,
      row(D.mCSPe, rh('MSFT',D.mCSPx,mCSPk,'P'), rhD('MSFT',D.mCSPx,mCSPk,'P'), 'STO', 1, `$${mCSPprem}`, `-$${(mCSPprem*100).toFixed(2)}`),
      row(D.mCSPb, rh('MSFT',D.mCSPx,mCSPk,'P'), rhD('MSFT',D.mCSPx,mCSPk,'P'), 'BTC', 1, `$${mCSPexit}`, `$${(mCSPexit*100).toFixed(2)}`),
      `END`,
      row(D.tBuy,  'TSLA', 'TSLA Stock Purchase', 'BUY', 100, `$${tBuyP}.00`, `-$${(tBuyP*100).toFixed(2)}`),
      row(D.tCC1e, rh('TSLA',D.tCC1x,tCC1k,'C'), rhD('TSLA',D.tCC1x,tCC1k,'C'), 'STO', 1, `$${tCC1prem}`, `-$${(tCC1prem*100).toFixed(2)}`),
      row(D.tCC1x, rh('TSLA',D.tCC1x,tCC1k,'C'), rhD('TSLA',D.tCC1x,tCC1k,'C'), 'OEXP', 1, '$0.00', '$0.00'),
      row(D.tCC2e, rh('TSLA',D.tCC2x,tCC2k,'C'), rhD('TSLA',D.tCC2x,tCC2k,'C'), 'STO', 1, `$${tCC2prem}`, `-$${(tCC2prem*100).toFixed(2)}`),
      row(D.tCC2x, rh('TSLA',D.tCC2x,tCC2k,'C'), rhD('TSLA',D.tCC2x,tCC2k,'C'), 'OASGN', 1, '$0.00', '$0.00'),
      row(D.tCC2x, 'TSLA', 'TSLA Shares Called Away', 'SELL', 100, `$${tCC2k}.00`, `$${(tCC2k*100).toFixed(2)}`),
      `END`,
      row(D.metaE, rh('META',D.metaX,metaK,'C'), rhD('META',D.metaX,metaK,'C'), 'BTO', 1, `$${metaPrem}`, `-$${(metaPrem*100).toFixed(2)}`),
      row(D.metaX, rh('META',D.metaX,metaK,'C'), rhD('META',D.metaX,metaK,'C'), 'STC', 1, `$${metaExit}`, `$${(metaExit*100).toFixed(2)}`),
      `END`,
      row(D.amznE, rh('AMZN',D.amznX,amznK,'P'), rhD('AMZN',D.amznX,amznK,'P'), 'BTO', 1, `$${amznPrem}`, `-$${(amznPrem*100).toFixed(2)}`),
      row(D.amznX, rh('AMZN',D.amznX,amznK,'P'), rhD('AMZN',D.amznX,amznK,'P'), 'OEXP', 1, '$0.00', '$0.00'),
      `END`,
      row(D.n2Buy, 'NVDA', 'NVDA Stock Purchase', 'BUY', 100, `$${n2price.toFixed(2)}`, `-$${(n2price*100).toFixed(2)}`),
      row(D.n2CCe, rh('NVDA',D.n2CCx,n2CCk,'C'), rhD('NVDA',D.n2CCx,n2CCk,'C'), 'STO', 1, `$${n2CCprem}`, `-$${(n2CCprem*100).toFixed(2)}`),
      `END`,
      row(D.spyCe, rh('SPY',D.spyCx,spyK,'P'), rhD('SPY',D.spyCx,spyK,'P'), 'STO', 2, `$${spyPrem}`, `-$${(spyPrem*200).toFixed(2)}`),
      `END`,
      row(D.a2Ce,  rh('AAPL',D.a2Cx,a2K,'P'), rhD('AAPL',D.a2Cx,a2K,'P'), 'STO', 1, `$${a2prem}`, `-$${(a2prem*100).toFixed(2)}`),
      `END`,
      row(D.aCSPe, 'AAPL', 'AAPL Dividend', 'DIV', '', '', '50.00'),
      row(D.mCSPe, 'MSFT', 'MSFT Dividend', 'DIV', '', '', '94.00'),
      row(D.n2Buy,  '', 'ACH Deposit', 'ACH', '', '', '25000.00'),
    ].join('\n');
  }

  if (broker === 'manual-sample.csv') {
    // All strikes computed dynamically from spot prices using the same
    // helper functions as the broker samples — snap to valid increments
    const SP = {
      AAPL:248, TSLA:372, ABBV:208, VRTX:458, PLTR:152, CRDO:103,
      SPY:653,  QQQ:584,  NFLX:93,  IREN:41,  AXSM:165, CRSP:46,
      NVDA:175, INOD:22,
    };
    const snap = (p, s) => { const i = s<50?0.5:s<100?1:s<200?2.5:5; return Math.round(Math.round(p/i)*i*100)/100; };
    const Km = (t, otm) => snap(SP[t]*otm, SP[t]);

    // Wheel strikes
    const m_aCSPk  = Km('AAPL', 0.927);  const m_aCC1k  = Km('AAPL', 1.028); const m_aCC2k  = Km('AAPL', 1.048);
    const m_tCSPk  = Km('TSLA', 0.914);  const m_tCC1k  = Km('TSLA', 1.048); const m_tCC2k  = Km('TSLA', 1.062);
    const m_nCSPk  = Km('NVDA', 0.914);
    // Spread strikes
    const m_abbvCC = Km('ABBV', 1.034);  const m_abbvCC2 = Km('ABBV', 1.048);
    const m_qqqBPs = Km('QQQ',  0.957);  const m_qqqBPb  = Km('QQQ',  0.940);
    const m_spyBPs = Km('SPY',  0.839);  const m_spyBPb  = Km('SPY',  0.827);
    const m_nvdaBCs= Km('NVDA', 1.057);  const m_nvdaBCb = Km('NVDA', 1.086);
    const m_qqqBCs = Km('QQQ',  1.036);  const m_qqqBCb  = Km('QQQ',  1.045);
    const m_axsmBCs= Km('AXSM', 1.061);  const m_axsmBCb = Km('AXSM', 1.000);
    const m_aaplBCs= Km('AAPL', 1.048);  const m_aaplBCb = Km('AAPL', 1.008);
    const m_spyBPsO= Km('SPY',  0.965);  const m_spyBPbO = Km('SPY',  0.949);
    const m_tslaBPs= Km('TSLA', 0.968);  const m_tslaBPb = Km('TSLA', 1.000);
    // IC / IB strikes
    const m_aaplICs= Km('AAPL', 1.048);  const m_aaplICb = Km('AAPL', 1.008);
    const m_aaplIPs= Km('AAPL', 0.867);  const m_aaplIPb = Km('AAPL', 0.827);
    const m_spyICs = Km('SPY',  1.026);  const m_spyIPb  = Km('SPY',  0.957);
    const m_nvdaIBb= Km('NVDA', 1.000);  const m_nvdaIBw = Km('NVDA', 0.943);
    const m_spyIBb = Km('SPY',  1.000);  const m_spyIBw  = Km('SPY',  0.954);
    // Diag/Cal strikes
    const m_inodDs = Km('INOD', 1.136);  const m_inodDl  = Km('INOD', 1.227);
    const m_aaplDs = Km('AAPL', 1.069);  const m_aaplDl  = Km('AAPL', 1.028);
    const m_abbvCal= Km('ABBV', 0.962);
    // Long options
    const m_nflxLC = Km('NFLX', 1.075); const m_nflxLP = Km('NFLX', 1.022);
    const m_axsmLC = Km('AXSM', 0.970); const m_spyLP  = Km('SPY',  0.957);
    // Straddle / strangle
    const m_crspStr= Km('CRSP', 1.000);
    const m_inodSts= Km('INOD', 0.591); const m_inodStb = Km('INOD', 0.500);
    const m_nvdaStc= Km('NVDA', 1.057); const m_nvdaStp = Km('NVDA', 0.943);
    // PLTR CSP
    const m_pltrCSP= Km('PLTR', 0.954);

    // P&L (pre-computed, consistent)
    const m_aCC1pnl = Math.round((aCC1prem - aCC1exit) * 2 * 100);
    const m_tCC1pnl = Math.round(tCC1prem * 1 * 100);

    return [
      `ticker,strategy,status,entry_date,expiration,entry_price,contracts,strike_sell,strike_buy,exit_price,exit_date,pnl,expiration_back,option_type,delta,gamma,theta,vega,iv_entry,notes`,
      `# AAPL wheel: CSP assigned then two covered call cycles`,
      `AAPL,Cash-Secured Put,closed,${dt(D.aCSPe)},${dt(D.aCSPx)},${aCSPprem},2,,${m_aCSPk},${m_aCSPk}.00,${dt(D.aCSPx)},,,,,-0.28,0.04,-0.12,0.22,28,CSP assigned at strike`,
      `AAPL,CSP Assignment,,${dt(D.aCSPx)},,${m_aCSPk}.00,200,,,,,,,,,,,,,AAPL 200 shares received at $${m_aCSPk}`,
      `AAPL,Covered Call,closed,${dt(D.aCC1e)},${dt(D.aCC1x)},${aCC1prem},2,${m_aCC1k},,${aCC1exit},${dt(D.aCC1b)},${m_aCC1pnl},,,-0.28,0.04,-0.12,0.22,26,Closed at 50% profit`,
      `AAPL,Covered Call,open,${dt(D.aCC2e)},${dt(D.n2CCx)},${aCC2prem},2,${m_aCC2k},,,,,,,,-0.28,0.03,-0.10,0.20,26,Current CC cycle`,
      `END`,
      `NVDA,Cash-Secured Put,closed,${dt(D.nCSPe)},${dt(D.nCSPx)},${nCSPprem},2,,${m_nCSPk},${Math.round(nCSPprem*0.5*20)/20},${dt(D.nCSPx)},${Math.round(nCSPprem*0.5*200)},,,-0.30,0.03,-0.15,0.35,42,Closed at 50% profit`,
      `END`,
      `PLTR,Cash-Secured Put,open,${dt(D.n2CCe)},${dt(D.spyCx)},6.20,1,,${m_pltrCSP},,,,,,-0.28,0.04,-0.18,0.40,52,Bullish entry on PLTR pullback`,
      `END`,
      `# TSLA full wheel`,
      `TSLA,Cash-Secured Put,closed,${dt(D.tBuy)},${dt(D.tCC1x)},${tCC1prem},1,,${m_tCSPk},${m_tCSPk}.00,${dt(D.tCC1x)},,,,,,,,,CSP assigned at $${m_tCSPk}`,
      `TSLA,CSP Assignment,,${dt(D.tCC1x)},,${m_tCSPk}.00,100,,,,${dt(D.tCC1x)},,,,,,,,,TSLA 100 shares assigned at $${m_tCSPk}`,
      `TSLA,Covered Call,closed,${dt(D.tCC1e)},${dt(D.tCC1x)},${tCC1prem},1,${m_tCC1k},,0,${dt(D.tCC1x)},${m_tCC1pnl},,,-0.28,,,,,Expired worthless`,
      `TSLA,Covered Call,closed,${dt(D.tCC2e)},${dt(D.tCC2x)},${tCC2prem},1,${m_tCC2k},,${m_tCC2k}.00,${dt(D.tCC2x)},,,,,,,,,CC called away at $${m_tCC2k}`,
      `TSLA,Called Away,,,,,,,,${m_tCC2k}.00,${dt(D.tCC2x)},,,,,,,,,TSLA shares called away at $${m_tCC2k}`,
      `END`,
      `ABBV,Stock Purchase,,${dt(D.mCSPe)},,${Math.round(SP.ABBV*0.93)}.00,100,,,,,,,,,,,,, Bought 100 shares outright`,
      `ABBV,Covered Call,closed,${dt(D.mCSPb)},${dt(D.mCSPx)},3.50,1,${m_abbvCC},,0,${dt(D.mCSPx)},350,,,-0.28,0.03,-0.10,0.18,22,Expired worthless`,
      `ABBV,Covered Call,open,${dt(D.n2CCe)},${dt(D.spyCx)},3.10,1,${m_abbvCC2},,,,,,,,-0.28,0.03,-0.09,0.16,22,Current CC cycle`,
      `END`,
      `QQQ,Bull Put Spread,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},2.60,2,${m_qqqBPs},${m_qqqBPb},0.52,${dt(D.mCSPb)},416,,,-0.22,0.03,-0.09,0.28,17,Closed 80% profit`,
      `SPY,Bull Put Spread,open,${dt(D.n2CCe)},${dt(D.spyCx)},2.20,2,${m_spyBPs},${m_spyBPb},,,,,,-0.20,0.02,-0.07,0.22,14,Credit spread below support`,
      `END`,
      `NVDA,Bear Call Spread,closed,${dt(D.nCSPe)},${dt(D.nCSPx)},4.20,1,${m_nvdaBCs},${m_nvdaBCb},0,${dt(D.nCSPx)},420,,,-0.22,0.03,-0.11,0.30,42,Expired worthless`,
      `QQQ,Bear Call Spread,open,${dt(D.n2CCe)},${dt(D.spyCx)},1.80,2,${m_qqqBCs},${m_qqqBCb},,,,,,-0.22,0.02,-0.08,0.25,17,Mild hedge above resistance`,
      `END`,
      `AXSM,Bull Call Spread,open,${dt(D.n2CCe)},${dt(D.spyCx)},3.20,2,${m_axsmBCs},${m_axsmBCb},,,,,,0.47,0.05,-0.14,0.38,48,Defined risk bullish`,
      `AAPL,Bull Call Spread,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},2.80,1,${m_aaplBCs},${m_aaplBCb},4.20,${dt(D.mCSPb)},-140,,,0.35,0.04,-0.12,0.30,26,Directional missed - closed for loss`,
      `END`,
      `SPY,Bear Put Spread,open,${dt(D.n2CCe)},${dt(D.spyCx)},2.80,2,${m_spyBPsO},${m_spyBPbO},,,,,,-0.32,0.04,-0.13,0.35,14,Portfolio hedge`,
      `TSLA,Bear Put Spread,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},4.20,2,${m_tslaBPs},${m_tslaBPb},2.80,${dt(D.mCSPb)},-280,,,-0.38,0.05,-0.16,0.42,56,TSLA continued higher - closed hedge`,
      `END`,
      `AAPL,Iron Condor,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},2.40,2,${m_aaplICs},${m_aaplIPs},0.34,${dt(D.mCSPx)},412,,,-0.10,0.02,-0.06,0.18,24,AAPL stayed in range - 85% profit`,
      `SPY,Iron Condor,open,${dt(D.n2CCe)},${dt(D.spyCx)},3.20,2,${m_spyICs},${m_spyIPb},,,,,,-0.10,0.01,-0.05,0.15,18,Range trade`,
      `END`,
      `NVDA,Iron Butterfly,closed,${dt(D.nCSPe)},${dt(D.nCSPx)},12.80,1,${m_nvdaIBb},${m_nvdaIBw},3.20,${dt(D.nCSPx)},960,,,-0.06,0.01,-0.04,0.12,42,75% profit at body`,
      `SPY,Iron Butterfly,open,${dt(D.n2CCe)},${dt(D.spyCx)},10.40,1,${m_spyIBb},${m_spyIBw},,,,,,-0.05,0.01,-0.03,0.10,18,Centered near ATM`,
      `END`,
      `ABBV,Calendar Spread,closed,${dt(D.mCSPe)},${dt(D.mCSPb)},2.40,1,,,1.10,${dt(D.mCSPx)},,${dt(D.spyCx)},call,0.08,0.02,-0.05,0.25,22,Front expired - theta captured`,
      `NFLX,Calendar Spread,open,${dt(D.n2CCe)},${dt(D.n2CCx)},4.60,1,,,,,, ${dt(D.spyCx)},call,0.08,0.02,-0.06,0.30,32,Long vol near-ATM`,
      `END`,
      `INOD,Diagonal Spread,open,${dt(D.n2CCe)},${dt(D.n2CCx)},0.55,2,${m_inodDs},${m_inodDl},,,,${dt(D.spyCx)},call,-0.04,0.01,-0.02,0.08,90,Short front long back`,
      `AAPL,Diagonal Spread,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},3.20,1,${m_aaplDs},${m_aaplDl},1.80,${dt(D.mCSPb)},140,${dt(D.n2CCx)},call,-0.06,0.01,-0.03,0.12,26,Short leg expired - net gain`,
      `END`,
      `NFLX,Long Call,open,${dt(D.n2CCe)},${dt(D.n2CCx)},2.60,1,,${m_nflxLC},,,,,, 0.35,0.04,-0.11,0.28,32,Bullish earnings catalyst`,
      `AXSM,Long Call,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},1.80,2,,${m_axsmLC},0,${dt(D.mCSPx)},-360,,,, 0.28,0.03,-0.09,0.22,48,OTM expired worthless`,
      `END`,
      `NFLX,Long Put,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},9.20,1,,${m_nflxLP},18.50,${dt(D.mCSPx)},930,,,,-0.38,0.05,-0.16,0.40,32,Sold off post-earnings - put doubled`,
      `SPY,Long Put,open,${dt(D.n2CCe)},${dt(D.spyCx)},4.80,2,,${m_spyLP},,,,,,-0.30,0.04,-0.12,0.32,18,Tail risk hedge on portfolio`,
      `END`,
      `CRSP,Long Straddle,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},14.20,1,${m_crspStr},${m_crspStr},6.80,${dt(D.mCSPb)},-740,,, 0.02,0.01,-0.04,0.50,62,FDA delay - IV crushed`,
      `CRSP,Long Straddle,open,${dt(D.n2CCe)},${dt(D.n2CCx)},12.80,1,${m_crspStr},${m_crspStr},,,,,,, 0.02,0.01,-0.03,0.48,62,New FDA window`,
      `END`,
      `INOD,Long Strangle,closed,${dt(D.mCSPe)},${dt(D.mCSPx)},2.10,1,${m_inodSts},${m_inodStb},0.40,${dt(D.mCSPb)},-170,,, 0.04,0.01,-0.02,0.15,90,INOD flat - strangle lost to theta`,
      `NVDA,Long Strangle,open,${dt(D.n2CCe)},${dt(D.spyCx)},8.40,1,${m_nvdaStc},${m_nvdaStp},,,,,, 0.03,0.01,-0.02,0.18,42,Binary event - earnings strangle`,
      `END`,
    ].join('\n');
  }

  return null;
}


  // GET /api/migration/:filename — serve migration guide docs and sample CSVs
  // Files live in public/migration/ (inside the React build, copied at build time)
  app.get('/api/migration/:filename', async (req, res) => {
    try {
      const prices = await getSamplePrices().catch(() => ({}));
      const allowed = [
        'Schwab_Migration_Guide.docx',
        'IBKR_Migration_Guide.docx',
        'Robinhood_Migration_Guide.docx',
        'Tastytrade_Migration_Guide.docx',
        'schwab-sample.csv',
        'ibkr-sample.csv',
        'robinhood-sample.csv',
        'tastytrade-sample.csv',
        'manual-sample.csv',
        'Manual_Migration_Guide.docx',
      ];
      const filename = req.params.filename;
      if (!allowed.includes(filename)) {
        return res.status(404).json({ error: 'File not found.' });
      }
      // Path resolution for all three scenarios:
      //   Scenario 1 (npm start):       IS_ELECTRON=false → __dirname/public/migration/
      //   Scenario 2 (ELECTRON-DEV):    IS_ELECTRON=true, not packaged →
      //                                  OTT_RESOURCES=trade-tracker/ → build/migration/
      //   Scenario 3 (shipped .exe):    IS_ELECTRON=true, packaged →
      //                                  OTT_RESOURCES=resources/ → resources/app/migration/
      const migResources = process.env.OTT_RESOURCES || path.join(__dirname, '..');
      const buildDir = IS_ELECTRON
        ? path.join(migResources, (!!process.env.OTT_RESOURCES && process.env.OTT_RESOURCES.includes('resources')) ? 'app' : 'build')
        : path.join(__dirname, 'public');
      const filePath = path.join(buildDir, 'migration', filename);
      if (!fs.existsSync(filePath)) {
        log('Migration file not found: ' + filePath);
        return res.status(404).json({ error: 'Migration file not found on disk.' });
      }
      const ext = path.extname(filename).toLowerCase();
      const mimeTypes = {
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.csv':  'text/csv',
      };
      const mime = mimeTypes[ext] || 'application/octet-stream';

      // For CSV sample files — generate dynamically with today-relative dates
      // so open positions always have future expiry dates regardless of when
      // the user runs the app. .docx migration guides are served as static files.
      if (ext === '.csv') {
        const csvContent = generateSampleCSV(filename, prices);
        if (csvContent) {
          res.setHeader('Content-Type', 'text/csv');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          res.setHeader('Content-Length', Buffer.byteLength(csvContent, 'utf8'));
          return res.end(csvContent, 'utf8');
        }
      }

      // Fall through to static file for .docx and any unrecognised CSV
      const stat = fs.statSync(filePath);
      res.setHeader('Content-Type',        mime);
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length',      stat.size);
      fs.createReadStream(filePath).pipe(res);
      log('Migration file served: ' + filename);
    } catch (e) {
      log('Migration serve error: ' + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/backup/download — stream trades.db as a downloadable file
  app.get('/api/backup/download', (req, res) => {
    try {
      // Flush current in-memory DB to disk first
      saveDb();
      if (!fs.existsSync(dbPath)) {
        return res.status(404).json({ error: 'Database file not found.' });
      }
      const stat     = fs.statSync(dbPath);
      const dateStr  = localDateISO();
      const filename = `myoptiondiary-backup-${dateStr}.db`;
      res.setHeader('Content-Type',        'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length',      stat.size);
      fs.createReadStream(dbPath).pipe(res);
      log('Backup downloaded: ' + filename + ' (' + stat.size + ' bytes)');
    } catch (e) {
      log('Backup error: ' + e.message);
      res.status(500).json({ error: 'Backup failed: ' + e.message });
    }
  });


  process.on('SIGINT', () => { saveDb(); process.exit(0); });
}

init();
