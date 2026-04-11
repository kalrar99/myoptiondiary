// src/utils/marketDataQuotes.js
//
// MarketData.app price fetcher — drop-in replacement for yahooQuotes.js
// Returns the exact same currentPrices structure so no component needs changing.
//
// ARCHITECTURE:
//   1. Build OCC option symbol from trade fields (ticker, expiry, strike, call/put)
//   2. Call MarketData.app /v1/options/quotes/{symbol}/ for each open trade
//   3. Call /v1/stocks/quotes/{ticker}/ for stock prices (one per unique ticker)
//   4. Return { [tradeId]: { stock, option, iv, delta, gamma, theta, vega }, [ticker]: { stock } }
//
// OCC SYMBOL FORMAT: AAPL240119C00185000
//   ticker (padded to 6) + YYMMDD + C/P + strike × 1000 (zero-padded to 8 digits)
//
// PRICING:
//   Free tier  — end-of-day only (limited use)
//   Starter    — $12/mo — 15-min delayed — sufficient for wheel traders
//   Trader     — $30/mo — real-time — for active intraday management
//   30-day free trial at marketdata.app, no card required
//
// RELIABILITY: Official API with SLA. Unlike Yahoo scraping, this will not
//   break without notice. Token stored in app settings, never leaves device.

const BASE = 'https://api.marketdata.app/v1';
const CACHE     = {};   // { key: { data, fetchedAt } }
const CACHE_TTL = 60 * 1000; // 1 minute — MarketData.app has its own rate limits

// ── OCC Symbol Builder ───────────────────────────────────────
// Builds the standard OCC option symbol from trade fields.
// Returns null if any required field is missing.
export function buildOCCSymbol(ticker, expiration, strike, isCall) {
  if (!ticker || !expiration || !strike || strike <= 0) return null;

  // Date: YYMMDD
  const d = new Date(expiration + 'T00:00:00');
  if (isNaN(d.getTime())) return null;
  const yy = String(d.getFullYear()).slice(2);
  const mm  = String(d.getMonth() + 1).padStart(2, '0');
  const dd  = String(d.getDate()).padStart(2, '0');

  // Ticker: padded to 6 chars (standard OCC format)
  const sym = ticker.toUpperCase().padEnd(6, ' ').slice(0, 6).trimEnd();

  // Strike: multiplied by 1000, zero-padded to 8 digits
  const strikeInt = Math.round(parseFloat(strike) * 1000);
  const strikePad = String(strikeInt).padStart(8, '0');

  const cp = isCall ? 'C' : 'P';
  return `${sym}${yy}${mm}${dd}${cp}${strikePad}`;
}

