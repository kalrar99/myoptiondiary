// src/utils/yahooQuotes.js
import { nearestExpiryFriday } from './tradingCalendar';
//
// Unofficial Yahoo Finance quote fetcher for users WITHOUT a live broker connection.
// Used as a best-effort price source before prompting manual entry.
//
// ARCHITECTURE:
//   1. Try Yahoo stock quote  → regularMarketPrice
//   2. Try Yahoo option chain → find matching strike/expiry → bid/ask mid, IV, delta
//   3. If either fails        → return null for that field (caller shows BS estimate)
//   4. Manual override        → user can always type their own value in Opt$/Stock$ inputs
//
// RELIABILITY NOTE:
//   Yahoo Finance is an unofficial API — no SLA, no auth token required.
//   It works reliably for stock prices (~95% uptime from browser).
//   Option chain data is less reliable (~70-80%) — sometimes returns empty chains
//   or rate-limits after many requests. We handle all failures silently.
//
// RATE LIMITING:
//   Stock quote:  ~2000 req/hr before soft throttle. We batch per unique ticker.
//   Option chain: Lower limit. We fetch one chain per ticker, then scan locally.
//   We add 200ms delay between chain requests to be a good citizen.
//
// CORS: Both endpoints work from the browser without a proxy in most regions.
//       Behind some corporate firewalls Yahoo may be blocked — we handle that gracefully.

const STOCK_CACHE  = {};  // { ticker: { price, fetchedAt } }
const OPTION_CACHE = {};  // { `${ticker}-${epochWeek}`: { chain, fetchedAt } }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// clearStockCache: invalidate stock price cache for specific tickers (or all).
// Call after any trade/lot save so next render fetches a fresh price.
export function clearStockCache(tickers) {
  if (!tickers || tickers.length === 0) {
    Object.keys(STOCK_CACHE).forEach(k => delete STOCK_CACHE[k]);
  } else {
    tickers.forEach(t => { if (t) delete STOCK_CACHE[t.toUpperCase()]; });
  }
}

// ── Lightweight Black-Scholes for BSM fallback pricing ───────────────────────
// Used when Yahoo has no chain data for a leg (e.g. far-out expiry, illiquid ticker).
// Same formula as TradeLog.jsx blackScholes() — kept in sync.
function bsmPrice(S, K, T, sigma, isCall) {
  if (!S || !K || !T || !sigma || T <= 0) return null;
  const r = 0.053; // risk-free rate
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const nd  = x => { // standard normal CDF
    const t = 1 / (1 + 0.2316419 * Math.abs(x));
    const d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.7814779 + t * (-1.8212560 + t * 1.3302744))));
    return x >= 0 ? 1 - p : p;
  };
  const val = isCall
    ? S * nd(d1) - K * Math.exp(-r * T) * nd(d2)
    : K * Math.exp(-r * T) * nd(-d2) - S * nd(-d1);
  return Math.max(0, Math.round(val * 100) / 100);
}

// ── Stock price ─────────────────────────────────────────────
// ── Backend proxy URL ───────────────────────────────────────
// Routes Yahoo calls through Node.js backend to avoid CORS/crumb issues in Electron.
// Falls back to direct browser call if backend unavailable.
function getBackendBase() {
  try { 
    const port = window.__BACKEND_PORT__ || 3002;
    return `http://127.0.0.1:${port}`;
  } catch { return 'http://localhost:3002'; }
}

export async function fetchStockPrice(ticker) {
  const t = ticker.toUpperCase();
  const now = Date.now();
  const cached = STOCK_CACHE[t];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.price;

  try {
    // Route through backend proxy — avoids CORS and Yahoo browser restrictions
    const res = await fetch(getBackendBase() + '/api/yahoo/stock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: t }),
      signal: AbortSignal.timeout(6000),
    });
    if (res.ok) {
      const data = await res.json();
      const price = data?.price;
      if (price && price > 0) {
        STOCK_CACHE[t] = { price, fetchedAt: now };
        return price;
      }
    }
  } catch { /* backend unavailable — fall through to direct */ }

  // Direct fallback (may not work in all Electron environments)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=1d&range=1d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json();
    const meta  = data?.chart?.result?.[0]?.meta;
    // regularMarketPrice is null on weekends — fall back to previousClose
    const price = meta?.regularMarketPrice || meta?.previousClose;
    if (price && price > 0) {
      STOCK_CACHE[t] = { price, fetchedAt: now };
      return price;
    }
  } catch { /* timeout, CORS, network */ }
  return null;
}

