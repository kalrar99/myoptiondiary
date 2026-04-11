// src/components/ImportModal.jsx
import React, { useState, useRef } from 'react';

// ── SHA-256 hash ──────────────────────────────────────────
async function sha256(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Parsers ───────────────────────────────────────────────
// ── Shared OCC symbol parser ─────────────────────────────
// Handles: "AAPL 03/21/2026 220.00 C", "AAPL 3/21/26 C220",
//          "AAPL 20260321 C00220000" (IBKR), "AAPL3/21/26C220" (Robinhood)
function parseOCCSymbol(raw) {
  if (!raw) return null;
  const s = raw.trim();

  // Format 1: "AAPL 03/21/2026 220.00 C" or "AAPL 03/21/2026 220 C" (Schwab description)
  const f1 = s.match(/^([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+([\d.]+)\s+([CP])/i);
  if (f1) {
    const [, ticker, m, d, y, strike, cp] = f1;
    const yr = y.length === 2 ? '20' + y : y;
    return { ticker, expiration: `${yr}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`,
             strike: parseFloat(strike), isCall: cp.toUpperCase() === 'C' };
  }

  // Format 2: "AAPL 3/21/26 C220" (Tastytrade symbol)
  const f2 = s.match(/^([A-Z]+)\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+([CP])([\d.]+)/i);
  if (f2) {
    const [, ticker, m, d, y, cp, strike] = f2;
    const yr = y.length === 2 ? '20' + y : y;
    return { ticker, expiration: `${yr}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`,
             strike: parseFloat(strike), isCall: cp.toUpperCase() === 'C' };
  }

  // Format 3: "AAPL 20260321 C00220000" (IBKR OCC)
  const f3 = s.match(/^([A-Z]+)\s+(\d{8})\s+([CP])(\d{8})/i);
  if (f3) {
    const [, ticker, dateStr, cp, strikeRaw] = f3;
    const expiration = `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
    return { ticker, expiration, strike: parseInt(strikeRaw) / 1000, isCall: cp.toUpperCase() === 'C' };
  }

  // Format 4: "AAPL3/21/26C220" (Robinhood compact) or "AAPL3/21/2026C220"
  const f4 = s.match(/^([A-Z]+)(\d{1,2})\/(\d{1,2})\/(\d{2,4})([CP])([\d.]+)/i);
  if (f4) {
    const [, ticker, m, d, y, cp, strike] = f4;
    const yr = y.length === 2 ? '20' + y : y;
    return { ticker, expiration: `${yr}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`,
             strike: parseFloat(strike), isCall: cp.toUpperCase() === 'C' };
  }

  return null;
}

// Derive strategy from call/put type and action
function deriveStrategy(isCall, action) {
  // action: 'open_sell', 'open_buy', 'close_sell', 'close_buy'
  if (isCall && action === 'open_sell')  return 'Covered Call';
  if (!isCall && action === 'open_sell') return 'Cash-Secured Put';
  if (isCall && action === 'open_buy')   return 'Long Call';
  if (!isCall && action === 'open_buy')  return 'Long Put';
  // Close rows — preserve direction for P&L pairing
  if (isCall && action === 'close_buy')  return 'Covered Call';   // buying back a CC
  if (!isCall && action === 'close_buy') return 'Cash-Secured Put'; // buying back a CSP
  if (isCall && action === 'close_sell') return 'Long Call';       // selling to close a long call
  if (!isCall && action === 'close_sell') return 'Long Put';       // selling to close a long put
  return isCall ? 'Covered Call' : 'Cash-Secured Put';
}

// ── Correct strike field assignment ──────────────────────────────────────
// Convention in this app:
//   Covered Call  → strike_sell (the call you sold)
//   CSP           → strike_buy  (the put you sold — stored as strike_buy per schema)
//   Long Call     → strike_buy
//   Long Put      → strike_buy
function assignStrikes(parsed, strategy) {
  const s = parsed.strike;
  switch (strategy) {
    case 'Covered Call':     return { strike_sell: s, strike_buy: null };
    case 'Cash-Secured Put': return { strike_sell: null, strike_buy: s };
    case 'Long Call':        return { strike_sell: null, strike_buy: s };
    case 'Long Put':         return { strike_sell: null, strike_buy: s };
    default:                 return { strike_sell: s, strike_buy: null };
  }
}

// Normalise date string to YYYY-MM-DD
function normDate(s) {
  if (!s) return '';
  s = s.trim().replace(/["']/g, '');
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0,10);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) {
    const yr = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
  }
  return s.slice(0,10);
}

// ── Schwab parser ─────────────────────────────────────────
// Real format: Date,Action,Symbol,Description,Quantity,Price,Fees & Comm,Amount
// END marker separates wheel lots. BUY row creates a lot. Assigned/Expired handled.
function parseSchwab(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const trades = [];
  const skipped = [];

  const OPTION_OPEN_CLOSE = ['sell to open','buy to close','buy to open','sell to close'];
  const OPTION_EVENTS     = ['expired','assigned','exercise'];
  // Track open position direction (short/long) so Expired rows can identify
  // whether the expiring option was a CC/CSP (short) or Long Call/Long Put (long).
  const openPositions = {};
  const SILENT_SKIP = [
    'cash dividend','qualified dividend','non-qualified div',
    'reinvest dividend','reinvest shares','special dividend','bank interest',
    'bond interest','credit interest','short term cap gain','long term cap gain',
    'cash in lieu','return of capital','margin interest','adr mgmt fee',
    'foreign tax paid','misc cash entry','service fee','wire funds',
    'wire funds received','wire transfer','journal','journaled shares',
    'moneylink transfer','moneylink deposit','electronic funds transfer',
    'funds received','security transfer','shares in',
  ];

  for (const line of lines) {
    // END marker — lot group separator
    if (line.trim() === 'END') {
      trades.push({ _endMarker: true, notes: '· END ·' });
      continue;
    }

    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 6) continue;
    const dateStr   = cols[0];
    const actionRaw = cols[1] || '';
    const action    = actionRaw.toLowerCase().trim();
    const symbol    = cols[2] || '';
    const qty       = Math.abs(parseInt(cols[4])) || 1;
    const price     = Math.abs(parseFloat(cols[5])) || null;

    if (dateStr === 'Date' || dateStr === '') continue;

    // ── Stock purchase row → create lot ──────────────────────────────────
    if (action === 'buy' && !parseOCCSymbol(symbol)) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker) {
        trades.push({
          _lotCreate: true,
          ticker,
          shares: qty,
          avg_cost: price,
          purchase_date: normDate(dateStr),
          notes: `Imported from Schwab · Stock purchase`,
        });
      }
      continue;
    }

    // ── Standard open/close trades ────────────────────────────────────────
    if (OPTION_OPEN_CLOSE.includes(action)) {
      const parsed = parseOCCSymbol(symbol);
      if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${symbol}"` }); continue; }
      const isOpen   = action.includes('to open');
      const isSell   = action.includes('sell');
      const actKey   = `${isOpen ? 'open' : 'close'}_${isSell ? 'sell' : 'buy'}`;
      const strategy = deriveStrategy(parsed.isCall, actKey);
      const strikes  = assignStrikes(parsed, strategy);
      // Track direction of open positions for Expired row lookup
      if (isOpen) openPositions[symbol] = isSell ? 'short' : 'long';
      else        delete openPositions[symbol];
      trades.push({
        ticker: parsed.ticker, strategy,
        status: isOpen ? 'open' : 'closed',
        entry_date:  isOpen ? normDate(dateStr) : null,
        expiration:  parsed.expiration,
        entry_price: isOpen ? price : null,
        exit_price:  isOpen ? null  : price,
        exit_date:   isOpen ? null  : normDate(dateStr),
        contracts: qty, ...strikes, pnl: null,
        notes: `Imported from Schwab · ${actionRaw}`,
      });
      continue;
    }

    // ── Expiry / Assignment / Exercise events ─────────────────────────────
    if (OPTION_EVENTS.includes(action)) {
      const parsed = parseOCCSymbol(symbol);
      if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${symbol}"` }); continue; }

      if (action === 'expired') {
        // Use openPositions to determine if this was a short (CC/CSP) or long (Long Call/Put)
        const wasShort = openPositions[symbol] !== 'long';
        const strategy = wasShort
          ? (parsed.isCall ? 'Covered Call'  : 'Cash-Secured Put')
          : (parsed.isCall ? 'Long Call'     : 'Long Put');
        const strikes  = assignStrikes(parsed, strategy);
        delete openPositions[symbol];
        trades.push({
          ticker: parsed.ticker, strategy, status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: 0, exit_date: normDate(dateStr),
          contracts: qty, ...strikes, pnl: null,
          notes: `Imported from Schwab · Expired worthless`,
          _event: 'expired',
        });
      } else if (action === 'assigned') {
        // Determine if this is a CSP assignment (put → shares received)
        // or a CC called-away (call → shares sold)
        if (!parsed.isCall) {
          // CSP assigned → mark the option as closed AND request lot creation
          const strikes = assignStrikes(parsed, 'Cash-Secured Put');
          trades.push({
            ticker: parsed.ticker, strategy: 'Cash-Secured Put', status: 'closed',
            entry_date: normDate(dateStr), expiration: parsed.expiration,
            entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
            contracts: qty, ...strikes, pnl: null,
            notes: `Imported from Schwab · Assigned · Use Assignment button in Trade Log`,
            _event: 'assigned_put',
            _lotCreate: true,
            lot_ticker: parsed.ticker,
            lot_shares: qty * 100,
            lot_avg_cost: parsed.strike,
            lot_purchase_date: normDate(dateStr),
          });
        } else {
          // CC called away → mark option closed, lot will be closed by called-away logic
          const strikes = assignStrikes(parsed, 'Covered Call');
          trades.push({
            ticker: parsed.ticker, strategy: 'Covered Call', status: 'closed',
            entry_date: normDate(dateStr), expiration: parsed.expiration,
            entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
            contracts: qty, ...strikes, pnl: null,
            notes: `Imported from Schwab · Called Away · Use Called Away button in Trade Log`,
            _event: 'called_away',
            _lotClose: true,
            lot_ticker: parsed.ticker,
            lot_close_price: parsed.strike,
            lot_close_date: normDate(dateStr),
          });
        }
      } else {
        // Exercise
        const strategy = parsed.isCall ? 'Long Call' : 'Long Put';
        const strikes  = assignStrikes(parsed, strategy);
        trades.push({
          ticker: parsed.ticker, strategy, status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: 0, exit_date: normDate(dateStr),
          contracts: qty, ...strikes, pnl: null,
          notes: `Imported from Schwab · Exercise · verify shares received/delivered`,
          _event: 'exercise',
        });
      }
      continue;
    }

    // Silent skip for known non-option rows
    if (SILENT_SKIP.some(s => action.startsWith(s))) continue;

    // Unknown action — surface it
    if (dateStr && actionRaw) {
      skipped.push({ row: line.slice(0,60), reason: `Unrecognised action — skipped: "${actionRaw}"` });
    }
  }
  return { trades, skipped };
}