// ── Stock price ──────────────────────────────────────────────
async function fetchStockPrice(ticker, token) {
  const t = ticker.toUpperCase();
  const cacheKey = `stock-${t}`;
  const now = Date.now();
  const cached = CACHE[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(`${BASE}/stocks/quotes/${encodeURIComponent(t)}/`, {
      headers: { 'Authorization': `Token ${token}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // MarketData.app returns { s: "ok", last: [price], ... }
    const price = data?.last?.[0] ?? data?.mid?.[0] ?? null;
    if (price && price > 0) {
      CACHE[cacheKey] = { data: price, fetchedAt: now };
      return price;
    }
  } catch { /* timeout or network */ }
  return null;
}

// ── Option quote ─────────────────────────────────────────────
async function fetchOptionQuote(occSymbol, token) {
  if (!occSymbol) return null;
  const cacheKey = `opt-${occSymbol}`;
  const now = Date.now();
  const cached = CACHE[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(`${BASE}/options/quotes/${encodeURIComponent(occSymbol)}/`, {
      headers: { 'Authorization': `Token ${token}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.s !== 'ok') return null;

    // MarketData.app returns arrays — take index 0
    const mid   = data.mid?.[0] ?? ((data.bid?.[0] ?? 0) + (data.ask?.[0] ?? 0)) / 2;
    const iv    = data.iv?.[0]    != null ? Math.round(data.iv[0] * 1000) / 10 : null; // as %
    const delta = data.delta?.[0] != null ? data.delta[0] : null;
    const gamma = data.gamma?.[0] != null ? data.gamma[0] : null;
    const theta = data.theta?.[0] != null ? data.theta[0] : null;
    const vega  = data.vega?.[0]  != null ? data.vega[0]  : null;
    const underlying = data.underlyingPrice?.[0] ?? null;

    if (!mid || mid <= 0) return null;

    const result = {
      option: Math.round(mid * 100) / 100,
      iv, delta, gamma, theta, vega, underlying,
    };
    CACHE[cacheKey] = { data: result, fetchedAt: now };
    return result;
  } catch { /* timeout or network */ }
  return null;
}

// ── Test connection ──────────────────────────────────────────
export async function testMarketDataConnection(token) {
  if (!token?.trim()) return { ok: false, msg: 'No API token provided.' };
  try {
    const res = await fetch(`${BASE}/stocks/quotes/AAPL/`, {
      headers: { 'Authorization': `Token ${token}`, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(6000),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, msg: 'Invalid API token. Check your token at marketdata.app.' };
    if (res.status === 429) return { ok: false, msg: 'Rate limited. Wait a moment and try again.' };
    if (!res.ok) return { ok: false, msg: `Connection failed (HTTP ${res.status}).` };
    const data = await res.json();
    if (data?.s === 'ok' && data?.last?.[0] > 0) {
      return { ok: true, msg: `Connected. AAPL last price: $${data.last[0].toFixed(2)}` };
    }
    return { ok: false, msg: 'Unexpected response from MarketData.app.' };
  } catch (e) {
    return { ok: false, msg: `Connection error: ${e.message}` };
  }
}

// ── Strategy option fetch descriptors (shared logic with yahooQuotes) ────
// Returns array of { strike, isCall, expiry, legKey? } for each option to fetch.
function getOptionFetchDescriptors(trade) {
  const strat = trade.strategy;
  const exp   = trade.expiration;
  const ss    = parseFloat(trade.strike_sell);
  const sb    = parseFloat(trade.strike_buy);
  if (!exp) return [];

  // Single-leg strategies
  if (['Covered Call','Long Call'].includes(strat)) {
    const strike = ss || sb; if (!strike) return [];
    return [{ strike, isCall: true, expiry: exp }];
  }
  if (['Cash-Secured Put','Long Put'].includes(strat)) {
    const strike = sb || ss; if (!strike) return [];
    return [{ strike, isCall: false, expiry: exp }];
  }
  // 2-leg spread strategies: fetch both legs, store net spread value
  if (strat === 'Bull Put Spread' || strat === 'Bear Call Spread') {
    const isCall = strat === 'Bear Call Spread';
    const descs = [];
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    return descs.length > 0 ? descs : [];
  }
  if (strat === 'Bull Call Spread' || strat === 'Bear Put Spread') {
    const isCall = strat === 'Bull Call Spread';
    const descs = [];
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    return descs.length > 0 ? descs : [];
  }
  // ── IC / IB chain legs — each stored as a separate trade record ──
  // Each record has both strike_sell (short) and strike_buy (long wing).
  // We fetch BOTH legs so computeChainPnL can use the NET spread premium:
  //   net spread = short_leg_mid − long_leg_mid
  if (['Iron Condor','Iron Butterfly'].includes(strat)) {
    const leg    = trade.condor_leg;
    const isCall = (leg === 'call' || leg === 'full');
    const descs  = [];
    if (ss > 0) descs.push({ strike: ss, isCall, expiry: exp, legKey: 'short' });
    if (sb > 0) descs.push({ strike: sb, isCall, expiry: exp, legKey: 'long'  });
    return descs.length > 0 ? descs : [];
  }
  if (['Calendar Spread','Diagonal Spread'].includes(strat)) {
    const leg     = trade.cal_leg;
    const expBack = trade.expiration_back || exp;
    if (leg === 'short') { const strike = ss || sb; if (!strike) return []; return [{ strike, isCall: true, expiry: exp }]; }
    if (leg === 'long')  { const strike = sb || ss; if (!strike) return []; return [{ strike, isCall: true, expiry: expBack }]; }
    const strike = ss || sb; if (!strike) return [];
    return [{ strike, isCall: true, expiry: exp }];
  }
  if (['Long Straddle','Long Strangle'].includes(strat)) {
    const descs = [];
    if (ss > 0) descs.push({ strike: ss, isCall: true,  expiry: exp, legKey: 'call' });
    if (sb > 0) descs.push({ strike: sb, isCall: false, expiry: exp, legKey: 'put'  });
    return descs;
  }
  return [];
}

// ── Main batch fetcher ───────────────────────────────────────
// Returns currentPrices-compatible structure matching yahooQuotes.js output exactly.
// { [tradeId]: { stock?, option?, iv?, delta?, gamma?, theta?, vega? },
//   [TICKER]:  { stock? } }
export async function fetchMarketDataPrices(openTrades, token, onProgress) {
  if (!token?.trim()) return {};
  const prices  = {};
  const tickers = [...new Set(openTrades.map(t => t.ticker.toUpperCase()))];
  let done = 0;
  const optionTrades = openTrades.filter(t => t.expiration && getOptionFetchDescriptors(t).length > 0);
  const total = tickers.length + optionTrades.length;

  // Step 1: Stock prices per unique ticker (parallel)
  await Promise.allSettled(tickers.map(async ticker => {
    const price = await fetchStockPrice(ticker, token);
    if (price) {
      prices[ticker] = { stock: price };
      openTrades.filter(t => t.ticker.toUpperCase() === ticker).forEach(t => {
        if (!prices[t.id]) prices[t.id] = {};
        prices[t.id].stock = price;
      });
    }
    done++;
    onProgress?.({ done, total, stage: 'stocks' });
  }));

  // Step 2: Option quotes — full strategy-aware fetch
  for (const trade of optionTrades) {
    const descs = getOptionFetchDescriptors(trade);
    const legResults = {};

    for (const desc of descs) {
      const occ = buildOCCSymbol(trade.ticker, desc.expiry, desc.strike, desc.isCall);
      if (occ) {
        const quote = await fetchOptionQuote(occ, token);
        if (quote) legResults[desc.legKey || 'main'] = quote;
      }
      await new Promise(r => setTimeout(r, 150));
    }

    if (Object.keys(legResults).length === 0) { done++; onProgress?.({ done, total, stage: 'options' }); continue; }

    if (!prices[trade.id]) prices[trade.id] = {};

    if (legResults.short != null && legResults.long != null) {
      // All spread strategies: |short − long| = net spread value (positive always)
      // Math.abs() handles both credit (short>long) and debit (long>short) spreads.
      const netSpread = Math.abs(legResults.short.option - legResults.long.option);
      prices[trade.id].option = Math.round(netSpread * 100) / 100;
      // Greeks: short leg dominates
      if (legResults.short.iv    != null) prices[trade.id].iv    = legResults.short.iv;
      if (legResults.short.delta != null) prices[trade.id].delta = legResults.short.delta;
      if (legResults.short.theta != null) prices[trade.id].theta = legResults.short.theta;
    } else if (legResults.call && legResults.put) {
      prices[trade.id].option = Math.round((legResults.call.option + legResults.put.option) * 100) / 100;
      const ivC = legResults.call.iv, ivP = legResults.put.iv;
      if (ivC != null && ivP != null) prices[trade.id].iv = Math.round((ivC + ivP) / 2 * 10) / 10;
      else if (ivC != null) prices[trade.id].iv = ivC;
      else if (ivP != null) prices[trade.id].iv = ivP;
      const dC = legResults.call.delta, dP = legResults.put.delta;
      if (dC != null && dP != null) prices[trade.id].delta = Math.round((dC + dP) * 100) / 100;
    } else {
      const q = legResults.main || legResults.short || legResults.call || legResults.put;
      prices[trade.id].option = q.option;
      if (q.iv      != null) prices[trade.id].iv      = q.iv;
      if (q.delta   != null) prices[trade.id].delta   = q.delta;
      if (q.gamma   != null) prices[trade.id].gamma   = q.gamma;
      if (q.theta   != null) prices[trade.id].theta   = q.theta;
      if (q.vega    != null) prices[trade.id].vega    = q.vega;
      if (q.underlying && !prices[trade.id]?.stock) {
        prices[trade.id].stock = q.underlying;
        const tk = trade.ticker.toUpperCase();
        if (!prices[tk]?.stock) prices[tk] = { ...(prices[tk]||{}), stock: q.underlying };
      }
    }

    done++;
    onProgress?.({ done, total, stage: 'options' });
  }

  return prices;
}

// ── Option chain for RollModal viewer (MarketData.app) ───────
// Returns all strikes for a ticker + expiry using MarketData.app
// /v1/options/chain/{symbol}/ endpoint.
// Used when user has MarketData.app configured but no live broker.
export async function fetchOptionChainMarketData(ticker, expirationDate, isCall, token) {
  if (!ticker || !expirationDate || !token) return { source: 'MarketData', options: [] };
  const t   = ticker.toUpperCase();
  const exp = expirationDate; // YYYY-MM-DD
  const cp  = isCall ? 'call' : 'put';
  const cacheKey = `chain-${t}-${exp}-${cp}`;
  const now = Date.now();
  const cached = CACHE[cacheKey];
  if (cached && now - cached.fetchedAt < CACHE_TTL) return cached.data;

  try {
    const res = await fetch(
      `${BASE}/options/chain/${encodeURIComponent(t)}/?expiration=${exp}&side=${cp}&dateFormat=timestamp`,
      {
        headers: { 'Authorization': `Token ${token}`, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(6000),
      }
    );
    if (!res.ok) return { source: 'MarketData', options: [] };
    const data = await res.json();
    if (data?.s !== 'ok' || !data?.strike) return { source: 'MarketData', options: [] };

    // MarketData.app returns parallel arrays indexed by position
    const options = data.strike.map((strike, i) => {
      const bid = data.bid?.[i]   ?? 0;
      const ask = data.ask?.[i]   ?? 0;
      const mid = data.mid?.[i]   ?? (bid > 0 && ask > 0 ? (bid + ask) / 2 : (data.last?.[i] ?? 0));
      return {
        strike: strike,
        bid:    Math.round(bid * 100) / 100,
        ask:    Math.round(ask * 100) / 100,
        mid:    Math.round(mid * 100) / 100,
        iv:     data.iv?.[i]    != null ? Math.round(data.iv[i] * 1000) / 10 : null,
        delta:  data.delta?.[i] ?? null,
        theta:  data.theta?.[i] ?? null,
        volume: data.volume?.[i] ?? 0,
        oi:     data.openInterest?.[i] ?? 0,
      };
    }).filter(o => o.strike > 0 && o.mid >= 0)
      .sort((a, b) => a.strike - b.strike);

    const result = { source: 'MarketData.app', options };
    CACHE[cacheKey] = { data: result, fetchedAt: now };
    return result;
  } catch { return { source: 'MarketData', options: [] }; }
}