// ── Option quote (single strike/expiry) ─────────────────────
// Returns { mid, iv, delta, theta } or null on any failure.
// Yahoo option chain returns data for the nearest expiry Friday to the requested date.
export async function fetchOptionQuote(ticker, strikePrice, expirationDate, isCall) {
  if (!ticker || !strikePrice || !expirationDate) return null;
  const t       = ticker.toUpperCase();
  const strike  = parseFloat(strikePrice);
  const expUnix = Math.floor(new Date(expirationDate).getTime() / 1000);
  // Cache key: ticker + week bucket (options expire weekly — round to nearest week)
  const weekBucket = Math.floor(expUnix / (7 * 86400));
  const cacheKey   = `${t}-${weekBucket}`;

  let chain = null;
  const now = Date.now();
  const cached = OPTION_CACHE[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    chain = cached.chain;
  } else {
    // Try backend proxy first
    try {
      const res = await fetch(getBackendBase() + '/api/yahoo/option', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t, strike, expiration: expirationDate, isCall }),
        signal: AbortSignal.timeout(6000),
      });
      if (res.ok) {
        const q = await res.json();
        if (q?.mid != null && q.mid > 0) return q; // backend already parsed — return directly
      }
    } catch { /* backend unavailable — fall through */ }

    // Direct fallback
    try {
      const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(t)}?date=${expUnix}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      const result = data?.optionChain?.result?.[0];
      if (!result) return null;
      chain = result.options?.[0];
      if (chain) OPTION_CACHE[cacheKey] = { chain, fetchedAt: now };
    } catch { return null; }
  }

  if (!chain) return null;

  // Scan the correct leg (calls or puts) for the matching strike
  const legs = isCall ? (chain.calls || []) : (chain.puts || []);
  // Find the strike closest to requested (Yahoo may not have exact strikes for all tickers)
  const best = legs.reduce((prev, cur) => {
    const dPrev = Math.abs((prev?.strike || Infinity) - strike);
    const dCur  = Math.abs((cur?.strike  || Infinity) - strike);
    return dCur < dPrev ? cur : prev;
  }, null);

  if (!best) return null;
  // Only use if the strike is within $2.50 of requested (avoid wrong-strike data)
  if (Math.abs((best.strike || 0) - strike) > 2.5) return null;

  const bid = best.bid || 0;
  const ask = best.ask || 0;
  // No live market (bid=ask=0): market is closed or strike is illiquid.
  // lastPrice is a stale last-trade price — unreliable for spread pricing.
  // Return null so the BSM fallback fires with a correct estimate instead.
  // This prevents stale Friday last-prices producing wildly wrong unrealised P&L
  // on weekends (e.g. -$986 instead of -$295 for a SPY IC spread).
  if (bid === 0 && ask === 0) return null;
  // Use mid-price; fall back to lastPrice only when one side is missing
  const mid = (bid > 0 && ask > 0)
    ? (bid + ask) / 2
    : (best.lastPrice || 0);

  if (mid <= 0) return null;

  return {
    mid:   Math.round(mid * 100) / 100,
    iv:    best.impliedVolatility ? Math.round(best.impliedVolatility * 1000) / 10 : null, // as %
    delta: best.delta ?? null,
    theta: best.theta ?? null,
  };
}