// ── Tastytrade parser ─────────────────────────────────────
// Real format: Date,Type,Sub Type,Symbol,Average Price,Quantity,Value,Description
// END markers separate lot groups.
// Receive Deliver / Buy to Open (no OCC) = stock purchase → lot create
// Receive Deliver / Sell to Close (no OCC) = stock sale → lot close
// Receive Deliver / Expiration|Assignment|Exercise = option event
// Trade / Sell to Open|Buy to Open|Buy to Close|Sell to Close = standard option trade
// Money Movement = silently skipped
function parseTastytrade(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const trades = [];
  const skipped = [];

  const SILENT_SKIP_SUBS = new Set([
    'forward split','reverse split','symbol change','stock merger','cash merger',
    'acquisition','acat transfer','stock dividend','balance adjustment',
    'deposit','withdrawal','ach','wire','credit','debit',
  ]);
  const RD_EVENTS = new Set(['expiration','assignment','exercise']);

  // Track open positions by symbol so Expiration rows can determine
  // whether the original trade was short (STO → CSP/CC) or long (BTO → Long Call/Put).
  // Key: symbol, Value: 'short' | 'long'
  const openPositions = {};

  for (const line of lines) {
    if (line.trim() === 'END') {
      trades.push({ _endMarker: true, notes: '· END ·' });
      continue;
    }
    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 4) continue;
    const dateStr = cols[0];
    const typeRaw = cols[1] || '';
    const type    = typeRaw.toLowerCase();
    const subRaw  = cols[2] || '';
    const subType = subRaw.toLowerCase().replace(/\s*\(\w+\)\s*$/, '').trim();
    const symbol  = cols[3] || '';
    const price   = Math.abs(parseFloat(cols[4])) || null;
    const qty     = parseInt(cols[5]) || 0;

    if (dateStr === 'Date' || dateStr === '') continue;
    if (type === 'money movement' || SILENT_SKIP_SUBS.has(subType)) continue;

    // ── Receive Deliver rows ───────────────────────────────────────────────
    if (type === 'receive deliver') {
      const parsed = parseOCCSymbol(symbol);

      // Stock rows — no OCC symbol in the Symbol column
      if (!parsed) {
        const ticker = symbol.trim().toUpperCase();
        if (!ticker) continue;

        // Skip the paired stock-delivery rows that Tastytrade appends after
        // Assignment and Called Away events.  The Assignment row above already
        // signals the app to create / close the lot — these rows are redundant
        // and would double-trigger lot operations.
        //   • Receive Deliver / Buy to Open  → "Shares Received"  (post-CSP-assignment)
        //   • Receive Deliver / Sell to Close → "Shares Delivered" (post-CC-called-away)
        const descLower = (cols[7] || '').toLowerCase();
        if (descLower.includes('shares received') || descLower.includes('shares delivered')) continue;

        if (subType === 'buy to open') {
          // Outright stock purchase (no preceding Assignment row)
          trades.push({
            _lotCreate: true,
            ticker,
            shares: Math.abs(qty),
            avg_cost: price,
            purchase_date: normDate(dateStr),
            notes: `Imported from Tastytrade · Receive Deliver / Buy to Open · stock received`,
          });
        } else if (subType === 'sell to close') {
          // Outright stock sale (no preceding Called Away row)
          trades.push({
            _lotClose: true,
            lot_ticker: ticker,
            lot_close_price: price,
            lot_close_date: normDate(dateStr),
            notes: `Imported from Tastytrade · Receive Deliver / Sell to Close · stock delivered`,
          });
        } else if (!SILENT_SKIP_SUBS.has(subType)) {
          skipped.push({ row: line.slice(0,60), reason: `Receive Deliver stock row sub type not recognised: "${subRaw}"` });
        }
        continue;
      }

      // Option event rows — OCC symbol present
      if (!RD_EVENTS.has(subType)) {
        skipped.push({ row: line.slice(0,60), reason: `Receive Deliver sub type not recognised: "${subRaw}"` });
        continue;
      }

      if (subType === 'expiration') {
        // Determine short vs long from the opening Trade row we saw earlier
        const wasShort = openPositions[symbol] !== 'long';
        const strategy = wasShort
          ? (parsed.isCall ? 'Covered Call'  : 'Cash-Secured Put')
          : (parsed.isCall ? 'Long Call'     : 'Long Put');
        const strikes = assignStrikes(parsed, strategy);
        trades.push({
          ticker: parsed.ticker, strategy, status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: 0, exit_date: normDate(dateStr),
          contracts: Math.abs(qty) || 1, ...strikes, pnl: null,
          notes: `Imported from Tastytrade · Expiration · expired worthless`,
          _event: 'expired',
        });
        delete openPositions[symbol];

      } else if (subType === 'assignment') {
        if (!parsed.isCall) {
          // CSP assigned — option closes; create lot inline (mirrors Schwab behaviour)
          const strikes = assignStrikes(parsed, 'Cash-Secured Put');
          trades.push({
            ticker: parsed.ticker, strategy: 'Cash-Secured Put', status: 'closed',
            entry_date: normDate(dateStr), expiration: parsed.expiration,
            entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
            contracts: Math.abs(qty) || 1, ...strikes, pnl: null,
            notes: `Imported from Tastytrade · Assignment · Use Assignment button in Trade Log`,
            _event: 'assigned_put',
            _lotCreate: true,
            lot_ticker: parsed.ticker,
            lot_shares: (Math.abs(qty) || 1) * 100,
            lot_avg_cost: parsed.strike,
            lot_purchase_date: normDate(dateStr),
          });
        } else {
          // CC called away — option closes; close lot inline (mirrors Schwab behaviour)
          const strikes = assignStrikes(parsed, 'Covered Call');
          trades.push({
            ticker: parsed.ticker, strategy: 'Covered Call', status: 'closed',
            entry_date: normDate(dateStr), expiration: parsed.expiration,
            entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
            contracts: Math.abs(qty) || 1, ...strikes, pnl: null,
            notes: `Imported from Tastytrade · Assignment (Called Away) · Use Called Away button in Trade Log`,
            _event: 'called_away',
            _lotClose: true,
            lot_ticker: parsed.ticker,
            lot_close_price: parsed.strike,
            lot_close_date: normDate(dateStr),
          });
        }
        delete openPositions[symbol];

      } else {
        // Exercise
        const strategy = parsed.isCall ? 'Long Call' : 'Long Put';
        const strikes  = assignStrikes(parsed, strategy);
        trades.push({
          ticker: parsed.ticker, strategy, status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: 0, exit_date: normDate(dateStr),
          contracts: Math.abs(qty) || 1, ...strikes, pnl: null,
          notes: `Imported from Tastytrade · Exercise · verify shares received/delivered`,
          _event: 'exercise',
        });
        delete openPositions[symbol];
      }
      continue;
    }

    // ── Trade rows ─────────────────────────────────────────────────────────
    if (type !== 'trade') {
      if (dateStr && typeRaw) skipped.push({ row: line.slice(0,60), reason: `Type not recognised: "${typeRaw}"` });
      continue;
    }
    const parsed = parseOCCSymbol(symbol);
    if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${symbol}"` }); continue; }

    const isOpen   = subType.includes('to open');
    const isSell   = qty < 0 || subType.startsWith('sell');
    const actKey   = `${isOpen ? 'open' : 'close'}_${isSell ? 'sell' : 'buy'}`;
    const strategy = deriveStrategy(parsed.isCall, actKey);
    const strikes  = assignStrikes(parsed, strategy);

    // Track open position direction for Expiration lookup
    if (isOpen) openPositions[symbol] = isSell ? 'short' : 'long';
    else        delete openPositions[symbol];

    trades.push({
      ticker: parsed.ticker, strategy,
      status: isOpen ? 'open' : 'closed',
      entry_date: normDate(dateStr), expiration: parsed.expiration,
      entry_price: isOpen ? price : null,
      exit_price:  isOpen ? null  : price,
      exit_date:   isOpen ? null  : normDate(dateStr),
      contracts: Math.abs(qty) || 1, ...strikes, pnl: null,
      notes: `Imported from Tastytrade · ${subRaw}`,
    });
  }
  return { trades, skipped };
}


// ── IBKR parser ───────────────────────────────────────────
// Real format: section-based CSV; Trades,Data rows only.
// Code: O=open, C=close, A=assignment/called-away, Ep=expired
// Quantity: negative=sell, positive=buy
// END rows appear as plain text lines between lot groups.
function parseIBKR(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const trades = [];
  const skipped = [];

  let headers = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('Trades,Header,')) {
      headers = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      break;
    }
  }
  // Track open position direction for Ep (expiry) row lookup
  const openPositions = {};

  const col = name => headers.indexOf(name);

  for (const line of lines) {
    // END marker — lot group separator (plain text line, not a Trades,Data row)
    if (line.trim() === 'END') {
      trades.push({ _endMarker: true, notes: '· END ·' });
      continue;
    }

    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());

    // ── Stock rows (Asset Category = Stocks) ─────────────────────────────
    if (cols[0] === 'Trades' && cols[1] === 'Data' &&
        col('Asset Category') >= 0 && cols[col('Asset Category')] === 'Stocks') {
      const ticker  = col('Symbol') >= 0 ? cols[col('Symbol')] : cols[6];
      const dateRaw = col('Date/Time') >= 0 ? cols[col('Date/Time')] : cols[7];
      const qty     = parseFloat(col('Quantity') >= 0 ? cols[col('Quantity')] : cols[9]) || 0;
      const price   = Math.abs(parseFloat(col('T. Price') >= 0 ? cols[col('T. Price')] : cols[10])) || null;
      const code    = col('Code') >= 0 ? cols[col('Code')] : cols[17] || '';
      const entryDate = normDate(dateRaw.split(/[;,]/)[0]);

      // Skip stock rows that are paired with an option assignment/called-away event
      // (Code=A). The option event row above already carries _lotCreate/_lotClose
      // inline — these stock rows are redundant and would create duplicate lots.
      // Only process outright purchases (Code=O) and manual sales (no Code=A).
      if (code.includes('A')) { continue; }

      if (qty > 0) {
        // Outright stock purchase — lot creation
        trades.push({
          _lotCreate: true,
          ticker: ticker.trim().toUpperCase(),
          shares: Math.abs(qty),
          avg_cost: price,
          purchase_date: entryDate,
          notes: `Imported from IBKR · Stock purchase`,
        });
      } else if (qty < 0) {
        // Outright stock sale — lot close
        trades.push({
          _lotClose: true,
          lot_ticker: ticker.trim().toUpperCase(),
          lot_close_price: price,
          lot_close_date: entryDate,
          notes: `Imported from IBKR · Stock sale`,
        });
      }
      continue;
    }

    // Only process option trade data rows from here
    if (cols[0] !== 'Trades' || cols[1] !== 'Data') continue;
    if (col('Asset Category') >= 0 && cols[col('Asset Category')] !== 'Equity and Index Options') {
      const cat = col('Asset Category') >= 0 ? cols[col('Asset Category')] : 'unknown';
      if (cat && cat !== 'Asset Category' && cat !== 'Stocks') {
        skipped.push({ row: line.slice(0,60), reason: `Not an option — Asset Category: "${cat}"` });
      }
      continue;
    }

    const symbol  = col('Symbol') >= 0 ? cols[col('Symbol')] : cols[6];
    const dateRaw = col('Date/Time') >= 0 ? cols[col('Date/Time')] : cols[7];
    const qty     = parseFloat(col('Quantity') >= 0 ? cols[col('Quantity')] : cols[9]) || 0;
    const price   = Math.abs(parseFloat(col('T. Price') >= 0 ? cols[col('T. Price')] : cols[10])) || null;
    const realPnl = parseFloat(col('Realized P/L') >= 0 ? cols[col('Realized P/L')] : cols[15]) || null;
    const code    = col('Code') >= 0 ? cols[col('Code')] : cols[17] || '';
    const entryDate = normDate(dateRaw.split(/[;,]/)[0]);

    const parsed = parseOCCSymbol(symbol);
    if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${symbol}"` }); continue; }

    // ── Expiry: Code Ep ───────────────────────────────────────────────────
    if (code.includes('Ep')) {
      // Use openPositions to determine short vs long — qty sign is unreliable on Ep rows
      // (closing transactions invert the sign: qty=-1 on Ep means the long put is being expired)
      const wasShort = openPositions[symbol] !== 'long';
      const strat = wasShort
        ? (parsed.isCall ? 'Covered Call'  : 'Cash-Secured Put')
        : (parsed.isCall ? 'Long Call'     : 'Long Put');
      const strikes = assignStrikes(parsed, strat);
      delete openPositions[symbol];
      trades.push({
        ticker: parsed.ticker, strategy: strat, status: 'closed',
        entry_date: entryDate, expiration: parsed.expiration,
        entry_price: null, exit_price: 0, exit_date: entryDate,
        contracts: Math.abs(qty) || 1, ...strikes,
        pnl: (realPnl !== null && realPnl !== 0) ? realPnl : null,
        notes: `Imported from IBKR · Expired worthless`,
        _event: 'expired',
      });
      continue;
    }

    // ── Assignment / Called Away: Code A ──────────────────────────────────
    if (code.includes('A')) {
      if (!parsed.isCall) {
        // CSP assigned — option closes; create lot inline (mirrors Schwab/Tastytrade)
        const strikes = assignStrikes(parsed, 'Cash-Secured Put');
        trades.push({
          ticker: parsed.ticker, strategy: 'Cash-Secured Put', status: 'closed',
          entry_date: entryDate, expiration: parsed.expiration,
          entry_price: null, exit_price: parsed.strike, exit_date: entryDate,
          contracts: Math.abs(qty) || 1, ...strikes,
          pnl: realPnl !== null && realPnl !== 0 ? realPnl : null,
          notes: `Imported from IBKR · Assigned · Use Assignment button in Trade Log`,
          _event: 'assigned_put',
          _lotCreate: true,
          lot_ticker: parsed.ticker,
          lot_shares: (Math.abs(qty) || 1) * 100,
          lot_avg_cost: parsed.strike,
          lot_purchase_date: entryDate,
        });
      } else {
        // CC called away — option closes; close lot inline (mirrors Schwab/Tastytrade)
        const strikes = assignStrikes(parsed, 'Covered Call');
        trades.push({
          ticker: parsed.ticker, strategy: 'Covered Call', status: 'closed',
          entry_date: entryDate, expiration: parsed.expiration,
          entry_price: null, exit_price: parsed.strike, exit_date: entryDate,
          contracts: Math.abs(qty) || 1, ...strikes,
          pnl: realPnl !== null && realPnl !== 0 ? realPnl : null,
          notes: `Imported from IBKR · Called Away · Use Called Away button in Trade Log`,
          _event: 'called_away',
          _lotClose: true,
          lot_ticker: parsed.ticker,
          lot_close_price: parsed.strike,
          lot_close_date: entryDate,
        });
      }
      continue;
    }

    // ── Standard open / close ─────────────────────────────────────────────
    const isOpen = code.includes('O') || !code.includes('C');
    const isSell = qty < 0;
    const actKey = `${isOpen ? 'open' : 'close'}_${isSell ? 'sell' : 'buy'}`;
    const strategy = deriveStrategy(parsed.isCall, actKey);
    const strikes = assignStrikes(parsed, strategy);
    // Track direction for Ep (expiry) lookup
    if (isOpen) openPositions[symbol] = isSell ? 'short' : 'long';
    else        delete openPositions[symbol];
    trades.push({
      ticker: parsed.ticker, strategy,
      status: isOpen ? 'open' : 'closed',
      entry_date:  entryDate,
      expiration:  parsed.expiration,
      entry_price: isOpen ? price : null,
      exit_price:  isOpen ? null  : price,
      exit_date:   isOpen ? null  : entryDate,
      contracts:   Math.abs(qty) || 1, ...strikes,
      pnl: (!isOpen && realPnl !== null && realPnl !== 0) ? realPnl : null,
      notes: `Imported from IBKR · ${code}`,
    });
  }
  return { trades, skipped };
}