// ── Batch fetch for all open trades ─────────────────────────
// Returns a currentPrices-compatible object:
//   { [tradeId]: { stock, option, iv, delta }, [ticker]: { stock } }
//
// Strategies with stored strikes + expiry: try full quote (stock + option).
// Strategies without a usable option quote (IC, IB, Straddle, Calendar): stock only.
//
// status: 'loading' | 'partial' | 'complete' | 'failed'
// ── Strategy direction helpers ───────────────────────────────
// Returns an array of { strike, isCall, expiry } fetch descriptors for a trade.
// Each descriptor becomes one Yahoo option quote call.
// Complex strategies (IC, Cal, Straddle) return multiple descriptors.
function getOptionFetchDescriptors(trade) {
  const strat = trade.strategy;
  const exp   = trade.expiration;
  const ss    = parseFloat(trade.strike_sell);
  const sb    = parseFloat(trade.strike_buy);
  if (!exp) return [];

  // ── Single-leg credit/debit strategies ──────────────────
  // ── Single-leg strategies: CC, CSP, Long Call/Put ──────────────
  if (['Covered Call','Long Call'].includes(strat)) {
    const strike = ss || sb;
    if (!strike) return [];
    return [{ strike, isCall: true, expiry: exp }];
  }
  if (['Cash-Secured Put','Long Put'].includes(strat)) {
    const strike = sb || ss;
    if (!strike) return [];
    return [{ strike, isCall: false, expiry: exp }];
  }

  // ── 2-leg spread strategies: fetch both legs, return net spread ──
  // Net spread price = short_leg_mid − long_leg_mid (always the closing cost/value)
  // Bull Put Spread:  sell ss(high put),  buy sb(low put)   → short=ss, long=sb, isCall=false
  // Bear Call Spread: sell ss(low call),  buy sb(high call) → short=ss, long=sb, isCall=true
  // Bull Call Spread: buy sb(low call),   sell ss(high call)→ long=sb,  short=ss, isCall=true
  // Bear Put Spread:  buy sb(high put),   sell ss(low put)  → long=sb,  short=ss, isCall=false
  if (strat === 'Bull Put Spread' || strat === 'Bear Call Spread') {
    // Credit spreads: short=ss, long=sb
    const isCall = strat === 'Bear Call Spread';
    const descs = [];
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    return descs.length > 0 ? descs : [];
  }
  if (strat === 'Bull Call Spread' || strat === 'Bear Put Spread') {
    // Debit spreads: long=sb (the expensive leg you bought), short=ss (the cap you sold)
    const isCall = strat === 'Bull Call Spread';
    const descs = [];
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    return descs.length > 0 ? descs : [];
  }

  // ── IC / IB chain legs — each stored as a separate trade record ──
  // Each record has both strike_sell (short) and strike_buy (long wing).
  // We fetch BOTH legs so we can compute the NET spread premium:
  //   net spread = short_leg_mid − long_leg_mid
  // This is what you'd pay to close, and what goes into unrealised P&L.
  // condor_leg: 'put'  → fetch PUT  at strike_sell (short) + PUT  at strike_buy (long wing)
  // condor_leg: 'call' → fetch CALL at strike_sell (short) + CALL at strike_buy (long wing)
  // condor_leg: 'full' → Iron Butterfly body: sell at strike_sell, buy wings at strike_buy
  if (['Iron Condor','Iron Butterfly'].includes(strat)) {
    const leg    = trade.condor_leg;
    const isCall = (leg === 'call' || leg === 'full');
    const descs  = [];
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    return descs.length > 0 ? descs : [];
  }

  // ── Calendar Spread / Diagonal ───────────────────────────
  // cal_leg: 'short' → strike_sell, near expiry (trade.expiration)
  // cal_leg: 'long'  → strike_buy,  far expiry (trade.expiration_back || trade.expiration)
  // option_type: 'call' | 'put' — must be respected so put calendars/diagonals
  //   fetch the PUT chain, not the call chain. Mirrors backend buildTradierOptionSymbol.
  if (['Calendar Spread','Diagonal Spread'].includes(strat)) {
    const leg     = trade.cal_leg;
    const isCallOt = trade.option_type !== 'put'; // default call if not set (legacy)
    const expBack  = trade.expiration_back || exp;
    if (leg === 'short') {
      const strike = ss || sb;
      if (!strike) return [];
      return [{ strike, isCall: isCallOt, expiry: exp }];
    }
    if (leg === 'long') {
      const strike = sb || ss;
      if (!strike) return [];
      return [{ strike, isCall: isCallOt, expiry: expBack }];
    }
    // No cal_leg set (legacy or single-record calendar) — try strike_sell
    const strike = ss || sb;
    if (!strike) return [];
    return [{ strike, isCall: isCallOt, expiry: exp }];
  }

  // ── Long Straddle / Strangle ─────────────────────────────
  // Two legs: CALL at strike_sell + PUT at strike_buy
  // Store their average mid as the combined "option price"
  if (['Long Straddle','Long Strangle'].includes(strat)) {
    const descs = [];
    if (ss > 0) descs.push({ strike: ss, isCall: true,  expiry: exp, legKey: 'call' });
    if (sb > 0) descs.push({ strike: sb, isCall: false, expiry: exp, legKey: 'put'  });
    return descs;
  }

  return [];
}