// ── Robinhood parser ──────────────────────────────────────
// Real format: Activity Date,Process Date,Settle Date,Instrument,Description,Trans Code,Quantity,Price,Amount
// Trans Code: STO/BTO/STC/BTC=option trades; OEXP=expired; OASGN=assigned/called-away
// BUY=stock purchase (lot creation); SELL=stock sale (lot close/called-away)
// END markers separate lot groups.
function parseRobinhood(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const trades = [];
  const skipped = [];

  const SILENT_SKIP_CODES = new Set(['DIV','CDIV','INT','ACH','JNLC','JNLS','PTC','MISC']);
  // Track open position direction so OEXP rows can identify short vs long
  const openPositions = {};

  for (const line of lines) {
    // END marker
    if (line.trim() === 'END') {
      trades.push({ _endMarker: true, notes: '· END ·' });
      continue;
    }

    const cols = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
    if (cols.length < 6) continue;
    const dateStr    = cols[0];
    const instrument = cols[3] || '';
    const desc       = cols[4] || '';
    const transCode  = (cols[5] || '').toUpperCase().trim();
    const qty        = Math.abs(parseInt(cols[6])) || 1;
    const priceRaw   = (cols[7] || '').replace(/[$,]/g, '');
    const price      = Math.abs(parseFloat(priceRaw)) || null;

    if (dateStr === 'Activity Date' || dateStr === '') continue;

    // ── Silently skip known non-trade codes ───────────────────────────────
    if (SILENT_SKIP_CODES.has(transCode)) continue;

    // ── Stock BUY → lot creation ──────────────────────────────────────────
    if (transCode === 'BUY' && !parseOCCSymbol(instrument)) {
      const ticker = instrument.trim().toUpperCase();
      if (ticker) {
        // Skip shares received via OASGN assignment — lot is created inline
        // on the OASGN put row above. Description contains "Shares Assigned".
        const descLower = (cols[4] || '').toLowerCase();
        if (descLower.includes('shares assigned')) { continue; }
        trades.push({
          _lotCreate: true,
          ticker,
          shares: qty,
          avg_cost: price,
          purchase_date: normDate(dateStr),
          notes: `Imported from Robinhood · Stock purchase`,
        });
      }
      continue;
    }

    // ── Stock SELL → lot close (called away or manual sale) ──────────────
    if (transCode === 'SELL' && !parseOCCSymbol(instrument)) {
      const ticker = instrument.trim().toUpperCase();
      if (ticker) {
        // Skip shares sold via OASGN called-away — lot is closed inline
        // on the OASGN call row above. Description contains "Shares Called Away".
        const descLower = (cols[4] || '').toLowerCase();
        if (descLower.includes('shares called away')) { continue; }
        trades.push({
          _lotClose: true,
          lot_ticker: ticker,
          lot_close_price: price,
          lot_close_date: normDate(dateStr),
          notes: `Imported from Robinhood · Stock ${desc.toLowerCase().includes('called away') ? 'called away' : 'sale'}`,
        });
      }
      continue;
    }

    // ── OEXP — option expired ─────────────────────────────────────────────
    if (transCode === 'OEXP') {
      const parsed = parseOCCSymbol(instrument);
      if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${instrument}"` }); continue; }
      // Use openPositions to determine short (CC/CSP) vs long (Long Call/Put)
      const wasShort = openPositions[instrument] !== 'long';
      const strategy = wasShort
        ? (parsed.isCall ? 'Covered Call'  : 'Cash-Secured Put')
        : (parsed.isCall ? 'Long Call'     : 'Long Put');
      const strikes  = assignStrikes(parsed, strategy);
      delete openPositions[instrument];
      trades.push({
        ticker: parsed.ticker, strategy, status: 'closed',
        entry_date: normDate(dateStr), expiration: parsed.expiration,
        entry_price: null, exit_price: 0, exit_date: normDate(dateStr),
        contracts: qty, ...strikes, pnl: null,
        notes: `Imported from Robinhood · OEXP · expired worthless`,
        _event: 'expired',
      });
      continue;
    }

    // ── OASGN — option assigned / called away ─────────────────────────────
    if (transCode === 'OASGN') {
      const parsed = parseOCCSymbol(instrument);
      if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${instrument}"` }); continue; }
      if (!parsed.isCall) {
        // CSP assigned — create lot inline (mirrors Schwab/Tastytrade/IBKR)
        const strikes = assignStrikes(parsed, 'Cash-Secured Put');
        trades.push({
          ticker: parsed.ticker, strategy: 'Cash-Secured Put', status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
          contracts: qty, ...strikes, pnl: null,
          notes: `Imported from Robinhood · OASGN · Use Assignment button in Trade Log`,
          _event: 'assigned_put',
          _lotCreate: true,
          lot_ticker: parsed.ticker,
          lot_shares: qty * 100,
          lot_avg_cost: parsed.strike,
          lot_purchase_date: normDate(dateStr),
        });
      } else {
        // CC called away — close lot inline (mirrors Schwab/Tastytrade/IBKR)
        const strikes = assignStrikes(parsed, 'Covered Call');
        trades.push({
          ticker: parsed.ticker, strategy: 'Covered Call', status: 'closed',
          entry_date: normDate(dateStr), expiration: parsed.expiration,
          entry_price: null, exit_price: parsed.strike, exit_date: normDate(dateStr),
          contracts: qty, ...strikes, pnl: null,
          notes: `Imported from Robinhood · OASGN · Use Called Away button in Trade Log`,
          _event: 'called_away',
          _lotClose: true,
          lot_ticker: parsed.ticker,
          lot_close_price: parsed.strike,
          lot_close_date: normDate(dateStr),
        });
      }
      continue;
    }

    // ── Standard option trades ────────────────────────────────────────────
    if (!['STO','BTO','STC','BTC'].includes(transCode)) {
      if (dateStr && transCode) skipped.push({ row: line.slice(0,60), reason: `Not an option trade — Trans Code: "${transCode}"` });
      continue;
    }

    const parsed = parseOCCSymbol(instrument);
    if (!parsed) { skipped.push({ row: line.slice(0,60), reason: `Symbol not recognised: "${instrument}"` }); continue; }
    const isOpen  = transCode === 'STO' || transCode === 'BTO';
    const isSell  = transCode === 'STO' || transCode === 'STC';
    const actKey  = `${isOpen ? 'open' : 'close'}_${isSell ? 'sell' : 'buy'}`;
    const strategy = deriveStrategy(parsed.isCall, actKey);
    const strikes = assignStrikes(parsed, strategy);
    // Track direction for OEXP lookup
    if (isOpen) openPositions[instrument] = isSell ? 'short' : 'long';
    else        delete openPositions[instrument];
    trades.push({
      ticker: parsed.ticker, strategy,
      status: isOpen ? 'open' : 'closed',
      entry_date:  normDate(dateStr),
      expiration:  parsed.expiration,
      entry_price: isOpen ? price : null,
      exit_price:  isOpen ? null  : price,
      exit_date:   isOpen ? null  : normDate(dateStr),
      contracts: qty, ...strikes, pnl: null,
      notes: `Imported from Robinhood · ${transCode}`,
    });
  }
  return { trades, skipped };
}


// ── Open/Close pairing ────────────────────────────────────────────────────
// Matches close rows to their corresponding open rows by ticker + strike + expiry.
// Computes P&L for credit strategies: (entry - exit) × contracts × 100
// Sets matched close rows as status:'closed' with exit_price and pnl.
// Unmatched close rows (partial imports) are still included but flagged.
function pairOpenClose(trades) {
  const CREDIT_STRATS = new Set(['Covered Call','Cash-Secured Put']);
  // Event rows (Expired/Assigned/Exercise) pass through untouched — never pair them
  // Event rows are already excluded before pairOpenClose is called (filtered by _event flag).
  // All trades arriving here are regular open/close option rows.
  const opens  = trades.filter(t => t.status === 'open');
  const closes = trades.filter(t => t.status === 'closed');

  // For each close, find best matching open by ticker + expiry + strike
  const paired = new Set();
  const result = [];

  for (const open of opens) {
    const strike = open.strike_sell || open.strike_buy;
    // Find a matching close
    const closeMatch = closes.find((c, idx) => {
      if (paired.has(idx)) return false;
      const cStrike = c.strike_sell || c.strike_buy;
      return (
        c.ticker === open.ticker &&
        c.expiration === open.expiration &&
        Math.abs((cStrike || 0) - (strike || 0)) < 0.5 &&
        c.strategy === open.strategy &&
        !paired.has(idx)
      );
    });

    if (closeMatch) {
      const closeIdx = closes.indexOf(closeMatch);
      paired.add(closeIdx);
      // Compute P&L
      const ep = parseFloat(open.entry_price)  || 0;
      const xp = parseFloat(closeMatch.exit_price) || 0;
      const ct = open.contracts || 1;
      const pnl = CREDIT_STRATS.has(open.strategy)
        ? Math.round((ep - xp) * ct * 100 * 100) / 100   // credit: profit when exit < entry
        : Math.round((xp - ep) * ct * 100 * 100) / 100;  // debit:  profit when exit > entry

      result.push({
        ...open,
        status:     'closed',
        exit_price: closeMatch.exit_price,
        exit_date:  closeMatch.exit_date,
        pnl:        pnl !== 0 ? pnl : null,
        notes:      open.notes + ' · auto-paired',
      });
    } else {
      // No close found — keep as open
      result.push(open);
    }
  }

  // Include unmatched closes (edge case: close imported without open)
  closes.forEach((c, idx) => {
    if (!paired.has(idx)) {
      result.push({ ...c, notes: (c.notes || '') + ' · close only — open not in this import' });
    }
  });

  return result;
}

// ── Trade-level deduplication ─────────────────────────────────────────────
// Removes trades that are exact matches of existing trades already in the DB.
// Matches on: ticker + strategy + entry_date + expiration + strike (within $0.50)
// Also removes duplicates within the import batch itself (overlapping date ranges).
function deduplicateTrades(incoming, existingTrades) {
  // Build a Set of fingerprints from existing trades
  const existingKeys = new Set(
    (existingTrades || []).map(t =>
      `${t.ticker}|${t.strategy}|${t.entry_date}|${t.expiration}|${Math.round((t.strike_sell || t.strike_buy || 0) * 2)}`
    )
  );

  const seen = new Set(); // dedup within the batch
  const unique = [];
  const dupes  = [];

  for (const t of incoming) {
    const key = `${t.ticker}|${t.strategy}|${t.entry_date}|${t.expiration}|${Math.round((t.strike_sell || t.strike_buy || 0) * 2)}`;
    if (existingKeys.has(key) || seen.has(key)) {
      dupes.push(t);
    } else {
      seen.add(key);
      unique.push(t);
    }
  }

  return { unique, dupes };
}

// ── Manual / Spreadsheet parser ───────────────────────────────────────────
// Reads a user-built CSV with named columns. Column order is irrelevant —
// columns are identified by header name (case-insensitive).
//
// Required columns (option trades): ticker, strategy, status, entry_date, expiration, entry_price, contracts
// Conditional: strike_sell, strike_buy, exit_price, exit_date, expiration_back, option_type
// Optional:    pnl, lot_id, delta, gamma, theta, vega, iv_entry, notes
//
// END marker rows and # comment rows are silently skipped.
//
// STOCK LOT ROWS — three reserved strategy values trigger lot operations:
//   "Stock Purchase"  → _lotCreate: ticker, contracts=shares, entry_price=avg_cost, entry_date=purchase_date
//   "CSP Assignment"  → _lotCreate: shares received via put assignment;
//                        ticker, contracts=shares, entry_price=avg_cost, exit_date=purchase_date
//   "Called Away"     → _lotClose:  ticker, exit_price=close_price, exit_date=close_date
//
// NO open/close pairing for option rows — the user provides entry/exit prices directly.
const VALID_STRATEGIES = new Set([
  'Covered Call','Cash-Secured Put',
  'Bull Put Spread','Bear Call Spread','Bull Call Spread','Bear Put Spread',
  'Iron Condor','Iron Butterfly',
  'Calendar Spread','Diagonal Spread',
  'Long Call','Long Put',
  'Long Straddle','Long Strangle',
]);

// Reserved strategy values that produce lot records (not option trades)
const LOT_ROW_STRATEGIES = new Set(['Stock Purchase','CSP Assignment','Called Away']);

const CAL_DIAG = new Set(['Calendar Spread','Diagonal Spread']);