export async function fetchYahooPrices(openTrades, onProgress) {
  const prices = {};
  const tickers = [...new Set(openTrades.map(t => t.ticker.toUpperCase()))];
  let done = 0;

  // Step 1: Batch stock prices (one call per ticker)
  await Promise.allSettled(tickers.map(async ticker => {
    const price = await fetchStockPrice(ticker);
    if (price) {
      prices[ticker] = { stock: price };
      openTrades.filter(t => t.ticker.toUpperCase() === ticker).forEach(t => {
        if (!prices[t.id]) prices[t.id] = {};
        prices[t.id].stock = price;
      });
    }
    done++;
    onProgress?.({ done, total: tickers.length + openTrades.length, stage: 'stocks' });
  }));

  // Step 2: Option quotes — pre-fetch chains once per (ticker+expiry+isCall) combination
  // then scan locally for each trade's strike. This avoids per-trade Yahoo calls
  // which trigger rate limits when many trades are open.
  const optionTrades = openTrades.filter(t => t.expiration);

  // Build a map of unique chain keys to fetch: "TICKER-EXPIRY-C/P"
  const chainCache = {}; // key → { calls: [], puts: [] } or null

  async function getChain(ticker, expiry, isCall) {
    const key = `${ticker.toUpperCase()}-${expiry}-${isCall ? 'C' : 'P'}`;
    // If completed result is cached, return immediately
    if (Array.isArray(chainCache[key])) return chainCache[key];
    // If a fetch is already in-flight (Promise), await it — don't fire duplicate requests.
    // Previously used null as in-flight marker which caused concurrent callers to get null
    // immediately and skip price population entirely.
    if (chainCache[key] instanceof Promise) return chainCache[key];

    // Start fetch, store Promise so any concurrent callers await the same request
    chainCache[key] = (async () => {
      try {
        const res = await fetch(getBackendBase() + '/api/yahoo/chain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticker: ticker.toUpperCase(), expiration: expiry, isCall }),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const result = await res.json();
          if (result?.options?.length > 0) {
            chainCache[key] = result.options;
            return chainCache[key];
          }
        }
      } catch { /* backend unavailable */ }

      // Direct fallback
      try {
        const result = await fetchOptionChainYahoo(ticker, expiry, isCall);
        if (result?.options?.length > 0) {
          chainCache[key] = result.options;
          return chainCache[key];
        }
      } catch { /* ignore */ }

      chainCache[key] = []; // cache empty result so we don't retry
      return [];
    })();

    return chainCache[key];
  }

  function findStrikeInChain(chain, targetStrike) {
    if (!chain || !chain.length) return null;
    // Adaptive tolerance: $5 for high-priced underlyings (>$200: SPY, NFLX, NVDA, TSLA, AAPL etc.)
    // $2.50 for cheaper stocks. Yahoo chains don't always have exact strikes for every $1 increment.
    const tolerance = targetStrike > 200 ? 5 : 2.5;
    let best = null, bestDiff = Infinity;
    chain.forEach(row => {
      const diff = Math.abs((row.strike || 0) - targetStrike);
      if (diff < bestDiff) { bestDiff = diff; best = row; }
    });
    return bestDiff <= tolerance ? best : null;
  }

  for (const trade of optionTrades) {
    const descs = getOptionFetchDescriptors(trade);
    if (descs.length === 0) {
      done++;
      onProgress?.({ done, total: tickers.length + optionTrades.length, stage: 'options' });
      continue;
    }

    if (!prices[trade.id]) prices[trade.id] = {};

    // Fetch chain(s) and scan for strike
    const legResults = {};
    for (const desc of descs) {
      const chain = await getChain(trade.ticker, desc.expiry, desc.isCall);
      const row = findStrikeInChain(chain, desc.strike);
      // Accept row if it has a valid mid price OR valid IV — don't reject illiquid/deep-ITM
      // options that have mid=0 but still carry useful IV data for Theo P&L calculation.
      if (row && (row.mid > 0 || row.iv != null)) {
        legResults[desc.legKey || 'main'] = {
          mid:   row.mid  ?? 0,
          iv:    row.iv   ?? null,
          delta: row.delta ?? null,
          theta: row.theta ?? null,
        };
      }
    }

    if (Object.keys(legResults).length === 0) {
      // Yahoo had no chain data — try BSM estimate using entry IV + current stock price.
      // Applies to: IC/Calendar legs with far-out expiries, illiquid tickers (AXSM, INOD etc.)
      // All 14 strategies handled via getOptionFetchDescriptors descs already computed above.
      const stockPrice = prices[trade.id]?.stock
        || prices[trade.ticker?.toUpperCase()]?.stock;
      const ivEntry = trade.iv_entry;
      if (stockPrice && ivEntry && descs.length > 0) {
        const sigma = ivEntry / 100;
        const now   = new Date();
        const isSpreadLeg = ['Iron Condor','Iron Butterfly',
          'Bull Put Spread','Bear Call Spread','Bull Call Spread','Bear Put Spread'].includes(trade.strategy);
        // Spread strategies: net spread = |BSM(short) − BSM(long)|. Straddle/others: sum legs.
        const bsmByKey = {};
        for (const desc of descs) {
          const expDate = desc.expiry ? new Date(desc.expiry) : null;
          const T = expDate ? Math.max(0.001, (expDate - now) / (365 * 86400000)) : 0;
          const mid = bsmPrice(stockPrice, desc.strike, T, sigma, desc.isCall);
          if (mid != null) bsmByKey[desc.legKey || 'main'] = mid;
        }
        const keys = Object.keys(bsmByKey);
        if (keys.length > 0) {
          let totalMid;
          if (isSpreadLeg && bsmByKey.short != null && bsmByKey.long != null) {
            // Net spread: absolute value so both credit and debit spreads are positive
            totalMid = Math.abs(bsmByKey.short - bsmByKey.long);
          } else {
            // Straddle/Strangle: sum; single-desc: use the one value
            totalMid = keys.reduce((s, k) => s + bsmByKey[k], 0);
          }
          prices[trade.id].option    = Math.round(totalMid * 100) / 100;
          prices[trade.id].iv        = ivEntry; // use entry IV as proxy
          prices[trade.id].isBsEst   = true;    // flag for UI "est." badge
        }
      }
      done++;
      onProgress?.({ done, total: tickers.length + optionTrades.length, stage: 'options' });
      continue;
    }

    if (legResults.short != null && legResults.long != null) {
      // Spread strategies (IC/IB + all 4 vanilla spreads): net spread = |short - long|
      // Always stored as a positive number — P&L direction handled by calcTheoPnl isCredit check.
      // Credit spreads (BPS, BCS, IC): short.mid > long.mid → short - long > 0
      // Debit spreads (BCLS, BPutS): long.mid > short.mid → long - short > 0
      // Using Math.abs() ensures correct value for both directions.
      const netSpread = Math.abs(legResults.short.mid - legResults.long.mid);
      prices[trade.id].option = Math.round(netSpread * 100) / 100;
      // Greeks: use the short leg (dominant P&L driver)
      if (legResults.short.iv    != null) prices[trade.id].iv    = legResults.short.iv;
      if (legResults.short.delta != null) prices[trade.id].delta = legResults.short.delta;
      if (legResults.short.theta != null) prices[trade.id].theta = legResults.short.theta;
    } else if (legResults.call && legResults.put) {
      // Straddle/Strangle: combined mid = sum of both legs
      prices[trade.id].option = Math.round((legResults.call.mid + legResults.put.mid) * 100) / 100;
      const ivC = legResults.call.iv, ivP = legResults.put.iv;
      if (ivC != null && ivP != null) prices[trade.id].iv = Math.round((ivC + ivP) / 2 * 10) / 10;
      else if (ivC != null) prices[trade.id].iv = ivC;
      else if (ivP != null) prices[trade.id].iv = ivP;
      const dC = legResults.call.delta, dP = legResults.put.delta;
      if (dC != null && dP != null) prices[trade.id].delta = Math.round((dC + dP) * 100) / 100;
    } else {
      // Single-leg result: one of the two expected legs was found, the other wasn't.
      // GUARD: for spread strategies (IC/IB + all 4 vanilla spreads) we MUST have BOTH legs
      // to compute a valid net spread. Storing a raw individual leg mid here would produce
      // a wildly inflated "current price" and therefore a wildly wrong unrealised P&L
      // (e.g. raw 635P = $6.53 instead of net spread ~$1.86 → -$986 instead of -$52).
      // In this case skip storing the option price entirely — the UI will show a BSM
      // estimate badge (isBsEst) or a dash, which is far better than a wrong number.
      const SPREAD_STRATEGIES = new Set([
        'Iron Condor', 'Iron Butterfly',
        'Bull Put Spread', 'Bear Call Spread',
        'Bull Call Spread', 'Bear Put Spread',
      ]);
      if (SPREAD_STRATEGIES.has(trade.strategy)) {
        // Both legs required but only one found — try BSM fallback for the net spread.
        const stockPrice = prices[trade.id]?.stock
          || prices[trade.ticker?.toUpperCase()]?.stock;
        const ivEntry = trade.iv_entry;
        if (stockPrice && ivEntry && descs.length >= 2) {
          const sigma = ivEntry / 100;
          const now   = new Date();
          const bsmByKey = {};
          for (const desc of descs) {
            const expDate = desc.expiry ? new Date(desc.expiry) : null;
            const T = expDate ? Math.max(0.001, (expDate - now) / (365 * 86400000)) : 0;
            const mid = bsmPrice(stockPrice, desc.strike, T, sigma, desc.isCall);
            if (mid != null) bsmByKey[desc.legKey || 'main'] = mid;
          }
          if (bsmByKey.short != null && bsmByKey.long != null) {
            prices[trade.id].option  = Math.round(Math.abs(bsmByKey.short - bsmByKey.long) * 100) / 100;
            prices[trade.id].iv      = ivEntry;
            prices[trade.id].isBsEst = true;
          }
        }
        // If BSM also fails, leave prices[trade.id].option undefined — UI shows dash.
      } else {
        // Non-spread single-leg result (CC, CSP, Long Call/Put etc.) — store as-is.
        const q = legResults.main || legResults.short || legResults.call || legResults.put;
        prices[trade.id].option = q.mid;
        if (q.iv    != null) prices[trade.id].iv    = q.iv;
        if (q.delta != null) prices[trade.id].delta = q.delta;
        if (q.theta != null) prices[trade.id].theta = q.theta;
        // Also store IV under ticker key so CC/CSP recommendation strip picks up live IV
        if (q.iv != null && (trade.strategy === 'Covered Call' || trade.strategy === 'Cash-Secured Put')) {
          const tk = trade.ticker?.toUpperCase();
          if (tk) {
            if (!prices[tk]) prices[tk] = {};
            prices[tk].iv = q.iv;
          }
        }
      }
    }

    done++;
    onProgress?.({ done, total: tickers.length + optionTrades.length, stage: 'options' });
  }

  return prices;
}


// ── Option chain for RollModal viewer ───────────────────────
// Returns all strikes for a given ticker + expiry as an array of
// { strike, bid, ask, mid, iv, delta, theta, volume, oi }
// sorted by strike ascending. Used by the chain viewer when no
// broker is connected (Yahoo fallback).
// ── ATM IV fetch — lightweight single call for TradeForm recommendation strip ──
// Fetches the nearest expiry call chain, finds the ATM strike, returns IV %.
// Returns null if Yahoo unavailable or chain empty — caller must handle gracefully.
export async function fetchAtmIv(ticker, spot) {
  if (!ticker) return null;
  const t = ticker.toUpperCase();
  // Use nearest expiry ~30 DTE via tradingCalendar (single source of truth)
  const d = new Date(); d.setDate(d.getDate() + 30);
  const expiry = nearestExpiryFriday(d);
  try {
    const res = await fetch(getBackendBase() + '/api/yahoo/chain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: t, expiration: expiry, isCall: true }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const result = await res.json();
    const options = result?.options;
    if (!options || options.length === 0) return null;
    // Find ATM strike — closest to spot if available, else highest-volume strike
    let best = null, bestDiff = Infinity;
    options.forEach(o => {
      if (o.iv == null) return;
      if (spot && spot > 0) {
        const diff = Math.abs(o.strike - spot);
        if (diff < bestDiff) { bestDiff = diff; best = o; }
      } else {
        // No spot: use highest-volume strike as ATM proxy
        if (!best || (o.volume ?? 0) > (best.volume ?? 0)) best = o;
      }
    });
    // Sanity check: if we have spot, ATM strike must be within 20% of it
    if (!best) return null;
    if (spot && spot > 0 && bestDiff > spot * 0.20) return null;
    return best.iv; // already in % (e.g. 112.3)
  } catch { return null; }
}

export async function fetchOptionChainYahoo(ticker, expirationDate, isCall) {
  if (!ticker || !expirationDate) return { source: 'Yahoo', options: [] };
  const t       = ticker.toUpperCase();
  const expUnix = Math.floor(new Date(expirationDate).getTime() / 1000);
  const cacheKey = `chain-${t}-${expUnix}-${isCall ? 'C' : 'P'}`;
  const now = Date.now();

  let chain = null;
  const cached = OPTION_CACHE[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
    // Apply expiry guard even on cached chains — a cached wrong-expiry chain
    // (stored before the guard was introduced) must not bypass the check.
    const cachedExpiry = cached.chain?.expirationDate;
    if (cachedExpiry != null && Math.abs(cachedExpiry - expUnix) >= 7 * 86400) {
      delete OPTION_CACHE[cacheKey]; // evict stale wrong-expiry entry
      // fall through to fresh fetch below
    } else {
      chain = cached.chain;
    }
  }
  if (chain === null) { // not set from cache — fetch fresh
    // Try backend proxy first (avoids CORS/crumb issues)
    try {
      const res = await fetch(getBackendBase() + '/api/yahoo/chain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: t, expiration: expirationDate, isCall }),
        signal: AbortSignal.timeout(8000),
      });
      if (res.ok) {
        const result = await res.json();
        if (result?.options?.length > 0) return result; // backend returned data — done
      }
    } catch { /* backend unavailable — try direct */ }

    // Direct fallback
    try {
      const url = `https://query2.finance.yahoo.com/v7/finance/options/${encodeURIComponent(t)}?date=${expUnix}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) return { source: 'Yahoo', options: [] };
      const data = await res.json();
      const result = data?.optionChain?.result?.[0];
      const candidate = result?.options?.[0];
      // Guard: reject chain if Yahoo snapped to a different expiry (> 7 days off).
      // Wrong-expiry prices cause incorrect unrealised P&L — fall back to BSM instead.
      if (candidate?.expirationDate != null) {
        if (Math.abs(candidate.expirationDate - expUnix) >= 7 * 86400) {
          return { source: 'Yahoo', options: [] }; // wrong expiry — let BSM fallback run
        }
      }
      chain = candidate || null;
      if (chain) OPTION_CACHE[cacheKey] = { chain, fetchedAt: now };
    } catch { return { source: 'Yahoo', options: [] }; }
  } // end if (chain === null)

  if (!chain) return { source: 'Yahoo', options: [] };

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

  return { source: 'Yahoo', options };
}