function parseManual(text) {
  const lines  = text.split('\n').map(l => l.trim());
  const trades = [];
  const skipped = [];

  // ── Find header row (first non-blank, non-comment line) ─────────────────
  let headerMap = null; // columnName.toLowerCase() → colIndex
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.startsWith('#') || l.toUpperCase() === 'END') continue;
    const cols = l.split(',').map(c => c.replace(/^"|"$/g,'').trim().toLowerCase());
    // Must contain at least the 7 required columns to be a valid header
    const required = ['ticker','strategy','status','entry_date','expiration','entry_price','contracts'];
    if (required.every(r => cols.includes(r))) {
      headerMap = {};
      for (let ci = 0; ci < cols.length; ci++) { headerMap[cols[ci]] = ci; }
      headerLineIdx = i;
      break;
    }
  }

  if (!headerMap) {
    skipped.push({ row: lines[0]?.slice(0,60) || '', reason: 'No valid header row found. Required columns: ticker, strategy, status, entry_date, expiration, entry_price, contracts' });
    return { trades, skipped };
  }

  // Helper: get value from a row by column name (case-insensitive already mapped)
  const get = (cols, name) => {
    const idx = headerMap[name];
    if (idx === undefined) return null;
    const v = cols[idx];
    return (v === undefined || v === '' || v === null) ? null : v.replace(/^"|"$/g,'').trim();
  };
  const getNum = (cols, name) => {
    const v = get(cols, name);
    if (v === null) return null;
    const n = parseFloat(v.replace(/[$,]/g,''));
    return isNaN(n) ? null : n;
  };

  // ── Parse data rows ──────────────────────────────────────────────────────
  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.toUpperCase() === 'END') continue; // silently skip END markers
    if (line.startsWith('#')) continue;          // comment rows

    const cols = line.split(',').map(c => c.trim());
    // Skip rows that are all blank / description rows (detect by checking ticker)
    const ticker = get(cols, 'ticker');
    if (!ticker || ticker === 'ticker' || ticker.toLowerCase().startsWith('stock symbol')) continue;

    const strategy   = get(cols, 'strategy');
    const status     = (get(cols, 'status') || '').toLowerCase();
    const entry_date = get(cols, 'entry_date');
    const expiration = get(cols, 'expiration');
    const entry_price = getNum(cols, 'entry_price');
    const contracts  = parseInt(get(cols, 'contracts') || '1');

    const rowRef = `Row ${i+1}: ${line.slice(0,50)}`;

    // ── Lot-row handling ──────────────────────────────────────────────────
    // Stock Purchase / CSP Assignment / Called Away produce lot records, not trades
    if (strategy && LOT_ROW_STRATEGIES.has(strategy)) {
      const nd = s => {
        if (!s) return null;
        const c = s.trim();
        if (/^\d{4}-\d{2}-\d{2}/.test(c)) return c.slice(0,10);
        const m = c.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
        if (m) { const yr=m[3].length===2?'20'+m[3]:m[3]; return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`; }
        return c.slice(0,10);
      };
      if (strategy === 'Stock Purchase') {
        // Outright share purchase — creates a new stock lot
        // contracts = number of shares, entry_price = price per share, entry_date = purchase date
        const shares   = parseInt(get(cols,'contracts') || '0');
        const avgCost  = getNum(cols,'entry_price');
        const purchDate = nd(get(cols,'entry_date'));
        if (!ticker || shares <= 0 || !avgCost || avgCost <= 0 || !purchDate) {
          skipped.push({ row: rowRef, reason: `Stock Purchase row requires ticker, contracts (shares), entry_price (avg cost), entry_date` });
          continue;
        }
        trades.push({
          _lotCreate: true,
          ticker: ticker.toUpperCase(),
          shares,
          avg_cost: avgCost,
          purchase_date: purchDate,
          notes: `Imported from Manual CSV · Stock Purchase${get(cols,'notes') ? ' · ' + get(cols,'notes') : ''}`,
        });
      } else if (strategy === 'CSP Assignment') {
        // CSP assigned — shares received at the put strike price
        // contracts = number of shares received (e.g. 200 for 2 contracts),
        // entry_price = avg cost per share (= put strike), exit_date = assignment date
        const shares   = parseInt(get(cols,'contracts') || '0');
        const avgCost  = getNum(cols,'entry_price');
        const purchDate = nd(get(cols,'exit_date') || get(cols,'entry_date'));
        if (!ticker || shares <= 0 || !avgCost || avgCost <= 0 || !purchDate) {
          skipped.push({ row: rowRef, reason: `CSP Assignment row requires ticker, contracts (shares), entry_price (avg cost per share), exit_date (assignment date)` });
          continue;
        }
        trades.push({
          _lotCreate: true,
          ticker: ticker.toUpperCase(),
          shares,
          avg_cost: avgCost,
          purchase_date: purchDate,
          notes: `Imported from Manual CSV · CSP Assignment${get(cols,'notes') ? ' · ' + get(cols,'notes') : ''}`,
        });
      } else if (strategy === 'Called Away') {
        // CC called away — shares sold at the call strike price, lot is closed
        // exit_price = price per share received, exit_date = called away date
        const closePrice = getNum(cols,'exit_price');
        const closeDate  = nd(get(cols,'exit_date'));
        if (!ticker || !closePrice || closePrice <= 0 || !closeDate) {
          skipped.push({ row: rowRef, reason: `Called Away row requires ticker, exit_price (price per share), exit_date` });
          continue;
        }
        trades.push({
          _lotClose: true,
          lot_ticker: ticker.toUpperCase(),
          lot_close_price: closePrice,
          lot_close_date: closeDate,
          notes: `Imported from Manual CSV · Called Away${get(cols,'notes') ? ' · ' + get(cols,'notes') : ''}`,
        });
      }
      continue; // lot rows never fall through to option trade processing
    }

    // ── Required field validation ──────────────────────────────────────────
    if (!strategy) { skipped.push({ row: rowRef, reason: 'strategy is required' }); continue; }
    if (!VALID_STRATEGIES.has(strategy)) {
      skipped.push({ row: rowRef, reason: `Unknown strategy: "${strategy}" — must match exactly (case-sensitive). Lot rows use: Stock Purchase, CSP Assignment, Called Away` });
      continue;
    }
    if (!['open','closed'].includes(status)) {
      skipped.push({ row: rowRef, reason: `status must be "open" or "closed", got "${status}"` });
      continue;
    }
    if (!entry_date) { skipped.push({ row: rowRef, reason: 'entry_date is required' }); continue; }
    if (!expiration)  { skipped.push({ row: rowRef, reason: 'expiration is required' }); continue; }
    if (!entry_price || entry_price <= 0) {
      skipped.push({ row: rowRef, reason: `entry_price must be > 0, got "${get(cols, 'entry_price')}"` });
      continue;
    }
    if (isNaN(contracts) || contracts < 1) {
      skipped.push({ row: rowRef, reason: `contracts must be an integer >= 1, got "${get(cols, 'contracts')}"` });
      continue;
    }

    // ── Optional / conditional fields ─────────────────────────────────────
    const strike_sell    = getNum(cols, 'strike_sell');
    const strike_buy     = getNum(cols, 'strike_buy');
    const exit_price     = getNum(cols, 'exit_price');
    const exit_date      = get(cols, 'exit_date');
    const pnl            = getNum(cols, 'pnl');
    const expiration_back = get(cols, 'expiration_back');
    const option_type    = (get(cols, 'option_type') || '').toLowerCase() || null;
    const lot_id_raw     = get(cols, 'lot_id');
    const lot_id         = lot_id_raw ? parseInt(lot_id_raw) : null;
    const delta          = getNum(cols, 'delta');
    const gamma          = getNum(cols, 'gamma');
    const theta          = getNum(cols, 'theta');
    const vega           = getNum(cols, 'vega');
    const iv_entry       = getNum(cols, 'iv_entry');
    const notes          = get(cols, 'notes');

    // ── Conditional validation ────────────────────────────────────────────
    if (status === 'closed' && exit_price === null) {
      skipped.push({ row: rowRef, reason: 'exit_price is required when status = closed' });
      continue;
    }
    if (status === 'closed' && !exit_date) {
      skipped.push({ row: rowRef, reason: 'exit_date is required when status = closed' });
      continue;
    }
    if (CAL_DIAG.has(strategy) && !expiration_back) {
      skipped.push({ row: rowRef, reason: `expiration_back is required for ${strategy}` });
      continue;
    }
    if (CAL_DIAG.has(strategy) && !option_type) {
      skipped.push({ row: rowRef, reason: `option_type ("call" or "put") is required for ${strategy}` });
      continue;
    }
    if (CAL_DIAG.has(strategy) && !['call','put'].includes(option_type)) {
      skipped.push({ row: rowRef, reason: `option_type must be "call" or "put" for ${strategy}, got "${option_type}"` });
      continue;
    }

    // ── Normalise dates ───────────────────────────────────────────────────
    const nd = s => {
      if (!s) return null;
      const clean = s.trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(clean)) return clean.slice(0,10);
      const m = clean.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
      if (m) {
        const yr = m[3].length === 2 ? '20'+m[3] : m[3];
        return `${yr}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
      }
      return clean.slice(0,10);
    };

    trades.push({
      ticker:          ticker.toUpperCase(),
      strategy,
      status,
      entry_date:      nd(entry_date),
      expiration:      nd(expiration),
      entry_price,
      contracts,
      strike_sell:     strike_sell || null,
      strike_buy:      strike_buy  || null,
      exit_price:      status === 'closed' ? exit_price : null,
      exit_date:       status === 'closed' ? nd(exit_date) : null,
      pnl:             pnl !== null ? pnl : null,
      expiration_back: nd(expiration_back),
      option_type:     option_type || null,
      lot_id:          lot_id || null,
      delta:           delta   || null,
      gamma:           gamma   || null,
      theta:           theta   || null,
      vega:            vega    || null,
      iv_entry:        iv_entry || null,
      notes:           notes ? `Imported from Manual CSV · ${notes}` : 'Imported from Manual CSV',
    });
  }

  return { trades, skipped };
}


const PARSERS = { Schwab: parseSchwab, Tastytrade: parseTastytrade, IBKR: parseIBKR, Robinhood: parseRobinhood, Manual: parseManual };
const BROKER_ICONS = { Schwab: '🏦', Tastytrade: '🌶️', IBKR: '📊', Robinhood: '🪶', Manual: '📋' };
const BROKER_INSTRUCTIONS = {
  Schwab:     'Go to Accounts → History → Export. Select date range and export as CSV.',
  Tastytrade: 'Go to Account History → Transactions. Click Export and download CSV.',
  IBKR:       'Go to Reports → Activity → Create Statement. Select CSV format.',
  Robinhood:  'Go to Account → History → Export CSV from the web interface.',
  Manual:     'Your own spreadsheet CSV. Columns can be in any order — the app identifies them by name. Download the sample file to see the required format, then replace the sample rows with your own trades.',
};

// Migration resource paths — routed through the backend so Electron can serve
// binary .docx files with correct Content-Disposition headers.
// getBase() is defined below; we wrap in a function so it evaluates at runtime.
function getMigrationResources() {
  const base = getBase();
  return {
    Schwab: {
      guide:  `${base}/api/migration/Schwab_Migration_Guide.docx`,
      sample: `${base}/api/migration/schwab-sample.csv`,
      note:   'Spend 10–15 minutes rearranging your export before uploading. The guide shows exactly how to group entries by ticker and add END markers so the parser can reconstruct your full wheel history automatically.',
    },
    IBKR: {
      guide:  `${base}/api/migration/IBKR_Migration_Guide.docx`,
      sample: `${base}/api/migration/ibkr-sample.csv`,
      note:   'IBKR uses Code fields (O/C/A/Ep) instead of action names. The guide explains the format and how to arrange your Flex Query export with END markers for clean wheel reconstruction.',
    },
    Robinhood: {
      guide:  `${base}/api/migration/Robinhood_Migration_Guide.docx`,
      sample: `${base}/api/migration/robinhood-sample.csv`,
      note:   'Robinhood uses Trans Codes (STO/BTO/OEXP/OASGN). The guide shows how to group entries by ticker with END markers. Note: Robinhood exports are limited to 12 months at a time.',
    },
    Tastytrade: {
      guide:  `${base}/api/migration/Tastytrade_Migration_Guide.docx`,
      sample: `${base}/api/migration/tastytrade-sample.csv`,
      note:   'Tastytrade uses Type + Sub Type columns. Receive Deliver rows handle Expiration, Assignment, and Exercise events automatically. Group entries by ticker with END markers between lots.',
    },
    Manual: {
      guide:  `${base}/api/migration/Manual_Migration_Guide.docx`,
      sample: `${base}/api/migration/manual-sample.csv`,
      note:   'Your own spreadsheet CSV. Download the guide for the full field specification including the END marker convention, or download the sample CSV to see all 14 strategies already formatted and ready to fill in.',
    },
  };
}

function getBase() {
  if (typeof window === 'undefined') return '';
  const p = window.location.protocol;
  if (p === 'app:' || p === 'file:') {
    const port = window.__BACKEND_PORT__ || 3002;
    return `http://127.0.0.1:${port}`;
  }
  // Browser (Scenario 1 — npm start) — backend always on 3002
  if (p === 'http:' || p === 'https:') {
    return `http://127.0.0.1:3002`;
  }
  return '';
}

// ── PreviewPanel — separate component so useState toggles re-render correctly ─
function PreviewPanel({ preview, lots, dup, dupeCount, dupeList, skipped,
  showSkipped, setShowSkipped, showDupes, setShowDupes,
  showActions, setShowActions,
  lotCreateCount, lotCloseCount,
  file, hash, broker, onImport, onChooseDifferent }) {

  const CC_STRATEGIES = ['Covered Call', 'Bear Call Spread', 'Bull Call Spread'];
  const openLots = (lots || []).filter(l => !l.close_date);

  // Detect event rows that need post-import action
  const actionRows = preview
    .map((t, idx) => ({ ...t, _idx: idx }))
    .filter(t => /· (Expired|Assigned|Exercise) ·/.test(t.notes));

  // Per-event metadata for display
  function eventMeta(trade) {
    if (trade.notes.includes('· Assigned ·')) return {
      icon: '⚠️',
      color: 'var(--red)',
      bg:    'var(--red-bg,  #fff0f0)',
      border:'var(--red-border, #f5c6c6)',
      label: 'Assigned',
      action: trade.notes.includes('Called Away')
        ? 'Use Called Away button after import — this may be a CC called away'
        : 'Use Assignment or Called Away button after import — cannot determine from CSV alone',
    };
    if (trade.notes.includes('· Expired ·')) return {
      icon: '⏰',
      color: 'var(--text-secondary)',
      bg:    'var(--bg-secondary)',
      border:'var(--border)',
      label: 'Expired worthless',
      action: trade.notes.includes('Long Call') || trade.notes.includes('Long Put')
        ? 'If this was a Long option — delete and use the Expired button manually'
        : 'Imported as closed at $0 — verify it was a short option',
    };
    return {
      icon: '⚡',
      color: 'var(--amber)',
      bg:    'var(--amber-bg)',
      border:'var(--amber-border)',
      label: 'Exercise',
      action: 'Long option exercised — verify shares received/delivered and record manually',
    };
  }

  function previewLotMatch(trade) {
    if (![...CC_STRATEGIES, 'Cash-Secured Put'].includes(trade.strategy)) return null;
    const tickerLots = openLots.filter(l => l.ticker?.toUpperCase() === trade.ticker?.toUpperCase());
    if (tickerLots.length === 0) return { status: 'none', label: '— no lot' };
    if (tickerLots.length === 1) return { status: 'auto', label: '✓ auto-linked' };
    const contractShares = (trade.contracts || 1) * 100;
    const sizeMatches = tickerLots.filter(l => Math.round(l.shares) === contractShares);
    if (sizeMatches.length === 1) return { status: 'size', label: '✓ size match' };
    return { status: 'ambiguous', label: `⚠ ${tickerLots.length} lots` };
  }

  const autoLinked  = preview.filter(t => { const m = previewLotMatch(t); return m?.status === 'auto' || m?.status === 'size'; }).length;
  const needsReview = preview.filter(t => { const m = previewLotMatch(t); return m?.status === 'ambiguous'; }).length;
  const noLot       = preview.filter(t => { const m = previewLotMatch(t); return m?.status === 'none'; }).length;

  // Empty state — file parsed but all rows were dupes or nothing to import
  if (preview.length === 0) {
    return (
      <div>
        <div style={{ padding: '32px 16px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📭</div>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8, color: 'var(--text-primary)' }}>
            No new trades found
          </div>
          <div style={{ fontSize: 13, marginBottom: 16 }}>
            {dupeCount > 0
              ? `All ${dupeCount} trade${dupeCount === 1 ? '' : 's'} in this file already exist in your Trade Log.`
              : skipped.length > 0
                ? `The file was parsed but all ${skipped.length} row${skipped.length === 1 ? '' : 's'} were skipped. Check the details below.`
                : 'The file appears to be empty or the format was not recognised. Try a different broker selection.'}
          </div>
          {skipped.length > 0 && (
            <div>
              <button className="btn btn-outline" style={{ fontSize: 12, marginBottom: 10 }}
                onClick={() => setShowSkipped(s => !s)}>
                {showSkipped ? 'Hide' : 'Show'} {skipped.length} skipped row{skipped.length === 1 ? '' : 's'}
              </button>
              {showSkipped && (
                <div style={{ textAlign: 'left', background: 'var(--bg-secondary)',
                  borderRadius: 6, padding: '8px 12px', fontSize: 12, maxHeight: 200, overflowY: 'auto' }}>
                  {skipped.map((s, i) => (
                    <div key={i} style={{ padding: '3px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: '#e74c3c', marginRight: 6 }}>✗</span>
                      {s.reason || s.row || String(s)}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onChooseDifferent}>← Choose Different File</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {dup && (
        <div className="alert alert-amber">⚠️ This exact file has been imported before. Showing only new trades not already in your diary.</div>
      )}

      {/* Lot create / close summary */}
      {(lotCreateCount > 0 || lotCloseCount > 0) && (
        <div style={{ display:'flex', gap:8, marginBottom:8, flexWrap:'wrap' }}>
          {lotCreateCount > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px',
              background:'var(--green-bg)', border:'1px solid var(--green-border)',
              borderRadius:6, fontSize:12, color:'var(--green)', fontWeight:600 }}>
              🏦 {lotCreateCount} stock lot{lotCreateCount !== 1 ? 's' : ''} will be created
            </div>
          )}
          {lotCloseCount > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px',
              background:'var(--accent-light)', border:'1px solid var(--blue-border)',
              borderRadius:6, fontSize:12, color:'var(--accent)', fontWeight:600 }}>
              📤 {lotCloseCount} stock lot{lotCloseCount !== 1 ? 's' : ''} will be closed (called away / sold)
            </div>
          )}
        </div>
      )}

      {/* FIX 2 — Skipped rows collapsible */}
      {skipped.length > 0 && (
        <div style={{ marginBottom: 8, border: '1px solid var(--amber-border)', borderRadius: 6, overflow: 'hidden' }}>
          <div onClick={() => setShowSkipped(v => !v)}
            style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'7px 12px', background:'var(--amber-bg)', cursor:'pointer', userSelect:'none' }}>
            <span style={{ fontSize:12, fontWeight:600, color:'var(--amber)' }}>
              ⚠ {skipped.length} row{skipped.length !== 1 ? 's' : ''} skipped — could not be parsed
            </span>
            <span style={{ fontSize:11, color:'var(--amber)' }}>{showSkipped ? '▲ hide' : '▼ show'}</span>
          </div>
          {showSkipped && (
            <div style={{ background:'var(--bg-primary)', padding:'6px 0' }}>
              {skipped.map((s, i) => (
                <div key={i} style={{ display:'flex', gap:8, padding:'4px 12px', fontSize:11,
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                  <span style={{ color:'var(--amber)', fontWeight:600, flexShrink:0 }}>Row {i+1}:</span>
                  <span style={{ color:'var(--text-secondary)', flexShrink:0 }}>{s.reason}</span>
                  <span style={{ color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:10,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{s.row}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Action Required panel — Expired / Assigned / Exercise rows */}
      {actionRows.length > 0 && (
        <div style={{ marginBottom: 8, border: '1px solid var(--red-border, #f5c6c6)', borderRadius: 6, overflow: 'hidden' }}>
          <div onClick={() => setShowActions(v => !v)}
            style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'7px 12px', background:'var(--red-bg, #fff0f0)', cursor:'pointer', userSelect:'none' }}>
            <span style={{ fontSize:12, fontWeight:600, color:'var(--red, #c0392b)' }}>
              ⚠️ {actionRows.length} row{actionRows.length !== 1 ? 's' : ''} need post-import action — Assigned / Expired / Exercise
            </span>
            <span style={{ fontSize:11, color:'var(--red, #c0392b)' }}>{showActions ? '▲ hide' : '▼ show'}</span>
          </div>
          {showActions && (
            <div style={{ background:'var(--bg-primary)', padding:'6px 0' }}>
              {actionRows.map((t, i) => {
                const meta = eventMeta(t);
                const strike = t.strike_sell || t.strike_buy;
                return (
                  <div key={i} style={{ display:'grid', gridTemplateColumns:'22px 52px 160px 90px 80px 1fr',
                    alignItems:'center', gap:8, padding:'6px 12px', fontSize:11,
                    borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                    <span style={{ fontSize:14 }}>{meta.icon}</span>
                    <span style={{ fontWeight:700, color:'var(--text-primary)', fontFamily:'var(--font-mono)' }}>{t.ticker}</span>
                    <span style={{ display:'inline-block', padding:'1px 7px', borderRadius:4,
                      background:meta.bg, border:`1px solid ${meta.border}`,
                      color:meta.color, fontWeight:600, whiteSpace:'nowrap' }}>{meta.label}</span>
                    <span style={{ color:'var(--text-muted)' }}>exp {t.expiration}</span>
                    <span style={{ color:'var(--text-muted)', fontFamily:'var(--font-mono)' }}>{strike ? `$${strike}` : '—'}</span>
                    <span style={{ color:'var(--text-secondary)', lineHeight:1.4 }}>{meta.action}</span>
                  </div>
                );
              })}
              <div style={{ padding:'6px 12px 4px', borderTop:'1px solid var(--border)',
                fontSize:11, color:'var(--text-muted)', fontStyle:'italic' }}>
                These rows are included in the import. Use the buttons noted above in Trade Log after confirming.
              </div>
            </div>
          )}
        </div>
      )}

      {/* FIX 1 — Duplicates collapsible */}
      {dupeCount > 0 && (
        <div style={{ marginBottom: 8, border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden' }}>
          <div onClick={() => setShowDupes(v => !v)}
            style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
              padding:'7px 12px', background:'var(--bg-secondary)', cursor:'pointer', userSelect:'none' }}>
            <span style={{ fontSize:12, color:'var(--text-muted)' }}>
              🔍 {dupeCount} trade{dupeCount !== 1 ? 's' : ''} already in your diary — not imported
            </span>
            <span style={{ fontSize:11, color:'var(--text-muted)' }}>{showDupes ? '▲ hide' : '▼ show'}</span>
          </div>
          {showDupes && (
            <div style={{ background:'var(--bg-primary)', padding:'6px 0' }}>
              {dupeList.map((t, i) => (
                <div key={i} style={{ display:'flex', gap:12, padding:'4px 12px', fontSize:11,
                  borderTop: i > 0 ? '1px solid var(--border)' : 'none', color:'var(--text-secondary)' }}>
                  <span style={{ fontWeight:700, color:'var(--text-primary)', minWidth:48 }}>{t.ticker}</span>
                  <span style={{ minWidth:120 }}>{t.strategy}</span>
                  <span>{t.entry_date || '—'}</span>
                  <span>exp {t.expiration || '—'}</span>
                  <span style={{ fontFamily:'var(--font-mono)' }}>{t.entry_price != null ? `$${t.entry_price}` : '—'}</span>
                  <span style={{ color:'var(--text-muted)', fontStyle:'italic' }}>already exists</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Lot match summary */}
      {(autoLinked > 0 || needsReview > 0) && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
          {autoLinked > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', background:'var(--green-bg)', border:'1px solid var(--green-border)', borderRadius:6, fontSize:12, color:'var(--green)', fontWeight:600 }}>
              ✓ {autoLinked} trade{autoLinked !== 1 ? 's' : ''} auto-linked to lots
            </div>
          )}
          {needsReview > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', background:'var(--amber-bg)', border:'1px solid var(--amber-border)', borderRadius:6, fontSize:12, color:'var(--amber)', fontWeight:600 }}>
              ⚠ {needsReview} trade{needsReview !== 1 ? 's' : ''} need manual linking
            </div>
          )}
          {noLot > 0 && (
            <div style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 10px', background:'var(--bg-secondary)', border:'1px solid var(--border)', borderRadius:6, fontSize:12, color:'var(--text-muted)' }}>
              {noLot} with no matching lot
            </div>
          )}
        </div>
      )}

      <div style={{ marginBottom: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
        {preview.length} trade{preview.length !== 1 ? 's' : ''} found in <strong>{file?.name}</strong>
      </div>
      <div style={{ maxHeight: 280, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
        <table>
          <thead>
            <tr>
              <th>Ticker</th><th>Strategy</th><th>Status</th><th>Entry Date</th><th>Expiry</th><th>Entry Px</th><th>Qty</th><th>P&L</th><th>Lot Link</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((t, i) => {
              const match = previewLotMatch(t);
              const matchColor = match?.status === 'auto' || match?.status === 'size' ? 'var(--green)'
                : match?.status === 'ambiguous' ? 'var(--amber)' : 'var(--text-muted)';
              // FIX 3 — compute warnings before return
              const rowWarnings = [];
              if (t.status === 'open' && (t.entry_price === 0 || t.entry_price === null || t.entry_price === '0'))
                rowWarnings.push('Entry price is $0.00 on an open trade — check the premium value in your broker export');
              const ep = parseFloat(t.entry_price), xp = parseFloat(t.exit_price);
              if (t.status === 'closed' && !isNaN(ep) && !isNaN(xp) && ep > 0 && xp > ep * 5)
                rowWarnings.push(`Exit price $${xp} is more than 5× entry $${ep} — verify this is correct`);
              return (
                <React.Fragment key={i}>
                  <tr>
                    <td style={{ fontFamily:'var(--font-mono)', fontWeight:700 }}>{t.ticker}</td>
                    <td><span className="badge badge-blue">{t.strategy}</span></td>
                    <td><span style={{ fontSize:10, padding:'1px 6px', borderRadius:4, background: t.status === 'open' ? 'var(--green-bg)' : 'var(--bg-secondary)', color: t.status === 'open' ? 'var(--green)' : 'var(--text-muted)', fontWeight:600 }}>{t.status}</span></td>
                    <td style={{ fontSize:12 }}>{t.entry_date || '—'}</td>
                    <td style={{ fontSize:12 }}>{t.expiration || '—'}</td>
                    <td style={{ fontFamily:'var(--font-mono)' }}>{t.entry_price != null ? '$'+t.entry_price : '—'}</td>
                    <td style={{ fontFamily:'var(--font-mono)' }}>{t.contracts}</td>
                    <td style={{ fontFamily:'var(--font-mono)', fontSize:12,
                      color: t.pnl != null ? (t.pnl >= 0 ? 'var(--green)' : 'var(--red)') : 'var(--text-muted)',
                      fontWeight: t.pnl != null ? 600 : 400 }}>
                      {t.pnl != null ? `${t.pnl >= 0 ? '+' : ''}$${t.pnl}` : '—'}
                    </td>
                    <td style={{ fontSize:11, color:matchColor, fontWeight: match?.status === 'auto' || match?.status === 'size' ? 600 : 400 }}>
                      {match?.label || '—'}
                    </td>
                  </tr>
                  {rowWarnings.length > 0 && (
                    <tr>
                      <td colSpan={9} style={{ padding:'3px 10px', background:'var(--amber-bg)',
                        borderBottom:'1px solid var(--amber-border)', fontSize:11, color:'var(--amber)' }}>
                        ⚠ {rowWarnings.join(' · ')}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="modal-footer">
        <button className="btn btn-outline" onClick={onChooseDifferent}>← Choose Different File</button>
        <button
          className="btn btn-primary"
          onClick={() => onImport(preview, hash, file?.name, broker)}
          disabled={preview.length === 0}
          title={preview.length === 0 ? 'No new trades to import' : ''}
        >{preview.length > 0 ? `Import ${preview.length} Trade${preview.length === 1 ? '' : 's'}` : 'Nothing to Import'}</button>
      </div>
    </div>
  );
}

export default function ImportModal({ isMock, onImport, onClose, lots, existingTrades }) {
  const [step,       setStep]       = useState(0);
  const [broker,     setBroker]     = useState('');
  const [file,       setFile]       = useState(null);
  const [preview,    setPreview]    = useState([]);
  const [dupeCount,  setDupeCount]  = useState(0);
  const [dupeList,   setDupeList]   = useState([]);
  const [skipped,    setSkipped]    = useState([]);
  const [showDupes,  setShowDupes]  = useState(false);
  const [showSkipped,setShowSkipped]= useState(false);
  const [showActions,setShowActions]= useState(true);   // default open so user can't miss it
  const [hash,       setHash]       = useState('');
  const [dup,        setDup]        = useState(false);
  const [lotCreateCount, setLotCreateCount] = useState(0);
  const [lotCloseCount,  setLotCloseCount]  = useState(0);
  const [dragOver,   setDragOver]   = useState(false);
  const fileRef = useRef();

  async function processFile(f) {
    setFile(f);
    const text = await f.text();
    const h    = await sha256(text);
    setHash(h);
    // Check for duplicate file
    if (!isMock) {
      try {
        const res = await fetch(getBase() + '/api/import-history/' + h);
        if (res.ok) { const d = await res.json(); if (d) { setDup(true); } }
      } catch {}
    }
    // Parse raw trades — now returns {trades, skipped}
    const parseResult = PARSERS[broker] ? PARSERS[broker](text) : { trades: [], skipped: [] };
    const raw         = parseResult.trades  || [];
    const skippedRows = parseResult.skipped || [];
    // Separate lot-create / lot-close rows from option trade rows
    const lotCreates  = raw.filter(t => t._lotCreate && !t.strategy);
    const lotCloses   = raw.filter(t => t._lotClose  && !t.strategy);
    // Split: event rows (expired/assigned/called_away) vs plain option rows
    const eventRows   = raw.filter(t => t._event && !t._endMarker);
    // pureLotRows: stock purchase/sale rows with NO strategy and NO _event (TT/IBKR/RH outright buys)
    // These pass straight through to preview — handleImport Step 1/2 handles them.
    const pureLotRows = raw.filter(t => !t._endMarker && !t._event && (t._lotCreate || t._lotClose) && !t.strategy);
    const tradeOnly   = raw.filter(t => !t._endMarker && !t._event && !t._lotCreate && !t._lotClose);

    // ── Merge event rows with their matching open trades ────────────────────
    // An open STO + its matching Assigned/Expired/Called Away event = ONE closed trade.
    // Without merging, the open trade stays as status='open' with a past expiry and the
    // backend rejects it. Merging produces a single clean closed record with entry AND exit.
    const usedEventIdx  = new Set();
    const usedTradeIdx  = new Set();
    const mergedRecords = [];

    tradeOnly.forEach((open, ti) => {
      if (open.status !== 'open') return;
      const openStrike = open.strike_sell || open.strike_buy || 0;
      // Find a matching event row: same ticker, same expiry, same strike, compatible strategy
      const evIdx = eventRows.findIndex((ev, ei) => {
        if (usedEventIdx.has(ei)) return false;
        const evStrike = ev.strike_sell || ev.strike_buy || 0;
        return (
          ev.ticker     === open.ticker     &&
          ev.expiration === open.expiration &&
          Math.abs(evStrike - openStrike) < 0.5 &&
          ev.strategy   === open.strategy
        );
      });
      if (evIdx === -1) return; // no matching event — open stays as-is
      const ev = eventRows[evIdx];
      usedEventIdx.add(evIdx);
      usedTradeIdx.add(ti);
      // Merge: use open's entry data + event's exit data = one closed trade
      mergedRecords.push({
        ...open,
        status:     'closed',
        exit_price: ev.exit_price ?? 0,
        exit_date:  ev.exit_date  || open.expiration,
        pnl:        null,            // handleImport will calculate
        _event:     ev._event,       // keep event type for lot operations
        _lotCreate: ev._lotCreate || undefined,
        _lotClose:  ev._lotClose  || undefined,
        lot_ticker:      ev.lot_ticker,
        lot_shares:      ev.lot_shares,
        lot_avg_cost:    ev.lot_avg_cost,
        lot_purchase_date: ev.lot_purchase_date,
        lot_close_price: ev.lot_close_price,
        lot_close_date:  ev.lot_close_date,
        notes: (open.notes || '') + ' · ' + (ev.notes || ev._event),
      });
    });

    // Remaining open trades that had no event match (still genuinely open)
    const remainingOpens = tradeOnly.filter((_, i) => !usedTradeIdx.has(i) && tradeOnly[i].status === 'open');
    // Closes that were not involved in a merge (standalone BTC rows etc.)
    const remainingCloses = tradeOnly.filter(t => t.status === 'closed');
    // Event rows that had no matching open (standalone events — rare edge case)
    const orphanEvents = eventRows.filter((_, i) => !usedEventIdx.has(i));

    // Pair remaining open/close rows (no events involved)
    // pureLotRows pass through directly — they are handled by handleImport Step 1/2
    const paired = [
      ...pairOpenClose([...remainingOpens, ...remainingCloses]),
      ...mergedRecords,
      ...orphanEvents,
      ...pureLotRows,
    ];
    // Deduplicate against existing trades + within batch
    const { unique, dupes } = deduplicateTrades(paired, existingTrades || []);
    setDupeCount(dupes.length);
    setDupeList(dupes);
    setSkipped(skippedRows);
    setLotCreateCount(lotCreates.length);
    setLotCloseCount(lotCloses.length);
    setPreview(unique);
    setStep(4);  // always advance to Preview step
  }

  const steps = ['Method', 'Broker', 'Instructions', 'Upload', 'Preview'];

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>Import Trades from CSV</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        {/* Step indicators */}
        <div className="step-indicator">
          {steps.map((s, i) => (
            <React.Fragment key={s}>
              <div className={`step-dot ${i < step ? 'done' : i === step ? 'active' : 'inactive'}`}>{i < step ? '✓' : i + 1}</div>
              {i < steps.length - 1 && <div className="step-line" />}
            </React.Fragment>
          ))}
        </div>

        {/* Step 0: Method */}
        {step === 0 && (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
              <div className="provider-card active" onClick={() => setStep(1)} style={{ border: '2px solid var(--accent)', background: 'var(--accent-light)' }}>
                <div style={{ fontSize: 24, marginBottom: 8 }}>📄</div>
                <div style={{ fontWeight: 700 }}>CSV Upload</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>Upload a CSV file exported from your broker</div>
              </div>
              <div className="provider-card disabled">
                <div style={{ fontSize: 24, marginBottom: 8 }}>🔗</div>
                <div style={{ fontWeight: 700 }}>Live Connection</div>
                <div className="badge badge-amber" style={{ marginTop: 4 }}>Coming Soon</div>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Broker */}
        {step === 1 && (
          <div>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 14, fontSize: 13 }}>Select your broker:</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {Object.keys(BROKER_ICONS).map(b => (
                <div key={b} className={`provider-card ${broker === b ? 'active' : ''}`} onClick={() => setBroker(b)}>
                  <span style={{ fontSize: 22 }}>{BROKER_ICONS[b]}</span>
                  <span style={{ fontWeight: 700, marginLeft: 10 }}>{b}</span>
                </div>
              ))}
            </div>

            {/* Migration resources card — shown for Schwab / IBKR / Robinhood */}
            {broker && getMigrationResources()[broker] && (() => {
              const res = getMigrationResources()[broker];
              return (
                <div style={{ marginTop: 16, background: 'var(--accent-light)',
                  border: '1px solid var(--blue-border)', borderRadius: 8, padding: '14px 16px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <span style={{ fontSize: 16 }}>📋</span>
                    <span style={{ fontWeight: 700, fontSize: 13, color: 'var(--accent)' }}>
                      {broker === 'Manual' ? 'Manual / Spreadsheet Import' : `${broker} Migration Guide`}
                    </span>
                    <span style={{ marginLeft: 'auto', background: 'var(--amber-bg)',
                      color: 'var(--amber)', border: '1px solid var(--amber-border)',
                      borderRadius: 10, fontSize: 10, fontWeight: 700, padding: '2px 8px' }}>
                      ONE-TIME ONLY
                    </span>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 12px 0', lineHeight: 1.5 }}>
                    {res.note}
                  </p>
                  <div style={{ display: 'flex', gap: 10 }}>
                    {res.guide && (
                      <a href={res.guide} download
                        style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                          background: 'var(--accent)', color: '#fff', borderRadius: 6,
                          padding: '6px 14px', fontSize: 12, fontWeight: 600,
                          textDecoration: 'none', cursor: 'pointer' }}>
                        📄 Download Guide
                      </a>
                    )}
                    <a href={res.sample} download
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6,
                        background: broker === 'Manual' ? 'var(--accent)' : 'var(--bg-secondary)',
                        color: broker === 'Manual' ? '#fff' : 'var(--text-primary)',
                        border: '1px solid var(--border)', borderRadius: 6,
                        padding: '6px 14px', fontSize: 12, fontWeight: 600,
                        textDecoration: 'none', cursor: 'pointer' }}>
                      {broker === 'Manual' ? '📋 Download Sample CSV' : '📥 Sample CSV'}
                    </a>
                  </div>
                </div>
              );
            })()}

            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setStep(0)}>← Back</button>
              <button className="btn btn-primary" disabled={!broker} onClick={() => setStep(2)}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 2: Instructions */}
        {step === 2 && (
          <div>
            <div className="alert alert-blue">
              <div>
                <strong>{BROKER_ICONS[broker]} {broker} Export Instructions</strong>
                <p style={{ marginTop: 6, fontSize: 13 }}>{BROKER_INSTRUCTIONS[broker]}</p>
                {broker === 'Manual' && (
                  <div style={{ marginTop: 8, padding: '8px 12px', background: 'var(--accent-light)',
                    border: '1px solid var(--blue-border)', borderRadius: 6, fontSize: 12 }}>
                    <strong>Column names must match exactly</strong> (case-insensitive): ticker, strategy,
                    status, entry_date, expiration, entry_price, contracts, strike_sell, strike_buy,
                    exit_price, exit_date, pnl, expiration_back, option_type, lot_id, delta, gamma,
                    theta, vega, iv_entry, notes. Columns can be in any order. END rows are ignored.
                  </div>
                )}
              </div>
            </div>
            <div style={{ background: 'var(--amber-bg)', border: '1px solid var(--amber-border)', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: 'var(--amber)', marginTop: 10 }}>
              💡 Tip: Export at least 30 days of history. The app will detect duplicates automatically.
            </div>
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setStep(1)}>← Back</button>
              <button className="btn btn-primary" onClick={() => setStep(3)}>Next →</button>
            </div>
          </div>
        )}

        {/* Step 3: Upload */}
        {step === 3 && (
          <div>
            <div
              className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
              onClick={() => fileRef.current.click()}
              onDragOver={e => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={e => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files[0]; if (f) processFile(f); }}
            >
              <div style={{ fontSize: 36, marginBottom: 10 }}>📂</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Drop your CSV file here</div>
              <div style={{ fontSize: 12.5 }}>or click to browse — accepts .csv and .txt</div>
            </div>
            <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: 'none' }} onChange={e => { if (e.target.files[0]) processFile(e.target.files[0]); }} />
            <div className="modal-footer">
              <button className="btn btn-outline" onClick={() => setStep(2)}>← Back</button>
            </div>
          </div>
        )}

        {/* Step 4: Preview */}
        {step === 4 && (
          <PreviewPanel
            preview={preview} lots={lots} dup={dup}
            dupeCount={dupeCount} dupeList={dupeList}
            skipped={skipped} showSkipped={showSkipped} setShowSkipped={setShowSkipped}
            showDupes={showDupes} setShowDupes={setShowDupes}
            showActions={showActions} setShowActions={setShowActions}
            lotCreateCount={lotCreateCount} lotCloseCount={lotCloseCount}
            file={file} hash={hash} broker={broker} onImport={onImport}
            onChooseDifferent={() => { setPreview([]); setFile(null); setDup(false); setDupeList([]); setSkipped([]); setShowDupes(false); setShowSkipped(false); setShowActions(true); setLotCreateCount(0); setLotCloseCount(0); }}
          />
        )}
      </div>
    </div>
  );
}
