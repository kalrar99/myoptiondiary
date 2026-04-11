// src/components/TradeLog.jsx
import React, { useState, useMemo, useRef, useEffect, useCallback} from 'react';
import ICAdjustModal from './ICAdjustModal';
import TradeExplainModal from './TradeExplainModal';
import ExpiryDatePicker from './ExpiryDatePicker';
import { nearestExpiryFriday, DEFAULT_RISK_FREE_RATE, DEFAULT_BSM_IV, bsmPrice } from '../utils/tradingCalendar';
import { fetchOptionChainYahoo } from '../utils/yahooQuotes';
import { fetchOptionChainMarketData } from '../utils/marketDataQuotes';
const localDateISO = (d=new Date()) => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };

function getBase() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol;
  if (proto === 'app:' || proto === 'file:') return 'http://127.0.0.1:3002';
  if (proto === 'http:' || proto === 'https:') return 'http://127.0.0.1:3002';
  return '';
}

const STRATEGY_COLORS = {
  'Covered Call':     { bg: '#eef4ff', color: '#1a5fa8' },
  'Cash-Secured Put': { bg: '#edf7f2', color: '#1a7a4a' },
  'Bull Put Spread':  { bg: '#edf7f2', color: '#1a7a4a' },
  'Bear Call Spread': { bg: '#fdf0ee', color: '#c0392b' },
  'Iron Condor':      { bg: '#f3f0ff', color: '#6d28d9' },
  'Iron Butterfly':   { bg: '#f3f0ff', color: '#6d28d9' },
  'Long Call':        { bg: '#edf7f2', color: '#1a7a4a' },
  'Long Put':         { bg: '#fdf0ee', color: '#c0392b' },
  'Bull Call Spread': { bg: '#edf7f2', color: '#1a7a4a' },
  'Bear Put Spread':  { bg: '#fdf0ee', color: '#c0392b' },
  'Long Straddle':    { bg: '#fff8e6', color: '#92600a' },
  'Long Strangle':    { bg: '#fff8e6', color: '#92600a' },
  'Calendar Spread':  { bg: '#f0f0f0', color: '#555' },
  'Diagonal Spread':  { bg: '#f0f0f0', color: '#555' },
};

const ROLL_STRATEGIES         = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Bull Call Spread','Bear Put Spread'];
const CREDIT_STRATEGIES       = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'];
const DEBIT_SPREAD_STRATEGIES = ['Bull Call Spread','Bear Put Spread'];
const MULTI_LEG_STRATEGIES    = ['Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread'];

// ── Column tooltips — short trader language ──────────────
const COLUMN_TIPS = {
  'Position':   'Ticker · strategy · action buttons',
  'DTE':        'Days to expiry',
  'Strike':     'Your obligation price. For spreads: Sell strike / Buy strike (short / long).',
  'Contracts':  'Number of contracts',
  'Stock $':    'Current stock price — auto-filled by broker or Yahoo. Editable when neither available.',
  'Entry $':    'Premium collected or paid',
  'IV':         'Current implied volatility % — auto-filled by Yahoo or broker. Used for Black-Scholes when no Opt $ available. Editable when neither connected.',
  'Opt $':      'Current option price — auto-filled by broker or Yahoo. Editable when neither available. Takes priority over Black-Scholes.',
  '% Max':      '% of max profit captured',
  'Theo P&L':   'Theoretical P&L if closed now. Uses Opt $ for exact value, or Black-Scholes from IV when Opt $ unavailable. Read-only — always calculated.',
  'P&L Curve':  'Click to open payoff chart — solid line = expiry, dashed = today (Black-Scholes)',
  'P&L':        'Realised profit or loss',
  'Greeks':     'Delta, Theta, Vega at entry',
  'Entry':      'Trade entry date',
  'Expiry':     'Option expiration date',
  'Closed':     'Date position was closed',
  'Buy Back':   'Price paid to close the option',
  // Alerts & Actionable Insights Monitor table
  'Alert':      'Reason this position needs attention',
  'Delta':      'Probability of expiring ITM',
  'Roll Opts':  'Possible roll scenarios with P&L impact',
  'Roll vs Hold': 'Theo P&L if you roll vs doing nothing',
};

// ── Black-Scholes model ───────────────────────────────────
// Standard BS for European options — used for P&L curve today-value line
function blackScholes(S, K, T, r, sigma, isCall) {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const N  = x => 0.5 * (1 + erf(x / Math.sqrt(2)));
  function erf(x) {
    const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
    const s = x < 0 ? -1 : 1; const ax = Math.abs(x);
    const t = 1 / (1 + p * ax);
    const y = 1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax);
    return s * y;
  }
  if (isCall) return S * N(d1) - K * Math.exp(-r * T) * N(d2);
  return K * Math.exp(-r * T) * N(-d2) - S * N(-d1);
}

// ── IV estimation (non-live) ─────────────────────────────
// Anchored to VIX × multiplier by ticker type
// VIX is cached in module scope, refreshed on first use
let cachedVix = null; let vixFetchedAt = 0;
async function fetchVix() {
  const now = Date.now();
  if (cachedVix && now - vixFetchedAt < 3600000) return cachedVix;
  try {
    const res = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EVIX?interval=1d&range=1d');
    const data = await res.json();
    const px = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (px) { cachedVix = px / 100; vixFetchedAt = now; return cachedVix; }
  } catch {}
  return 0.18; // fallback VIX ~18%
}

const BROAD_ETFS  = ['SPY','QQQ','IWM','DIA','VTI','VOO','SPX'];
const SECTOR_ETFS = ['XLK','XLE','XLF','XLV','XLI','XLP','XLU','XLY','XLB','XLRE','XLC','XBI','GLD','SLV','USO','TLT'];
const HIGH_VOL    = ['TSLA','MEME','GME','AMC','RIVN','PLTR','COIN','HOOD','SNAP','SOFI','LCID'];
const GROWTH_TECH = ['NVDA','META','AMZN','GOOGL','NFLX','SHOP','SQ','ROKU','TWLO','CRWD','DDOG','MDB'];

function getVixMultiplier(ticker) {
  const t = (ticker || '').toUpperCase();
  if (BROAD_ETFS.includes(t))  return 1.0;
  if (SECTOR_ETFS.includes(t)) return 1.2;
  if (HIGH_VOL.includes(t))    return 2.8;
  if (GROWTH_TECH.includes(t)) return 2.0;
  return 1.5; // large-cap stable default
}

function estimateIvLabel(ticker) {
  const t = (ticker || '').toUpperCase();
  if (BROAD_ETFS.includes(t))  return 'broad ETF estimate';
  if (SECTOR_ETFS.includes(t)) return 'sector ETF estimate';
  if (HIGH_VOL.includes(t))    return 'high-vol estimate';
  if (GROWTH_TECH.includes(t)) return 'growth tech estimate';
  return 'large-cap estimate';
}

// ── P&L Curve data generator ──────────────────────────────
// ── Implied volatility extractor — inverts BSM via binary search ────────
function impliedVol(price, S, K, T, r, isCall) {
  if (!price || price <= 0 || !S || !K || T <= 0) return null;
  const intrinsic = isCall ? Math.max(0, S - K) : Math.max(0, K - S);
  if (price <= intrinsic + 0.001) return null;
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    blackScholes(S, K, T, r, mid, isCall) > price ? hi = mid : lo = mid;
  }
  const iv = (lo + hi) / 2;
  return (iv > 0.001 && iv < 4.9) ? iv : null;
}

// FIX #2: Iron Condor now uses correct 4-leg payoff (put spread + call spread).
function getPnlCurveData(trade, stockPrice, iv, contracts, lotAvgCost, lotShares, allTrades, currentPrices) {
  if (!stockPrice) return null;
  const hasStrikes = trade.strike_sell || trade.strike_buy;
  if (!hasStrikes) return null;

  // Strategies where a single price-axis P&L curve is conceptually wrong
  // (time spreads need two expiries; straddle/strangle need two strikes).
  // Return null so the chart button shows 'N/A' instead of a misleading curve.
  const NO_CURVE = new Set(['Calendar Spread','Diagonal Spread']); // Straddle/Strangle now have curves
  if (NO_CURVE.has(trade.strategy)) return null;

  const S      = parseFloat(stockPrice);
  const entry  = parseFloat(trade.entry_price) || 0;
  const qty    = contracts || trade.contracts || 1;
  const isCred = CREDIT_STRATEGIES.includes(trade.strategy);
  const r      = DEFAULT_RISK_FREE_RATE;

  const now     = new Date();
  const expDate = trade.expiration ? new Date(trade.expiration) : new Date(now.getTime() + 30*86400000);
  const T       = Math.max(0.001, (expDate - now) / (365 * 86400000));

  // Strike shorthand
  const kSell = parseFloat(trade.strike_sell) || 0;
  const kBuy  = parseFloat(trade.strike_buy)  || 0;
  const K     = kSell || kBuy; // primary strike for single-leg BS

  // isCall for the BS today-line — each strategy correctly categorised
  const IS_CALL_STRAT = new Set(['Covered Call','Bear Call Spread','Bull Call Spread','Long Call']);
  const isCall = IS_CALL_STRAT.has(trade.strategy);

  const lo = S * 0.75, hi = S * 1.25;
  const step = (hi - lo) / 59;
  const points = [];

  for (let i = 0; i < 60; i++) {
    const sp = lo + i * step;
    let expiryPnl, todayPnl;

    if (trade.strategy === 'Covered Call') {
      const optPnl   = (entry - Math.max(0, sp - kSell)) * qty * 100;
      const sharePnl = (lotAvgCost && lotShares) ? (sp - parseFloat(lotAvgCost)) * parseFloat(lotShares) : 0;
      expiryPnl = optPnl + sharePnl;
      const bsVal = blackScholes(sp, kSell, T, r, iv || 0.25, true);
      todayPnl  = (entry - bsVal) * qty * 100 + sharePnl;

    } else if (trade.strategy === 'Cash-Secured Put') {
      expiryPnl = (entry - Math.max(0, kBuy - sp)) * qty * 100;
      const bsVal = blackScholes(sp, kBuy, T, r, iv || 0.25, false);
      todayPnl  = (entry - bsVal) * qty * 100;

    } else if (trade.strategy === 'Bull Put Spread') {
      // Credit spread: sell kSell put, buy kBuy put (kSell > kBuy)
      const spreadExpiry = Math.max(0, kSell - sp) - Math.max(0, kBuy - sp);
      expiryPnl = (entry - spreadExpiry) * qty * 100;
      const bsShort = blackScholes(sp, kSell, T, r, iv || 0.25, false);
      const bsLong  = blackScholes(sp, kBuy,  T, r, iv || 0.25, false);
      todayPnl  = (entry - (bsShort - bsLong)) * qty * 100;

    } else if (trade.strategy === 'Bear Call Spread') {
      // Credit spread: sell kSell call, buy kBuy call (kBuy > kSell)
      const spreadExpiry = Math.max(0, sp - kSell) - Math.max(0, sp - kBuy);
      expiryPnl = (entry - spreadExpiry) * qty * 100;
      const bsShort = blackScholes(sp, kSell, T, r, iv || 0.25, true);
      const bsLong  = blackScholes(sp, kBuy,  T, r, iv || 0.25, true);
      todayPnl  = (entry - (bsShort - bsLong)) * qty * 100;

    } else if (trade.strategy === 'Bull Call Spread') {
      // Debit spread: buy kBuy call, sell kSell call (kSell > kBuy)
      const spreadExpiry = Math.max(0, sp - kBuy) - Math.max(0, sp - kSell);
      expiryPnl = (spreadExpiry - entry) * qty * 100;
      const bsLong  = blackScholes(sp, kBuy,  T, r, iv || 0.25, true);
      const bsShort = blackScholes(sp, kSell, T, r, iv || 0.25, true);
      todayPnl  = ((bsLong - bsShort) - entry) * qty * 100;

    } else if (trade.strategy === 'Bear Put Spread') {
      // Debit spread: buy kSell put (higher strike = long leg), sell kBuy put (lower strike = short leg)
      // kSell > kBuy per validation. Long = kSell, Short = kBuy — naming reflects storage convention.
      const spreadExpiry = Math.max(0, kSell - sp) - Math.max(0, kBuy - sp);
      expiryPnl = (spreadExpiry - entry) * qty * 100;
      const bsLongPut  = blackScholes(sp, kSell, T, r, iv || 0.25, false); // long put at higher strike
      const bsShortPut = blackScholes(sp, kBuy,  T, r, iv || 0.25, false); // short put at lower strike
      todayPnl  = ((bsLongPut - bsShortPut) - entry) * qty * 100;

    } else if (trade.strategy === 'Long Straddle' || trade.strategy === 'Long Strangle') {
      // V-shape: profit on big moves either direction
      // Convention: strike_sell = call strike, strike_buy = put strike (same for straddle, different for strangle)
      const kCall = kSell > 0 ? kSell : kBuy;   // call side — prefer kSell; straddle both equal so safe
      const kPut  = kBuy  > 0 ? kBuy  : kSell;  // put side  — prefer kBuy; straddle both equal so safe
      // Per-leg IV from live prices when available
      const liveCall = currentPrices?.[trade.id]?.callMid;
      const livePut  = currentPrices?.[trade.id]?.putMid;
      const ivCall = (liveCall && impliedVol(liveCall, S, kCall, T, r, true))  || iv || 0.30;
      const ivPut  = (livePut  && impliedVol(livePut,  S, kPut,  T, r, false)) || iv || 0.30;
      expiryPnl = (Math.max(0, sp - kCall) + Math.max(0, kPut - sp) - entry) * qty * 100;
      const bsCall = blackScholes(sp, kCall, T, r, ivCall, true);
      const bsPut  = blackScholes(sp, kPut,  T, r, ivPut,  false);
      todayPnl  = (bsCall + bsPut - entry) * qty * 100;

    } else if (trade.strategy === 'Iron Condor') {
      // Full 4-leg tent using actual call leg strikes when chain data is available.
      // If allTrades provided, look up the real call leg for accurate wing positions.
      const chainId   = trade.condor_chain_id;
      // Latest OPEN call leg — after roll_one_leg old closed legs must be skipped
      const callLeg   = chainId && allTrades
        ? [...allTrades]
            .filter(t => t.condor_chain_id === chainId && t.condor_leg === 'call'
                      && ((t.contracts_open ?? t.contracts ?? 1) > 0))
            .sort((a, b) => (b.condor_seq || 0) - (a.condor_seq || 0))[0] || null
        : null;
      const spreadWidth  = kSell - kBuy;
      // Use real call strikes if found, else infer symmetric (fallback for imported/legacy data)
      const kCallShort   = callLeg ? parseFloat(callLeg.strike_sell) : kSell + spreadWidth;
      const kCallLong    = callLeg ? parseFloat(callLeg.strike_buy)  : kCallShort + spreadWidth;
      const callEntry    = callLeg ? parseFloat(callLeg.entry_price) : entry; // per-wing credit
      const totalEntry   = entry + callEntry; // combined 4-leg credit
      const putSpread    = Math.max(0, kSell - sp) - Math.max(0, kBuy - sp);
      const callSpread   = Math.max(0, sp - kCallShort) - Math.max(0, sp - kCallLong);
      expiryPnl = (totalEntry - putSpread - callSpread) * qty * 100;
      // Per-leg IV from live prices when available; fallback to flat iv
      const livePutS  = currentPrices?.[trade.id]?.option || null;
      const liveCallS = callLeg ? currentPrices?.[callLeg.id]?.option : null;
      const ivPS = (livePutS  && impliedVol(livePutS,  sp, kSell,      T, r, false)) || iv || 0.20;
      const ivPL = ivPS; // put wing — same expiry, use same IV as proxy
      const ivCS = (liveCallS && impliedVol(liveCallS, sp, kCallShort, T, r, true))  || iv || 0.20;
      const ivCL = ivCS; // call wing — same expiry
      const bsPutS  = blackScholes(sp, kSell,      T, r, ivPS, false);
      const bsPutL  = blackScholes(sp, kBuy,       T, r, ivPL, false);
      const bsCallS = blackScholes(sp, kCallShort, T, r, ivCS, true);
      const bsCallL = blackScholes(sp, kCallLong,  T, r, ivCL, true);
      const netBS   = (bsPutS - bsPutL) + (bsCallS - bsCallL);
      todayPnl  = (totalEntry - netBS) * qty * 100;

    } else if (trade.strategy === 'Iron Butterfly') {
      // IB storage convention (put-leg anchor record):
      //   strike_buy  = lower protection put wing  (e.g. $840)
      //   strike_sell = ATM body / short strike     (e.g. $875) — also used by Alerts for breach
      // Upper call wing is derived symmetrically: ATM + (ATM − lower wing)
      const kATM      = kSell;                     // ATM body = strike_sell on put leg
      const kWingLow  = kBuy;                      // lower protection put
      const kWingHigh = kATM + (kATM - kWingLow); // symmetric upper call wing
      // FIX: IB is stored as TWO leg records (put + call), each with entry = one wing's credit.
      // entry (from put-leg anchor) is half the total credit. Multiply by 2 for full position P&L.
      const ibTotalCredit = entry * 2;
      const putPnl    = Math.max(0, kATM - sp) - Math.max(0, kWingLow - sp);
      const callPnl   = Math.max(0, sp - kATM) - Math.max(0, sp - kWingHigh);
      expiryPnl = (ibTotalCredit - putPnl - callPnl) * qty * 100;
      const bsAtmP  = blackScholes(sp, kATM,      T, r, iv||0.20, false);
      const bsWingP = blackScholes(sp, kWingLow,  T, r, iv||0.20, false);
      const bsAtmC  = blackScholes(sp, kATM,      T, r, iv||0.20, true);
      const bsWingC = blackScholes(sp, kWingHigh, T, r, iv||0.20, true);
      const netIB   = (bsAtmP - bsWingP) + (bsAtmC - bsWingC);
      todayPnl  = (ibTotalCredit - netIB) * qty * 100;

    } else if (trade.strategy === 'Long Call') {
      expiryPnl = (Math.max(0, sp - K) - entry) * qty * 100;
      const bsVal = blackScholes(sp, K, T, r, iv || 0.30, true);
      todayPnl  = (bsVal - entry) * qty * 100;

    } else if (trade.strategy === 'Long Put') {
      expiryPnl = (Math.max(0, K - sp) - entry) * qty * 100;
      const bsVal = blackScholes(sp, K, T, r, iv || 0.30, false);
      todayPnl  = (bsVal - entry) * qty * 100;

    } else {
      // Generic fallback — keeps any unrecognised strategy from crashing
      const optVal = isCall ? Math.max(0, sp - K) : Math.max(0, K - sp);
      expiryPnl = isCred ? (entry - optVal) * qty * 100 : (optVal - entry) * qty * 100;
      const bsVal = blackScholes(sp, K, T, r, iv || 0.25, isCall);
      todayPnl  = isCred ? (entry - bsVal) * qty * 100 : (bsVal - entry) * qty * 100;
    }

    points.push({ sp: Math.round(sp * 100) / 100, expiryPnl: Math.round(expiryPnl), todayPnl: Math.round(todayPnl) });
  }

  const breakevens = [];
  for (let i = 1; i < points.length; i++) {
    if ((points[i-1].expiryPnl < 0 && points[i].expiryPnl >= 0) ||
        (points[i-1].expiryPnl >= 0 && points[i].expiryPnl < 0)) {
      breakevens.push(Math.round(((points[i-1].sp + points[i].sp) / 2) * 100) / 100);
    }
  }
  return { points, breakevens, T, K, S, iv };
}

// ── Calendar / Diagonal chain P&L curve ─────────────────────────────────
// shortLeg: current open short (front month), longLeg: current open long (back month)
// currentPrices: live/Yahoo prices for per-leg IV extraction
// Returns same { points, breakevens, T, K, S, iv } shape as getPnlCurveData
function getPnlCurveDataCalChain(shortLeg, longLeg, stockPrice, currentPrices, r) {
  if (!shortLeg || !longLeg || !stockPrice) return null;
  const S    = parseFloat(stockPrice);
  const now  = new Date();
  const netDebit = parseFloat(longLeg.entry_price || 0) - parseFloat(shortLeg.entry_price || 0);
  if (netDebit <= 0) return null;

  // Front month (short leg) — expires first
  const strikeShort = parseFloat(shortLeg.strike_sell || shortLeg.strike_buy) || 0;
  // Back month (long leg) — expires later
  const strikeLong  = parseFloat(longLeg.strike_buy  || longLeg.strike_sell)  || strikeShort;
  if (!strikeShort) return null;

  const frontExpDate = shortLeg.expiration ? new Date(shortLeg.expiration) : new Date(now.getTime() + 21*86400000);
  const backExpDate  = longLeg.expiration_back || longLeg.expiration
    ? new Date(longLeg.expiration_back || longLeg.expiration) : new Date(now.getTime() + 60*86400000);

  const T_front = Math.max(0.001, (frontExpDate - now) / (365 * 86400000));
  const T_back  = Math.max(0.001, (backExpDate  - now) / (365 * 86400000));
  // T_back_at_front: how much time the long leg has left when the short expires
  const T_back_at_front = Math.max(0.001, T_back - T_front);

  const isCall = (shortLeg.option_type || longLeg.option_type || 'call') !== 'put';

  // Per-leg IV from live prices → fallback to iv_entry → flat default
  const liveShort = currentPrices?.[shortLeg.id]?.option;
  const liveLong  = currentPrices?.[longLeg.id]?.option;
  const iv_front_entry = (shortLeg.iv_entry || 0) / 100 || 0.25;
  const iv_back_entry  = (longLeg.iv_entry  || 0) / 100 || 0.22;
  const iv_front = (liveShort && impliedVol(liveShort, S, strikeShort, T_front, r, isCall)) || iv_front_entry;
  const iv_back  = (liveLong  && impliedVol(liveLong,  S, strikeLong,  T_back,  r, isCall)) || iv_back_entry;

  const lo = S * 0.80, hi = S * 1.20;
  const step = (hi - lo) / 59;
  const points = [];

  for (let i = 0; i < 60; i++) {
    const sp = lo + i * step;
    // Expiry line: at front-month expiration
    // Short put/call expires — value is intrinsic (we are SHORT so we BUY it back at intrinsic)
    const shortAtExpiry = isCall ? Math.max(sp - strikeShort, 0) : Math.max(strikeShort - sp, 0);
    // Back month still has T_back_at_front remaining time value
    const backAtExpiry  = blackScholes(sp, strikeLong, T_back_at_front, r, iv_back, isCall);
    // P&L = value of spread at front expiry minus what we paid (net debit)
    // Spread value at front expiry = long value - short intrinsic (short expired, we close it)
    const expiryPnl = (backAtExpiry - shortAtExpiry - netDebit) * (shortLeg.contracts_open ?? shortLeg.contracts ?? 1) * 100;
    // Today line: current spread value vs net debit paid
    const backToday  = blackScholes(sp, strikeLong,  T_back,  r, iv_back,  isCall);
    const frontToday = blackScholes(sp, strikeShort, T_front, r, iv_front, isCall);
    const todayPnl   = (backToday - frontToday - netDebit) * (shortLeg.contracts_open ?? shortLeg.contracts ?? 1) * 100;
    points.push({ sp: Math.round(sp * 100) / 100, expiryPnl: Math.round(expiryPnl), todayPnl: Math.round(todayPnl) });
  }

  const breakevens = [];
  for (let i = 1; i < points.length; i++) {
    if ((points[i-1].expiryPnl < 0 && points[i].expiryPnl >= 0) ||
        (points[i-1].expiryPnl >= 0 && points[i].expiryPnl < 0)) {
      breakevens.push(Math.round(((points[i-1].sp + points[i].sp) / 2) * 100) / 100);
    }
  }
  const usedLive = !!(liveShort || liveLong);
  return { points, breakevens, T: T_front, K: strikeShort, S, iv: iv_front, isCalChain: true, usedLive };
}

// ── % Max Profit calculator (V9) ─────────────────────────
function calcPctMaxProfit(trade, curOptPrice) {
  const op = parseFloat(curOptPrice);
  if (isNaN(op) || trade.entry_price == null) return null;
  const entry = parseFloat(trade.entry_price);

  if (DEBIT_SPREAD_STRATEGIES.includes(trade.strategy)) {
    const width = (trade.strike_sell != null && trade.strike_buy != null)
      ? Math.abs(parseFloat(trade.strike_sell) - parseFloat(trade.strike_buy))
      : null;
    if (!width || width <= 0) return null;  // zero width = data entry error, return null not NaN
    const maxProfit = width - entry;
    if (maxProfit <= 0) return null;
    const currentProfit = op - entry;
    return Math.min(100, Math.max(0, (currentProfit / maxProfit) * 100));
  }

  if (CREDIT_STRATEGIES.includes(trade.strategy)) {
    if (entry <= 0) return null;
    return Math.min(100, Math.max(0, ((entry - op) / entry) * 100));
  }
  return null;
}

const fmt = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MONTHS_SHORT = ['','Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = (d) => { if (!d) return '—'; try { const [yr,mo,dy] = d.slice(0,10).split('-'); return `${MONTHS_SHORT[+mo]} ${dy} '${yr.slice(2)}`; } catch { return d.slice(0,10); } };


// OCC strike increment check — returns warning string or null
function occStrikeWarn(strike, spot) {
  if (!strike || !spot || isNaN(parseFloat(strike)) || isNaN(parseFloat(spot))) return null;
  const s = parseFloat(strike), p = parseFloat(spot);
  if (s <= 0 || p <= 0) return null;
  const incr = p < 5 ? 0.5 : p < 25 ? 1 : p < 200 ? 2.5 : 5;
  const remainder = Math.abs(Math.round(s / incr) * incr - s);
  if (remainder < 0.001) return null;
  const lo = (Math.floor(s / incr) * incr).toFixed(incr < 1 ? 1 : 0);
  const hi = (Math.ceil(s  / incr) * incr).toFixed(incr < 1 ? 1 : 0);
  return `$${s} may not be a valid strike — OCC increments for a $${p.toFixed(0)} stock are $${incr}. Nearest: $${lo} or $${hi}.`;
}
function RollModal({ trade, onRoll, onClose, isMock, historicalMode = false, currentPrices, lots = [], trades = [], onPriceUpdate }) {
  // ── Draggable modal ─────────────────────────────────────────────
  const [pos,      setPos]      = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const modalRef   = useRef(null);

  const onMouseDownHeader = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    if (!pos) setPos({ x: rect.left, y: rect.top });
    setDragging(true);
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e) => {
      const newX = e.clientX - dragOffset.current.x;
      const newY = e.clientY - dragOffset.current.y;
      const rect = modalRef.current?.getBoundingClientRect();
      const w = rect?.width || 680;
      setPos({
        x: Math.max(-w + 80, Math.min(window.innerWidth  - 80, newX)),
        y: Math.max(0,        Math.min(window.innerHeight - 80, newY)),
      });
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  const modalStyle = pos
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '92vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '92vh', display: 'flex', flexDirection: 'column' };

  // ── Existing form state ──────────────────────────────────────
  // Pre-fill buy-back from live/Yahoo price if available — saves the trader a lookup
  const prefillExit = currentPrices?.[trade.id]?.option != null
    ? String(parseFloat(currentPrices[trade.id].option).toFixed(2))
    : '';
  const [selectedChainRow, setSelectedChainRow] = useState(null); // track which chain row was used for IV
  const [exitPrice,     setExitPrice]     = useState(prefillExit);
  const [exitDate,      setExitDate]      = useState(localDateISO());
  const [newStrikeSell, setNewStrikeSell] = useState('');
  const [newStrikeBuy,  setNewStrikeBuy]  = useState('');
  const [newExpiry,     setNewExpiry]     = useState('');
  const [newPremium,    setNewPremium]    = useState('');
  const [estNewPremium, setEstNewPremium] = useState(false); // true when filled from scenario/chain (not manually typed)
  const [notes,         setNotes]         = useState('');
  const [rollContracts, setRollContracts] = useState(String(trade.contracts || 1));
  const [manualIv,      setManualIv]      = useState('');  // IV override when no broker

  // ── Chain viewer state ───────────────────────────────────────
  const [showChain,     setShowChain]     = useState(false);
  const [showHelp,      setShowHelp]      = useState(false);  // novice help panel
  const [chainExpiry,   setChainExpiry]   = useState('');
  const chainExpiryRef      = useRef('');   // always-current chainExpiry for row clicks
  // Keep ref in sync so row-click closures always read current expiry
  const setChainExpirySync = (v) => { chainExpiryRef.current = v; setChainExpiry(v); };
  const [chainRows,     setChainRows]     = useState([]);   // [{ strike, bid, ask, mid, iv, delta, theta, volume, oi }]
  const [chainLoading,  setChainLoading]  = useState(false);
  const [chainSource,   setChainSource]   = useState('');   // 'Tradier'|'Schwab'|'MarketData.app'|'Yahoo'|'Demo'
  const [chainError,    setChainError]    = useState('');

  // ── Silent background chain pre-fetch for scenario cards ────
  // Fetches real option prices for each scenario's target expiry+strike
  // without touching the interactive chain panel state.
  // scenarioChains.current[expiry] = Row[] once loaded.
  const scenarioChains     = useRef({});   // expiry → Row[]
  const [scenarioPricesReady, setScenarioPricesReady] = useState(0); // bump to re-render cards

  const isSpread = trade.strike_buy != null && trade.strike_sell != null;
  const isCall   = ['Covered Call','Bear Call Spread','Bull Call Spread','Long Call'].includes(trade.strategy);
  const strike   = trade.strike_sell || trade.strike_buy || 0;
  const entry    = trade.entry_price || 0;
  const dte      = trade.expiration ? Math.max(0, Math.ceil((new Date(trade.expiration) - new Date()) / 86400000)) : null;
  const ivPct    = parseFloat(manualIv) || trade.iv_entry || 30;
  const iv       = ivPct / 100;
  const ivSource = manualIv ? 'manual' : trade.iv_entry ? 'entry' : 'default';

  // ── Generate 4 nearest expiry Friday pills ───────────────────
  // Always produces exactly 4 consecutive Fridays with no duplicates.
  // Starts from the next Friday on or after tomorrow.
  const expiryPills = useMemo(() => {
    const pills = [];
    const d = new Date();
    d.setDate(d.getDate() + 1); // start from tomorrow
    // Advance to next Friday
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    for (let i = 0; i < 4; i++) {
      pills.push(localDateISO(d));
      d.setDate(d.getDate() + 7);
    }
    return pills;
  }, []);

  // ── BSM demo chain generator ─────────────────────────────────
  function buildDemoChain(expiry) {
    if (!expiry) return [];
    const stockPrice = parseFloat(currentPrices?.[trade.id]?.stock
      || currentPrices?.[trade.ticker?.toUpperCase()]?.stock)
      || (isCall ? strike * 1.02 : strike * 0.98);
    const dteChain = Math.max(1, Math.ceil((new Date(expiry) - new Date()) / 86400000));
    const T = Math.max(0.001, dteChain / 365);
    const sigma = iv || 0.30;
    // Generate strikes around current strike using OCC standard increments
    const occIncr = stockPrice < 5 ? 0.5 : stockPrice < 25 ? 1 : stockPrice < 200 ? 2.5 : 5;
    const rows = [];
    const base = Math.round(strike / occIncr) * occIncr;
    const range = occIncr * 6; // ±6 strikes either side
    for (let k = Math.round((base - range) / occIncr) * occIncr; k <= base + range; k = Math.round((k + occIncr) * 1000) / 1000) {
      if (k <= 0) continue;
      const mid = Math.max(0, Math.round(blackScholes(stockPrice, k, T, DEFAULT_RISK_FREE_RATE, sigma, isCall) * 100) / 100);
      if (mid <= 0 && k > base + 15) continue; // skip deep OTM zeros
      const spread = Math.max(0.05, Math.round(mid * 0.08 * 100) / 100);
      const bid = Math.max(0, Math.round((mid - spread / 2) * 100) / 100);
      const ask = Math.round((mid + spread / 2) * 100) / 100;
      // Approximate delta via d1
      const d1 = (Math.log(stockPrice / k) + (DEFAULT_RISK_FREE_RATE + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
      const N  = x => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-2 * x * x / Math.PI)));
      const delta = isCall ? Math.round(N(d1) * 100) / 100 : Math.round((N(d1) - 1) * 100) / 100;
      rows.push({ strike: k, bid, ask, mid, iv: Math.round(sigma * 1000) / 10, delta, theta: null, volume: 0, oi: 0 });
    }
    return rows;
  }

  // ── Fetch chain for selected expiry (interactive chain panel) ──────────
  // Priority: Tradier/Schwab → MarketData.app → Yahoo Finance → BSM fallback
  // Same hierarchy in demo and live — Yahoo is always tried before BSM.
  const fetchChain = useCallback(async (expiry) => {
    if (!expiry) return;
    setChainLoading(true);
    setChainError('');
    setChainRows([]);

    try {
      let rows = [];
      let source = '';

      // Try broker / MarketData first (live mode only)
      if (!isMock) {
        let settings = { provider: 'none', apiKey: '' };
        try {
          const s = await fetch(getBase() + '/api/settings');
          if (s.ok) settings = await s.json();
        } catch { /* backend not available */ }

        const { provider, apiKey, schwabClientId, schwabClientSecret } = settings;

        if (provider === 'tradier' || provider === 'schwab') {
          const res = await fetch(getBase() + '/api/live/option-chain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: trade.ticker, expiration: expiry, isCall, provider, apiKey, schwabClientId, schwabClientSecret }),
          });
          if (res.ok) {
            const data = await res.json();
            if (data.options?.length > 0) { rows = data.options; source = data.source; }
          }
        }
        if (!rows.length && provider === 'marketdata' && apiKey) {
          const result = await fetchOptionChainMarketData(trade.ticker, expiry, isCall, apiKey);
          if (result.options?.length > 0) { rows = result.options; source = result.source; }
        }
      }

      // Yahoo Finance — tried in both demo and live mode if no broker prices yet
      if (!rows.length) {
        const result = await fetchOptionChainYahoo(trade.ticker, expiry, isCall);
        if (result.options?.length > 0) { rows = result.options; source = result.source || 'Yahoo Finance'; }
      }

      // BSM fallback — only if Yahoo also failed
      if (!rows.length) {
        rows = buildDemoChain(expiry);
        source = 'BSM estimate';
      }

      setChainRows(rows);
      setChainSource(source);
    } catch (e) {
      // Final fallback — BSM synthetic chain
      const rows = buildDemoChain(expiry);
      setChainRows(rows);
      setChainSource('BSM estimate');
      if (!rows.length) setChainError('Chain unavailable — enter premium manually.');
    } finally {
      setChainLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.ticker, trade.id, isCall, isMock, iv, strike]);

  // ── When chain expiry changes, fetch ────────────────────────
  useEffect(() => {
    if (showChain && chainExpiry) fetchChain(chainExpiry);
  }, [chainExpiry, showChain, fetchChain]);

  // ── On mount: if no buyback price available, fetch current expiry chain ──
  // This gives the trader the buy-back price without needing a manual refresh first.
  useEffect(() => {
    if (isMock) return; // demo mode — BSM is fine
    if (currentPrices?.[trade.id]?.option != null) return; // already have it
    if (!trade.expiration) return;
    // Fetch the current expiry chain silently
    const fetchBuyback = async () => {
      try {
        const chain = await fetchOptionChainYahoo(trade.ticker, trade.expiration, isCall);
        if (!chain?.length) return;
        // Find the row matching current strike
        const targetStrike = parseFloat(isCall ? trade.strike_sell : trade.strike_buy);
        let best = null, bestDiff = Infinity;
        chain.forEach(r => {
          const diff = Math.abs(r.strike - targetStrike);
          if (diff < bestDiff) { bestDiff = diff; best = r; }
        });
        if (best && bestDiff <= 2.5 && best.mid != null) {
          // Write to currentPrices via onPriceUpdate
          if (onPriceUpdate) onPriceUpdate(trade.id, trade.ticker, { option: best.mid });
        }
      } catch {}
    };
    fetchBuyback();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.id]);

  // ── Silent background fetcher for scenario cards ─────────────
  // Priority: Tradier/Schwab → MarketData.app → Yahoo Finance → BSM fallback
  // Demo mode is NOT a reason to skip Yahoo — real prices are better than estimates.
  const fetchScenarioChain = useCallback(async (expiry) => {
    if (!expiry || scenarioChains.current[expiry]) return; // already fetched
    scenarioChains.current[expiry] = null; // mark in-flight

    try {
      let rows = [];

      // Try broker / MarketData first (live mode only)
      if (!isMock) {
        let settings = { provider: 'none', apiKey: '' };
        try { const s = await fetch(getBase() + '/api/settings'); if (s.ok) settings = await s.json(); } catch {}
        const { provider, apiKey, schwabClientId, schwabClientSecret } = settings;

        if (provider === 'tradier' || provider === 'schwab') {
          const res = await fetch(getBase() + '/api/live/option-chain', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticker: trade.ticker, expiration: expiry, isCall, provider, apiKey, schwabClientId, schwabClientSecret }),
          });
          if (res.ok) { const d = await res.json(); if (d.options?.length) rows = d.options; }
        }
        if (!rows.length && provider === 'marketdata' && apiKey) {
          const r = await fetchOptionChainMarketData(trade.ticker, expiry, isCall, apiKey);
          if (r.options?.length) rows = r.options;
        }
      }

      // Yahoo Finance — tried in both demo and live mode if no broker prices yet
      if (!rows.length) {
        const r = await fetchOptionChainYahoo(trade.ticker, expiry, isCall);
        if (r.options?.length) rows = r.options;
      }

      // BSM fallback — only if Yahoo also failed
      if (!rows.length) {
        rows = buildDemoChain(expiry);
      }

      scenarioChains.current[expiry] = rows;
      setScenarioPricesReady(n => n + 1);
    } catch {
      // Final fallback — BSM synthetic chain
      scenarioChains.current[expiry] = buildDemoChain(expiry);
      setScenarioPricesReady(n => n + 1);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trade.ticker, trade.id, isCall, isMock, iv, strike]);

  // Pre-fetch chains for all 3 scenario expiries on mount
  // Uses same expiry-relative logic as scenarioExpiry() — base from current trade expiry
  useEffect(() => {
    const base = trade.expiration ? new Date(trade.expiration) : new Date();
    const d1 = new Date(base); d1.setDate(d1.getDate() + 30);
    const d2 = new Date(base); d2.setDate(d2.getDate() + 45);
    let e1 = nearestExpiryFriday(d1);
    let e2 = nearestExpiryFriday(d2);
    // Guard: never pre-fetch current expiry
    if (e1 === trade.expiration) { const d = new Date(e1); d.setDate(d.getDate() + 7); e1 = nearestExpiryFriday(d); }
    if (e2 === trade.expiration) { const d = new Date(e2); d.setDate(d.getDate() + 7); e2 = nearestExpiryFriday(d); }
    const expiries = [...new Set([e1, e2])];
    expiries.forEach(exp => fetchScenarioChain(exp));
  }, [fetchScenarioChain, trade.expiration]);

  // ── Look up real mid price for a strike+expiry from pre-fetched chains ──
  function getLiveScenarioPrice(expiry, targetStrike) {
    const rows = scenarioChains.current[expiry];
    if (!rows || rows.length === 0) return null;
    // Find closest strike (within $2.50)
    let best = null, bestDiff = Infinity;
    rows.forEach(r => {
      const diff = Math.abs(r.strike - targetStrike);
      if (diff < bestDiff) { bestDiff = diff; best = r; }
    });
    return bestDiff <= 2.5 ? best : null;
  }
  function bsScenarioPremium(newDTE, newStrike, stockPrice) {
    const S = parseFloat(stockPrice) || (isCall ? newStrike * 0.98 : newStrike * 1.02);
    const T = Math.max(0.001, newDTE / 365);
    const val = blackScholes(S, newStrike, T, DEFAULT_RISK_FREE_RATE, iv || 0.30, isCall);
    return Math.max(0, Math.round(val * 100) / 100);
  }

  // Generate 3 roll scenarios — uses real chain prices if pre-fetched, BS as fallback
  // scenarioPricesReady is read here so useMemo re-runs when background fetches complete
  // eslint-disable-next-line no-unused-expressions
  void scenarioPricesReady;

  // ── Scenario DTE: computed relative to current expiry, not today ──────
  // This ensures the roll always lands AFTER the current expiry.
  // e.g. 31 DTE remaining → +30d → 61 DTE, +45d → 76 DTE
  // Guard: if computed expiry === current expiry, push out one more Friday.
  function scenarioExpiry(daysFromCurrentExpiry) {
    const base = trade.expiration ? new Date(trade.expiration) : new Date();
    base.setDate(base.getDate() + daysFromCurrentExpiry);
    let exp = nearestExpiryFriday(base);
    // Guard: never roll to the same expiry — push out one Friday
    if (exp === trade.expiration) {
      const d = new Date(exp); d.setDate(d.getDate() + 7);
      exp = nearestExpiryFriday(d);
    }
    return exp;
  }

  // OCC strike increment for roll scenarios — based on current strike as proxy for stock price
  // Use $5 increments for strikes >$50 — new/illiquid names only list $5 strikes.
  // $5 is always a valid OCC strike; $2.50 may not exist on the chain.
  const rollOccIncr = strike < 5 ? 0.5 : strike < 25 ? 1 : strike < 50 ? 2.5 : 5;
  const scenarios = [
    {
      // Trader label: standard options terminology
      label: 'Roll Out · +30d',
      sublabel: 'Buy time, keep your current strike',
      tooltip: 'The simplest roll. Close the current option and reopen at the same strike ~30 days past the current expiry. Collects additional premium while keeping your price target unchanged. Rolling for a net credit preserves the premium advantage of the position.',
      newDays: 30, strikeAdj: 0, newStrike: strike, color: '#1a5fa8', bg: '#eef4ff',
    },
    {
      label: 'Roll Out · +45d',
      sublabel: 'Full reset into the optimal theta zone',
      tooltip: 'Roll to ~45 days past current expiry — the sweet spot where theta decay accelerates most efficiently. Same strike, more premium collected. The optimal duration for theta decay efficiency.',
      newDays: 45, strikeAdj: 0, newStrike: strike, color: '#1a7a4a', bg: '#edf7f2',
    },
    {
      label: isCall ? `Roll Out and Up · +45d · Strike +$${rollOccIncr}` : `Roll Out and Down · +45d · Strike −$${rollOccIncr}`,
      sublabel: isCall ? 'More time AND a higher exit price' : 'More time AND a lower obligation price',
      tooltip: isCall
        ? 'Roll out and up: extend the expiry AND raise the strike. Ideal when the stock has risen toward your call strike — gives more room to run while still generating income. Only do this for a net credit.'
        : 'Roll out and down: extend the expiry AND lower the put strike. Ideal when the stock has dropped toward your put strike — reduces assignment risk while collecting more premium. Only do this for a net credit.',
      newDays: 45, strikeAdj: isCall ? rollOccIncr : -rollOccIncr, newStrike: isCall ? strike + rollOccIncr : strike - rollOccIncr, color: '#6d28d9', bg: '#f3f0ff',
    },
  ].map(s => {
    const expiry    = scenarioExpiry(s.newDays);
    const actualDTE = Math.ceil((new Date(expiry) - new Date()) / 86400000);
    const liveRow   = getLiveScenarioPrice(expiry, s.newStrike);
    const liveMid   = liveRow?.mid ?? null;
    const bsMid     = bsScenarioPremium(actualDTE, s.newStrike);
    const premium   = liveMid != null ? liveMid : bsMid;
    const isLive    = liveMid != null;
    const isPending = scenarioChains.current[expiry] === null; // in-flight
    const exitP     = parseFloat(exitPrice) || 0;
    const net       = Math.round((premium - exitP) * trade.contracts * 100);
    return { ...s, expiry, actualDTE, approxPremium: premium, netCredit: net, isLive, isPending, liveRow };
  });

  function applyScenario(s) {
    setNewExpiry(s.expiry);
    setNewPremium(String(s.approxPremium));
    setEstNewPremium(true);
    if (isSpread) {
      const adj = isCall ? s.strikeAdj : -s.strikeAdj;
      setNewStrikeSell(String(trade.strike_sell + adj));
      setNewStrikeBuy(String(trade.strike_buy + adj));
    } else {
      setNewStrikeSell(String(s.newStrike));
    }
    setNotes(`Rolled to ${s.label}${s.isLive ? ' (live price)' : ' (est.)'}`);
    // Pre-set chain expiry so Show Chain opens at the right expiry if user clicks it
    setChainExpirySync(s.expiry);
    // Do NOT auto-open chain — user opens it explicitly via Show Chain button
  }

  // Live net credit calculation
  const exitP   = parseFloat(exitPrice)  || 0;
  const newP    = parseFloat(newPremium) || 0;
  const netCred = Math.round((newP - exitP) * trade.contracts * 100);
  const netOk   = netCred > 0;

  // ── Click chain row → fill form ─────────────────────────────
  function applyChainRow(row, expiry) {
    setNewPremium(String(row.mid));
    setEstNewPremium(true);
    if (!isSpread) setNewStrikeSell(String(row.strike));
    if (expiry) setNewExpiry(expiry); // sync expiry — passed directly to avoid stale closure
    setSelectedChainRow(row); // remember for IV passthrough
    setNotes(prev => prev || `Rolled — chain pick $${row.strike} @ $${row.mid}`);
  }

  function submit() {
    const newSell = parseFloat(newStrikeSell);
    const newBuy  = parseFloat(newStrikeBuy);
    const nRoll = Math.max(1, Math.min(parseInt(rollContracts) || (trade.contracts||1), trade.contracts||1));
    onRoll({
      original:      trade,
      exitPrice:     exitP,
      exitDate,
      rollContracts: nRoll,
      newData: {
        strategy:    trade.strategy,
        strike_sell: trade.strike_sell != null ? (isNaN(newSell) ? trade.strike_sell : newSell) : null,
        strike_buy:  trade.strike_buy  != null ? (isNaN(newBuy)  ? trade.strike_buy  : newBuy)  : null,
        expiration:  newExpiry,
        entry_price: newP,
        entry_date:  exitDate,
        notes,
        // Pass live IV and delta from chain row when trader used the chain viewer
        // These override the BS estimates in estimateRolledGreeks()
        ...(selectedChainRow?.iv    != null ? { iv_entry: selectedChainRow.iv }    : {}),
        ...(selectedChainRow?.delta != null ? { delta:    selectedChainRow.delta } : {}),
      },
    });
    onClose();
  }

  const canSubmit = exitP >= 0 && newP > 0 && newExpiry && (newStrikeSell || trade.strike_sell);

  // ── Net credit on a chain row relative to current buy-back ──
  const chainNetCredit = (mid) => exitP > 0
    ? Math.round((mid - exitP) * (parseInt(rollContracts) || trade.contracts || 1) * 100)
    : null;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={{ ...modalStyle, maxWidth: showChain ? 780 : 520, transition: 'max-width 0.2s ease' }}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <div>
            <h3 style={{ marginBottom: 2 }}>Roll {trade.ticker} — {trade.strategy}</h3>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Current: ${strike} strike · {dte != null ? `${dte} DTE` : ''} · entry ${entry}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button
              onClick={() => setShowHelp(h => !h)}
              title="How rolling works — step by step"
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: showHelp ? 'var(--amber-bg)' : 'var(--bg)',
                color: showHelp ? 'var(--amber)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
              ? How to Roll
            </button>
            <button
              onClick={() => {
                const next = !showChain;
                setShowChain(next);
                if (next) {
                  // Always force a re-fetch when opening chain panel
                  const today = localDateISO();
                  const target = newExpiry || (trade.expiration && trade.expiration > today ? trade.expiration : expiryPills[0]);
                  setChainExpirySync(target);
                  // Force re-fetch by clearing cached chain for this expiry
                  if (target) fetchChain(target);
                }
              }}
              style={{ fontSize: 11, padding: '3px 10px', borderRadius: 6, border: '1px solid var(--border)',
                background: showChain ? 'var(--blue-bg)' : 'var(--bg)', color: showChain ? 'var(--blue)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: 600, whiteSpace: 'nowrap' }}>
              {showChain ? '▲ Hide Chain' : '▼ Show Chain'}
            </button>
            <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
          </div>
        </div>

        {/* ── How to Roll — novice help panel ── */}
        {showHelp && (
          <div style={{ margin: '0 16px 4px', padding: '12px 14px',
            background: 'var(--amber-bg)', border: '1px solid var(--amber-border)',
            borderRadius: 8, fontSize: 12, lineHeight: 1.6 }}>
            <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>📖 How to Roll — Step by Step</div>
            <div style={{ display: 'grid', gridTemplateColumns: '20px 1fr', gap: '4px 8px', color: 'var(--text-primary)' }}>
              <span style={{ fontWeight: 700, color: 'var(--amber)' }}>1.</span>
              <span><strong>Enter the buy-back price</strong> — what you'll pay to close the current position (check your broker for the current ask). This unlocks the Net Credit display on each scenario card.</span>
              <span style={{ fontWeight: 700, color: 'var(--amber)' }}>2.</span>
              <span><strong>Choose a scenario</strong> — click one of the 3 cards. Each rolls to a different expiry and/or strike. The card fills the form automatically. <em>Golden rule: only roll for a net credit (green number).</em></span>
              <span style={{ fontWeight: 700, color: 'var(--amber)' }}>3.</span>
              <span><strong>Browse strikes (optional)</strong> — click "Show Chain" to see the full option chain for the selected expiry. Click any row to use that strike and premium instead.</span>
              <span style={{ fontWeight: 700, color: 'var(--amber)' }}>4.</span>
              <span><strong>Adjust if needed</strong> — you can manually change the strike, expiry or premium in the form below.</span>
              <span style={{ fontWeight: 700, color: 'var(--amber)' }}>5.</span>
              <span><strong>Confirm Roll</strong> — the current trade closes at your buy-back price and a new trade opens at the rolled strike and premium.</span>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic' }}>
              Roll at 21 DTE or earlier, and only when you can collect a net credit. Avoid rolling a losing position into a larger one.
            </div>
          </div>
        )}

        {/* ── Scenario suggestions — always visible, no scroll needed ── */}
        <div style={{ padding: '6px 16px 0' }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Suggested Roll Scenarios
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
            {scenarios.map((s, i) => {
              const exitPEntered = parseFloat(exitPrice) > 0;
              return (
                <button
                  key={i}
                  onClick={() => applyScenario(s)}
                  title={s.tooltip}
                  style={{ background: s.bg, border: `1.5px solid ${s.color}33`, borderRadius: 8,
                    padding: '8px 10px', cursor: 'pointer', textAlign: 'left', transition: 'all 0.15s' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: s.color }}>{s.label}</div>
                    {s.isPending
                      ? <span style={{ fontSize: 9, color: 'var(--text-muted)', fontStyle: 'italic' }}>⏳</span>
                      : s.isLive
                        ? <span style={{ fontSize: 9, background: '#d1fae5', color: '#065f46', borderRadius: 4, padding: '1px 5px', fontWeight: 700 }}>live</span>
                        : <span style={{ fontSize: 9, background: 'var(--bg-hover)', color: 'var(--text-muted)', borderRadius: 4, padding: '1px 5px' }}>est</span>
                    }
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 5, lineHeight: 1.4, fontStyle: 'italic' }}>{s.sublabel}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>
                    {s.expiry} · {s.actualDTE} DTE · ${s.newStrike} strike
                  </div>
                  <div style={{ fontSize: 11.5, fontFamily: 'monospace' }}>
                    {s.isPending
                      ? <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>fetching…</span>
                      : <>{s.isLive ? '' : '~'}${s.approxPremium} new premium</>
                    }
                  </div>
                  {s.isLive && s.liveRow && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 1 }}>
                      bid ${s.liveRow.bid?.toFixed(2) ?? '—'} · ask ${s.liveRow.ask?.toFixed(2) ?? '—'}
                      {s.liveRow.delta != null && ` · Δ ${s.liveRow.delta.toFixed(2)}`}
                    </div>
                  )}
                  {exitPEntered && (
                    <div style={{ fontSize: 11, fontFamily: 'monospace', marginTop: 3,
                      color: s.netCredit > 0 ? '#1a7a4a' : '#c0392b', fontWeight: 700 }}>
                      {s.netCredit > 0 ? '+' : ''}{s.netCredit > 0 ? `$${s.netCredit} net credit` : `$${Math.abs(s.netCredit)} net debit ⚠`}
                    </div>
                  )}
                  {!exitPEntered && (
                    <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2, fontStyle: 'italic' }}>Enter buy-back to see net credit</div>
                  )}
                  <div style={{ fontSize: 9, color: s.color, marginTop: 3, opacity: 0.7 }}>{s.isLive ? 'ⓘ hover for details' : <strong>BSM ESTIMATE</strong>}</div>
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4,
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px' }}>
            <span style={{ fontStyle: 'italic' }}>
              Click a scenario to pre-fill. Hover for details.{' '}
              {ivSource !== 'manual' && ivSource !== 'entry' && 'Premiums estimated using IV 30% default.'}
              {ivSource === 'entry' && `Premiums estimated using entry IV ${ivPct.toFixed(0)}%.`}
              {ivSource === 'manual' && `Premiums estimated using your IV ${ivPct.toFixed(0)}%.`}
            </span>
            {ivSource !== 'manual' && (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <span style={{ color: 'var(--text-muted)', fontStyle: 'normal' }}>·</span>
                <label style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap', fontStyle: 'normal' }}>
                  refine IV:
                </label>
                <input
                  type="text" inputMode="decimal"
                  value={manualIv}
                  onChange={e => {
                    const v = e.target.value;
                    if (v === '' || /^\d*\.?\d*$/.test(v)) {
                      setManualIv(v);
                      scenarioChains.current = {};
                      setScenarioPricesReady(0);
                    }
                  }}
                  onBlur={e => {
                    const n = parseFloat(e.target.value);
                    if (isNaN(n) || n <= 0) { setManualIv(''); scenarioChains.current = {}; setScenarioPricesReady(0); }
                  }}
                  placeholder={String(ivPct.toFixed(0))}
                  style={{
                    width: 56, padding: '2px 5px', fontSize: 11,
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--bg-card)',
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-primary)',
                  }}
                />
                <span style={{ color: 'var(--text-muted)', fontStyle: 'normal' }}>%</span>
                {manualIv !== '' && (
                  <button type="button"
                    onClick={() => { setManualIv(''); scenarioChains.current = {}; setScenarioPricesReady(0); }}
                    title="Clear — revert to original IV"
                    style={{ fontSize: 11, lineHeight: 1, padding: '1px 5px',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'transparent',
                      color: 'var(--text-muted)',
                      cursor: 'pointer' }}>
                    ✕
                  </button>
                )}
              </span>
            )}
          </div>
        </div>

        {/* ── Option Chain Panel ── */}
        {showChain && (
          <div style={{ margin: '0 16px 12px', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
            {/* Chain header: expiry pills + source badge */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
              background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)', flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginRight: 4 }}>
                Expiry
              </span>
              {expiryPills.map(exp => (
                <button key={exp} onClick={() => setChainExpirySync(exp)}
                  style={{ fontSize: 11, padding: '2px 10px', borderRadius: 12,
                    border: `1px solid ${chainExpiry === exp ? 'var(--blue)' : 'var(--border)'}`,
                    background: chainExpiry === exp ? 'var(--blue-bg)' : 'var(--bg)',
                    color: chainExpiry === exp ? 'var(--blue)' : 'var(--text-secondary)',
                    cursor: 'pointer', fontWeight: chainExpiry === exp ? 700 : 400 }}>
                  {exp}
                </button>
              ))}
              {/* custom date */}
              <input type="date" value={chainExpiry}
                onChange={e => setChainExpirySync(e.target.value)}
                style={{ fontSize: 11, padding: '2px 6px', borderRadius: 6, border: '1px solid var(--border)',
                  background: 'var(--bg)', color: 'var(--text)', width: 130 }} />
              {chainSource && (
                <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-muted)',
                  background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 10, padding: '1px 8px' }}>
                  <strong>{chainSource === 'BSM estimate' ? 'BSM ESTIMATE' : chainSource}</strong>
                </span>
              )}
            </div>

            {/* Chain table */}
            <div style={{ overflowY: 'auto', maxHeight: 260 }}>
              {chainLoading && (
                <div style={{ padding: '16px', textAlign: 'center' }}>
                  {/* Skeleton rows */}
                  {[1,2,3,4].map(i => (
                    <div key={i} style={{ display: 'grid', gridTemplateColumns: '70px 60px 60px 65px 55px 60px 60px',
                      gap: 8, padding: '6px 12px', borderBottom: '1px solid var(--border)' }}>
                      {[1,2,3,4,5,6,7].map(j => (
                        <div key={j} style={{ height: 12, borderRadius: 4, background: 'var(--border)', opacity: 0.5 }} />
                      ))}
                    </div>
                  ))}
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>Loading chain…</div>
                </div>
              )}
              {!chainLoading && chainError && (
                <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  {chainError}
                </div>
              )}
              {!chainLoading && !chainError && chainRows.length === 0 && chainExpiry && (
                <div style={{ padding: '14px 16px', fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>
                  No chain data returned for {chainExpiry}. Try a different expiry or enter manually.
                </div>
              )}
              {!chainLoading && chainRows.length > 0 && (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11.5 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-secondary)', position: 'sticky', top: 0 }}>
                      {['Strike','Bid','Ask','Mid','IV %','Delta','Net Credit'].map(h => (
                        <th key={h} style={{ padding: '5px 10px', textAlign: 'right', fontWeight: 700,
                          fontSize: 10, color: 'var(--text-muted)', borderBottom: '1px solid var(--border)',
                          whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {chainRows.map((row, i) => {
                      const isCurrentStrike = Math.abs(row.strike - strike) < 2.5;
                      const net = chainNetCredit(row.mid);
                      const isSelected = String(row.strike) === newStrikeSell && String(row.mid) === newPremium;
                      return (
                        <tr key={i}
                          onClick={() => applyChainRow(row, chainExpiryRef.current)}
                          title="Click to use this strike and premium"
                          style={{
                            cursor: 'pointer',
                            background: isSelected ? 'var(--blue-bg)' : isCurrentStrike ? 'var(--amber-bg)' : i % 2 === 0 ? 'var(--bg)' : 'var(--bg-secondary)',
                            borderLeft: isCurrentStrike ? '3px solid var(--amber)' : isSelected ? '3px solid var(--blue)' : '3px solid transparent',
                          }}>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: isCurrentStrike ? 700 : 400 }}>
                            ${row.strike}
                            {isCurrentStrike && <span style={{ fontSize: 9, color: 'var(--text-muted)', marginLeft: 4 }}>cur</span>}
                          </td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{row.bid > 0 ? row.bid.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{row.ask > 0 ? row.ask.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{row.mid > 0 ? row.mid.toFixed(2) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', color: 'var(--text-secondary)' }}>{row.iv != null ? row.iv.toFixed(1) : '—'}</td>
                          <td style={{ padding: '5px 10px', textAlign: 'right',
                            color: row.delta == null ? 'var(--text-muted)'
                              : Math.abs(row.delta) > 0.30 ? '#c0392b'
                              : Math.abs(row.delta) > 0.20 ? '#b7730a' : '#1a7a4a' }}>
                            {row.delta != null ? row.delta.toFixed(2) : '—'}
                          </td>
                          <td style={{ padding: '5px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 700,
                            color: net == null ? 'var(--text-muted)' : net > 0 ? '#1a7a4a' : '#c0392b' }}>
                            {net == null ? '—' : net > 0 ? `+$${net}` : `−$${Math.abs(net)}`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: '5px 12px', fontSize: 10, color: 'var(--text-muted)', borderTop: '1px solid var(--border)' }}>
              Click any row to apply strike &amp; premium. Amber = current strike. Net credit requires buy-back price above.
              {isMock && ' · Demo: BSM estimates, not live market prices.'}
            </div>
          </div>
        )}

        {/* ── Close existing + New position — scrollable so scenarios always visible ── */}
        <div style={{ overflowY: 'auto', flex: 1 }}>
        <div className="modal-section-title">1 · Close Existing Position</div>
        <div className="form-grid-2" style={{ padding: '0 16px' }}>
          <div className="form-group">
            <label className="form-label">Roll Date</label>
            <input type="date" value={exitDate} onChange={e => setExitDate(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Buy Back Price</label>
            <input type="number" step="0.01" value={exitPrice} onChange={e => setExitPrice(e.target.value)} placeholder="e.g. 2.80" />
          </div>
        </div>

        {/* ── New position ── */}
        <div className="modal-section-title">2 · New Position</div>
        <div style={{ padding: '0 16px' }}>
          {isSpread ? (
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label">New Sell Strike <span style={{ color:'var(--text-muted)', fontSize:11 }}>(was {trade.strike_sell})</span></label>
                <input type="number" step="0.5" value={newStrikeSell} onChange={e => setNewStrikeSell(e.target.value)} placeholder={String(trade.strike_sell)} />
                {occStrikeWarn(newStrikeSell, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || trade.strike_sell) && (
                  <div style={{ fontSize:10, color:'var(--amber)', marginTop:3 }}>⚠ {occStrikeWarn(newStrikeSell, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || trade.strike_sell)}</div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">New Buy Strike <span style={{ color:'var(--text-muted)', fontSize:11 }}>(was {trade.strike_buy})</span></label>
                <input type="number" step="0.5" value={newStrikeBuy} onChange={e => setNewStrikeBuy(e.target.value)} placeholder={String(trade.strike_buy)} />
                {occStrikeWarn(newStrikeBuy, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || trade.strike_buy) && (
                  <div style={{ fontSize:10, color:'var(--amber)', marginTop:3 }}>⚠ {occStrikeWarn(newStrikeBuy, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || trade.strike_buy)}</div>
                )}
              </div>
            </div>
          ) : (
            <div className="form-grid-2">
              <div className="form-group">
                <label className="form-label">New Strike</label>
                <input type="number" step="0.5" value={newStrikeSell} onChange={e => setNewStrikeSell(e.target.value)} placeholder={String(strike)} />
                {occStrikeWarn(newStrikeSell, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || strike) && (
                  <div style={{ fontSize:10, color:'var(--amber)', marginTop:3 }}>
                    ⚠ {occStrikeWarn(newStrikeSell, currentPrices?.[trade.ticker?.toUpperCase()]?.stock || strike)}
                  </div>
                )}
              </div>
              <div className="form-group">
                <label className="form-label">New Expiration</label>
                <ExpiryDatePicker key={newExpiry} value={newExpiry} onChange={setNewExpiry} min={historicalMode ? undefined : localDateISO()} />
              </div>
            </div>
          )}
          {isSpread && (
            <div className="form-group">
              <label className="form-label">New Expiration</label>
              <ExpiryDatePicker key={newExpiry} value={newExpiry} onChange={setNewExpiry} min={historicalMode ? undefined : localDateISO()} />
            </div>
          )}
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">New Premium Collected</label>
              <input type="number" step="0.01" value={newPremium}
                onChange={e => { setNewPremium(e.target.value); setEstNewPremium(false); }}
                placeholder="e.g. 3.50"
                style={{ borderColor: estNewPremium ? 'var(--amber,#b7730a)' : '' }} />
              {estNewPremium && newPremium && (
                <div style={{ fontSize: 10, color: 'var(--amber,#92600a)', marginTop: 3,
                  display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)',
                    borderRadius: 3, padding: '1px 5px', fontWeight: 700, fontSize: 10 }}>est.</span>
                  Enter your actual fill price after executing with your broker
                </div>
              )}
            </div>
            <div className="form-group">
              <label className="form-label">Notes</label>
              <input type="text" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional..." />
            </div>
          </div>
          {(trade.contracts || 1) > 1 && (
            <div className="form-group" style={{ marginTop: 6 }}>
              <label className="form-label">
                Contracts to roll
                <span style={{ color:'var(--color-text-secondary)', fontSize:11, marginLeft:6 }}>
                  (1–{trade.contracts}, default = all)
                </span>
              </label>
              <input type="number" min="1" max={trade.contracts} step="1"
                value={rollContracts} onChange={e => setRollContracts(e.target.value)}
                style={{ width: 90 }} />
              {parseInt(rollContracts) < (trade.contracts||1) && (
                <div style={{ fontSize:11, color:'var(--color-text-warning)', marginTop:3 }}>
                  Partial roll — {(trade.contracts||1) - parseInt(rollContracts)} contract{(trade.contracts||1)-parseInt(rollContracts)!==1?'s':''} stay open at current strike/expiry
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Live net credit ── */}
        {exitP > 0 && newP > 0 && (
          <div style={{ margin: '4px 16px 12px', padding: '10px 14px', borderRadius: 8,
            background: netOk ? '#edf7f2' : '#fdf0ee',
            border: `1px solid ${netOk ? '#a8d5bc' : '#f0c4be'}` }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: netOk ? '#1a7a4a' : '#c0392b' }}>
              {netOk ? '✓' : '⚠'} Net {netOk ? 'credit' : 'debit'} on roll:{' '}
              <span style={{ fontFamily: 'monospace', fontSize: 14 }}>
                {netOk ? '+' : ''}{netCred > 0 ? '$' + netCred : '−$' + Math.abs(netCred)}
              </span>
              <span style={{ fontSize: 11, fontWeight: 400, marginLeft: 8 }}>
                ({newP} new − {exitP} buy-back) × {trade.contracts} × 100
              </span>
            </div>
            {!netOk && (
              <div style={{ fontSize: 11.5, color: '#c0392b', marginTop: 4 }}>
                Rolling for a net debit compounds a losing position. Consider a higher strike or later expiry.
              </div>
            )}
          </div>
        )}

        {/* ── Net cost basis warning on CC roll ── */}
        {isCall && trade.lot_id && newStrikeSell && (() => {
          const lot = lots.find(l => l.id === trade.lot_id);
          if (!lot) return null;
          const lotTrades = trades.filter(t => t.lot_id === lot.id);
          const lotPrem   = lotTrades.filter(t => CREDIT_STRATEGIES.includes(t.strategy)).reduce((sum, t) => {
            const ep = t.entry_price || 0, xp = t.exit_price || 0;
            const isClosed = t.status === 'closed';
            const isAssign = isClosed && t.strategy === 'Cash-Secured Put' &&
              (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
               (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
            return sum + (ep - (isClosed ? (isAssign ? 0 : xp) : 0)) * (t.contracts || 1) * 100;
          }, 0);
          const netCost  = lot.avg_cost - (lotPrem / (lot.shares || 1));
          const newStrike = parseFloat(newStrikeSell);
          if (newStrike < netCost) {
            return (
              <div style={{ margin: '0 16px 12px', padding: '10px 14px', borderRadius: 8,
                background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--amber,#92600a)' }}>
                  ⚠ New strike ${newStrike} is below your net cost basis of ${netCost.toFixed(2)}/sh
                </div>
                <div style={{ fontSize: 11, color: 'var(--amber,#92600a)', marginTop: 3 }}>
                  If called away at this strike, you will realise a net loss on this wheel position. Consider rolling to a higher strike.
                </div>
              </div>
            );
          }
          if (newStrike < lot.avg_cost) {
            return (
              <div style={{ margin: '0 16px 12px', padding: '10px 14px', borderRadius: 8,
                background: 'var(--blue-bg,#eef4ff)', border: '1px solid var(--blue-border,#b5d0f7)' }}>
                <div style={{ fontSize: 11, color: 'var(--blue,#1a5fa8)' }}>
                  ℹ Strike ${newStrike} is below purchase price ${lot.avg_cost} but above net cost ${netCost.toFixed(2)}/sh — still profitable overall if called away. ✓
                </div>
              </div>
            );
          }
          return null;
        })()}

        </div>{/* end scrollable form */}
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            Roll Trade
          </button>
        </div>
      </div>
    </div>
  );
}

// ── GreeksPopup ──────────────────────────────────────────
function GreeksPopup({ trade, style }) {
  const fields = [
    { label: 'Delta', value: trade.delta?.toFixed(3) },
    { label: 'Gamma', value: trade.gamma?.toFixed(4) },
    { label: 'Theta', value: trade.theta?.toFixed(3) },
    { label: 'Vega',  value: trade.vega?.toFixed(3) },
    { label: 'IV',    value: trade.iv_entry ? trade.iv_entry.toFixed(1) + '%' : null },
  ].filter(f => f.value != null);

  if (!fields.length) return null;
  return (
    <div className="greeks-popup" style={style}>
      <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 8 }}>Greeks at Entry</div>
      <div className="greeks-grid">
        {fields.map(f => (
          <div key={f.label} className="greek-item">
            <div className="greek-label">{f.label}</div>
            <div className="greek-value">{f.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── TheoPnl ───────────────────────────────────────────────
// Priority:
//   1. Opt $ available (Yahoo or manual)  → exact P&L, no BS needed
//   2. Opt $ blank, IV available (Yahoo or manual) + Stock $ → BS estimate
//   3. Neither → null (shows '—')
// curIv is the CURRENT IV % (from Yahoo fetch or manual entry),
// trade.iv_entry is the stored entry IV — used only when curIv is also absent.
function calcTheoPnl(trade, curOptPrice, curStkPrice, curIv) {
  const entry    = trade.entry_price || 0;
  const isCredit = CREDIT_STRATEGIES.includes(trade.strategy);

  // Priority 1: use current option price if available (exact — no model needed).
  // This now works for ALL strategies including IC legs, Calendar legs, Straddle etc.
  // because the fetch layer now retrieves option prices for all of them.
  if (curOptPrice) {
    const op = parseFloat(curOptPrice);
    if (!isNaN(op) && op >= 0) {
      if (isCredit) return { pnl: Math.round((entry - op) * trade.contracts * 100), isEstimate: false };
      return { pnl: Math.round((op - entry) * trade.contracts * 100), isEstimate: false };
    }
  }

  // Priority 2: Black-Scholes estimate from stock price + IV.
  // Skip for multi-leg chain strategies where a single-strike BS is meaningless
  // (IC/IB = 4 strikes across 2 legs, Calendar/Diagonal = 2 different expiries).
  // For all other strategies, uses the same per-strategy formula as Dashboard.jsx
  // closeOutOptionPnl loop so Theo P&L always equals the Close-Out contribution.
  //
  // Spread strategies (BCS/BPS/BullCS/BearPS): 2-leg net spread BSM
  //   BCS / BullCS (call spreads):  BSM(short_call,kSell) - BSM(long_call,kBuy)
  //   BPS / BearPS (put  spreads):  BSM(long_put,kBuy)   - BSM(short_put,kSell)
  // Single-leg strategies: single-strike BSM on the relevant strike
  // Straddle/Strangle: skip (no useful single-strike proxy, must use Opt $)
  const SKIP_BS  = new Set(['Iron Condor','Iron Butterfly','Calendar Spread','Diagonal Spread']);
  const SKIP_EST = new Set(['Long Straddle','Long Strangle']);
  if (!SKIP_BS.has(trade.strategy) && !SKIP_EST.has(trade.strategy)) {
    const S     = parseFloat(curStkPrice) || 0;
    const kSell = parseFloat(trade.strike_sell) || 0;
    const kBuy  = parseFloat(trade.strike_buy)  || 0;
    const ivPct = curIv ? parseFloat(curIv) : (trade.iv_entry || 0);
    const iv    = ivPct / 100;
    const expD  = trade.expiration ? new Date(trade.expiration) : null;
    const T     = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
    const r     = DEFAULT_RISK_FREE_RATE;
    const strat = trade.strategy;

    if (S > 0 && iv > 0 && T > 0) {
      let bsVal = null;

      // Single-leg strategies
      if (strat === 'Covered Call' && kSell)
        bsVal = blackScholes(S, kSell, T, r, iv, true);
      else if (strat === 'Cash-Secured Put' && kBuy)
        bsVal = blackScholes(S, kBuy,  T, r, iv, false);
      else if (strat === 'Long Call' && kBuy)
        bsVal = blackScholes(S, kBuy,  T, r, iv, true);
      else if (strat === 'Long Put' && kBuy)
        bsVal = blackScholes(S, kBuy,  T, r, iv, false);

      // 2-leg net spread — mirrors Dashboard closeOutOptionPnl exactly
      else if ((strat === 'Bear Call Spread' || strat === 'Bull Call Spread') && kSell && kBuy)
        bsVal = blackScholes(S, kSell, T, r, iv, true) - blackScholes(S, kBuy, T, r, iv, true);
      else if ((strat === 'Bull Put Spread' || strat === 'Bear Put Spread') && kSell && kBuy)
        bsVal = blackScholes(S, kBuy,  T, r, iv, false) - blackScholes(S, kSell, T, r, iv, false);

      if (bsVal != null && bsVal >= 0) {
        const pnl = isCredit
          ? (entry - bsVal) * trade.contracts * 100
          : (bsVal - entry) * trade.contracts * 100;
        return { pnl: Math.round(pnl), isEstimate: true, usedCurrentIv: !!curIv };
      }
    }
  }

  return null;
}

// ── Export CSV ────────────────────────────────────────────
function exportCSV(trades) {
  const headers = [
    'Ticker','Strategy','Status',
    'Entry Date','Expiration','Exit Date',
    'Strike Sell','Strike Buy','Entry Price','Exit Price',
    'Contracts','P&L',
    'Delta','Gamma','Theta','Vega','IV %',
    'Roll Count','Lot ID',
    'Notes',
  ];
  const rows = trades.map(t => [
    t.ticker, t.strategy, t.status,
    t.entry_date || '', t.expiration || '', t.exit_date || '',
    t.strike_sell ?? '', t.strike_buy ?? '',
    t.entry_price ?? '', t.exit_price ?? '',
    t.contracts, t.pnl ?? '',
    t.delta ?? '', t.gamma ?? '', t.theta ?? '', t.vega ?? '', t.iv_entry ?? '',
    t.roll_count ?? 0, t.lot_id ?? '',
    t.notes || '',
  ]);
  const csv = [headers, ...rows]
    .map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"` ).join(','))
    .join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `myoptiondiary-export-${localDateISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
// ── DualScrollTable ───────────────────────────────────────
// Renders a top phantom scrollbar + the real table scrollbar at the bottom,
// kept in sync so the user can scroll from either end of a long table.
function DualScrollTable({ children }) {
  const topBarRef   = useRef(null);
  const tableRef    = useRef(null);
  const syncingRef  = useRef(false); // prevents scroll event loops

  function onTopScroll() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    if (tableRef.current) tableRef.current.scrollLeft = topBarRef.current.scrollLeft;
    syncingRef.current = false;
  }

  function onTableScroll() {
    if (syncingRef.current) return;
    syncingRef.current = true;
    if (topBarRef.current) topBarRef.current.scrollLeft = tableRef.current.scrollLeft;
    syncingRef.current = false;
  }

  // Keep the phantom bar's inner width in sync with the real table's scroll width
  useEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const phantom = topBarRef.current?.firstChild;
    if (!phantom) return;
    function syncWidth() {
      phantom.style.width = table.scrollWidth + 'px';
    }
    syncWidth();
    // Re-sync if the table resizes (e.g. columns added/removed)
    const ro = new ResizeObserver(syncWidth);
    ro.observe(table);
    return () => ro.disconnect();
  }, []);

  return (
    <>
      {/* Top phantom scrollbar */}
      <div
        ref={topBarRef}
        onScroll={onTopScroll}
        style={{ overflowX: 'auto', overflowY: 'hidden', height: 10, marginBottom: 2 }}
      >
        {/* Phantom inner — width matched to table scrollWidth via ResizeObserver */}
        <div style={{ height: 1 }} />
      </div>
      {/* Real scrollable table */}
      <div ref={tableRef} onScroll={onTableScroll} style={{ overflowX: 'auto' }}>
        {children}
      </div>
    </>
  );
}

// ── AlertsCommandCenter removed — now lives in src/components/Alerts.jsx ──

export default function TradeLog({ trades, lots, isMock, historicalMode = false, pill, onEdit, onDelete, onRoll, onAssignment, onCalledAway, onCloseTrade, onExpired, onImport, onAddTrade, currentPrices, onICAdjust, onCalAdjust, onOpenCalAdjust, onDeleteChain, onPriceUpdate, yahooStatus, onFetchYahoo, pricesUpdatedAt, liveStatus, initialSearch = '', initialFilter = 'Open', filterLotId = null, filterTickers = null, onClearFilterTickers, pendingRollTrade = null, onClearPendingRoll }) {


  const [search,         setSearch]         = useState(initialSearch);
  const [filter,         setFilter]         = useState(initialFilter);
  const [winLossSub,     setWinLossSub]     = useState('Open'); // sub-filter for Winners/Losers: Open|Closed|All
  const [sortKey,        setSortKey]        = useState('entry_date');
  const [sortDir,        setSortDir]        = useState('desc');
  const [rollingTrade,   setRollingTrade]   = useState(null);

  // Open RollModal automatically when a trade is staged from Alerts
  React.useEffect(() => {
    if (pendingRollTrade) {
      setRollingTrade(pendingRollTrade);
      if (onClearPendingRoll) onClearPendingRoll();
    }
  }, [pendingRollTrade]); // eslint-disable-line react-hooks/exhaustive-deps
  const [adjustingIC,    setAdjustingIC]    = useState(null);  // { trade, chainTrades }
  const [expandedChains, setExpandedChains] = useState({});    // chain_id → bool
  const [pnlCurvePopup,  setPnlCurvePopup]  = useState(null);  // { trade, data, iv, ivLabel, stockPrice }
  const [curvePos,       setCurvePos]       = useState(null);  // {x,y} when dragged; null = centred
  const [curveDragging,  setCurveDragging]  = useState(false);
  const curveDragOffset  = React.useRef({ x: 0, y: 0 });
  const curveModalRef    = React.useRef(null);
  const [popupIv,        setPopupIv]        = useState({});    // tradeId → iv override
  const [explainId,      setExplainId]      = useState(null);  // trade id — looked up fresh from trades on each render
  const [greeksTrade,    setGreeksTrade]    = useState(null);
  const [greeksPos,      setGreeksPos]      = useState({ top: 0, left: 0 });
  const [optPrices,      setOptPrices]      = useState({});
  const [stkPrices,      setStkPrices]      = useState({});
  const [ivPrices,       setIvPrices]       = useState({});  // tradeId → current IV % (manual override)

  const openTrades = trades.filter(t => t.status === 'open');

  // ── IC chain grouping ─────────────────────────────────
  // Group trades by condor_chain_id; non-chain trades have key null
  const { chainGroups } = useMemo(() => {
    const groups = {};
    trades.forEach(t => {
      if (t.condor_chain_id) {
        if (!groups[t.condor_chain_id]) groups[t.condor_chain_id] = [];
        groups[t.condor_chain_id].push(t);
      }
    });
    return { chainGroups: groups };
  }, [trades]);

  // Group trades by cal_chain_id for calendar spread chains
  const calChainGroups = useMemo(() => {
    const groups = {};
    trades.forEach(t => {
      if (t.cal_chain_id != null) {
        const key = String(t.cal_chain_id);
        if (!groups[key]) groups[key] = [];
        groups[key].push(t);
      }
    });
    return groups;
  }, [trades]);

  // Compute calendar chain P&L from all legs
  function computeCalChainPnL(chainTrades, prices) {
    // Single source of truth for Calendar/Diagonal unrealised P&L.
    // Priority 1: currentPrices[t.id].option — exact live/Yahoo/broker price.
    // Priority 2: inline BSM using currentPrices[ticker].stock — same source and
    //             same formula as Dashboard.jsx closeOutOptionPnl Calendar loop.
    //             Ensures TradeLog and Close-Out panel are always in sync,
    //             even when Yahoo is down, market is closed, or on weekends.
    let realisedPnL = 0, unrealisedPnL = 0, hasPrices = false, isBsEst = false;
    const ticker = chainTrades[0]?.ticker?.toUpperCase();
    const stockPrice = ticker ? parseFloat(
      prices?.[ticker]?.stock ||
      Object.values(prices || {}).find(p => p?.ticker === ticker)?.stock
    ) || 0 : 0;

    chainTrades.forEach(t => {
      if (t.pnl != null) realisedPnL += t.pnl;
      realisedPnL += t.partial_close_pnl || 0;
      if (t.status !== 'open') return;

      const entry  = parseFloat(t.entry_price) || 0;
      const openC  = t.contracts_open ?? t.contracts ?? 1;
      const isShort = t.cal_leg === 'short';
      const cur    = prices?.[t.id]?.option;

      if (cur != null) {
        // Priority 1: exact price available
        hasPrices = true;
        // Use contracts_open (not contracts) so partially-reduced legs are correctly sized.
        unrealisedPnL += isShort
          ? (entry - cur) * openC * 100
          : (cur - entry) * openC * 100;
      } else if (stockPrice > 0) {
        // Priority 2: inline BSM — mirrors Dashboard Calendar loop exactly
        const ivPct = prices?.[t.id]?.iv != null ? prices[t.id].iv : (t.iv_entry || DEFAULT_BSM_IV);
        const iv    = ivPct ? ivPct / 100 : null;
        const k     = parseFloat(t.strike_sell || t.strike_buy) || 0;
        const expD  = t.expiration ? new Date(t.expiration) : null;
        const T     = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
        if (iv && T > 0 && k) {
          const isCallOpt = t.option_type !== 'put';
          const bsOpt = bsmPrice(stockPrice, k, T, iv, isCallOpt, DEFAULT_RISK_FREE_RATE);
          if (bsOpt != null && bsOpt >= 0) {
            unrealisedPnL += isShort
              ? (entry - bsOpt) * openC * 100
              : (bsOpt - entry) * openC * 100;
            hasPrices = true;
            isBsEst   = true;
          }
        }
      }
    });
    const chainClosed = chainTrades.every(t => t.status === 'closed');
    const openLegs    = chainTrades.filter(t => t.status === 'open');
    return { realisedPnL, unrealisedPnL, totalPnL: realisedPnL + unrealisedPnL, chainClosed, openLegs, hasPrices, isBsEst };
  }

  // Compute chain P&L for a set of chain trades (IC / IB)
  // hasPrices tracks whether ANY leg had a current option price available.
  // This distinguishes "no price fetched yet → show —" from "price=entry → show +$0.00".
  // Mirrors the same hasPrices pattern used by computeCalChainPnL for Calendar chains.
  function computeChainPnL(chainTrades, prices) {
    // Single source of truth for IC/IB unrealised P&L.
    // Priority 1: currentPrices[t.id].option — exact live/Yahoo/broker price.
    // Priority 2: inline BSM using currentPrices[ticker].stock — same source and
    //             same formula as Dashboard.jsx closeOutOptionPnl IC loop.
    //             Ensures TradeLog and Close-Out panel are always in sync,
    //             even when Yahoo is down, market is closed, or on weekends.
    let realisedPnL = 0, unrealisedPnL = 0, hasPrices = false, isBsEst = false;
    const ticker = chainTrades[0]?.ticker?.toUpperCase();
    const stockPrice = ticker ? parseFloat(
      prices?.[ticker]?.stock ||
      Object.values(prices || {}).find(p => p?.ticker === ticker)?.stock
    ) || 0 : 0;

    chainTrades.forEach(t => {
      const closed = t.contracts_closed || 0;
      if (closed > 0 && t.exit_price != null) {
        realisedPnL += (t.entry_price - t.exit_price) * closed * 100;
      }
      realisedPnL += t.partial_close_pnl || 0;
      const cRaw = t.contracts_open != null ? t.contracts_open : (t.contracts ?? 1);
      const c    = cRaw > 0 ? cRaw : 0;
      if (c <= 0 || !prices) return;

      const entry = parseFloat(t.entry_price) || 0;
      const cur   = prices[t.id]?.option;

      if (cur != null) {
        // Priority 1: exact price available
        hasPrices = true;
        unrealisedPnL += (entry - cur) * c * 100;
      } else if (stockPrice > 0) {
        // Priority 2: inline BSM — mirrors Dashboard IC loop exactly
        const ivPct = prices[t.id]?.iv != null ? prices[t.id].iv : (t.iv_entry || DEFAULT_BSM_IV);
        const iv    = ivPct ? ivPct / 100 : null;
        const kS    = parseFloat(t.strike_sell) || 0;
        const kB    = parseFloat(t.strike_buy)  || 0;
        const expD  = t.expiration ? new Date(t.expiration) : null;
        const T     = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
        if (iv && T > 0 && kS && kB) {
          const isCall   = (t.condor_leg === 'call' || t.condor_leg === 'full'); // 'full' = IB body leg, priced as call side
          const bsSpread = Math.max(0,
            bsmPrice(stockPrice, kS, T, iv, isCall, DEFAULT_RISK_FREE_RATE) -
            bsmPrice(stockPrice, kB, T, iv, isCall, DEFAULT_RISK_FREE_RATE)
          );
          unrealisedPnL += (entry - bsSpread) * c * 100;
          hasPrices = true;
          isBsEst   = true;
        }
      }
    });
    const chainClosed = chainTrades.every(t => (t.contracts_open || 0) === 0);
    const openLegs    = chainTrades.filter(t => (t.contracts_open || 0) > 0).map(t => t.condor_leg);
    return { realisedPnL, unrealisedPnL, totalPnL: realisedPnL + unrealisedPnL, chainClosed, openLegs, hasPrices, isBsEst };
  }

  const filtered = useMemo(() => {
    return trades.filter(t => {
      // IC chain trades are shown in the chain groups section above — exclude from main table
      if (t.condor_chain_id) return false;  // IC/IB chains shown in chain section
      if (t.cal_chain_id != null) return false; // Calendar chains shown in chain section
      // Dashboard bucket filter — only show tickers in the selected bucket
      if (filterTickers && !filterTickers.has(t.ticker)) return false;
      // Lot filter — when navigating from Wheel Summary, show only this lot's trades
      if (filterLotId != null && t.lot_id !== filterLotId) return false;
      const q = search.toLowerCase();
      const matchSearch = !q || t.ticker.toLowerCase().includes(q) || t.strategy.toLowerCase().includes(q) || (t.notes || '').toLowerCase().includes(q);
      const matchFilter = filter === 'All' ? true
        : filter === 'Open'   ? t.status === 'open'
        : filter === 'Closed' ? t.status === 'closed'
        : filter === 'Win'    ? (() => {
            if (winLossSub === 'Closed') return t.status === 'closed' && t.pnl != null && t.pnl > 0;
            if (winLossSub === 'Open')   {
              if (t.status !== 'open') return false;
              const curOpt = currentPrices[t.id]?.option;
              if (curOpt == null) return false;
              const CREDIT = ['Covered Call','Cash-Secured Put','Bear Call Spread','Bull Put Spread','Iron Condor','Iron Butterfly'];
              const pnlEst = CREDIT.includes(t.strategy)
                ? (parseFloat(t.entry_price)-curOpt)*(t.contracts||1)*100
                : (curOpt-parseFloat(t.entry_price))*(t.contracts||1)*100;
              return pnlEst > 0;
            }
            // All: closed with pnl>0 OR open with positive unrealised
            if (t.status === 'closed') return t.pnl != null && t.pnl > 0;
            const curOpt = currentPrices[t.id]?.option;
            if (curOpt == null) return false;
            const CREDIT = ['Covered Call','Cash-Secured Put','Bear Call Spread','Bull Put Spread','Iron Condor','Iron Butterfly'];
            const pnlEst = CREDIT.includes(t.strategy)
              ? (parseFloat(t.entry_price)-curOpt)*(t.contracts||1)*100
              : (curOpt-parseFloat(t.entry_price))*(t.contracts||1)*100;
            return pnlEst > 0;
          })()
        : filter === 'Loss'   ? (() => {
            if (winLossSub === 'Closed') return t.status === 'closed' && t.pnl != null && t.pnl < 0;
            if (winLossSub === 'Open')   {
              if (t.status !== 'open') return false;
              const curOpt = currentPrices[t.id]?.option;
              if (curOpt == null) return false;
              const CREDIT = ['Covered Call','Cash-Secured Put','Bear Call Spread','Bull Put Spread','Iron Condor','Iron Butterfly'];
              const pnlEst = CREDIT.includes(t.strategy)
                ? (parseFloat(t.entry_price)-curOpt)*(t.contracts||1)*100
                : (curOpt-parseFloat(t.entry_price))*(t.contracts||1)*100;
              return pnlEst < 0;
            }
            // All: closed with pnl<0 OR open with negative unrealised
            if (t.status === 'closed') return t.pnl != null && t.pnl < 0;
            const curOpt = currentPrices[t.id]?.option;
            if (curOpt == null) return false;
            const CREDIT = ['Covered Call','Cash-Secured Put','Bear Call Spread','Bull Put Spread','Iron Condor','Iron Butterfly'];
            const pnlEst = CREDIT.includes(t.strategy)
              ? (parseFloat(t.entry_price)-curOpt)*(t.contracts||1)*100
              : (curOpt-parseFloat(t.entry_price))*(t.contracts||1)*100;
            return pnlEst < 0;
          })()
        : true;
      return matchSearch && matchFilter;
    }).sort((a, b) => {
      let aV = a[sortKey], bV = b[sortKey];
      if (aV == null) return 1;
      if (bV == null) return -1;
      if (typeof aV === 'string') aV = aV.toLowerCase();
      if (typeof bV === 'string') bV = bV.toLowerCase();
      return sortDir === 'asc' ? (aV < bV ? -1 : 1) : (aV > bV ? -1 : 1);
    });
  }, [trades, search, filter, sortKey, sortDir, filterTickers]);

  function sort(key) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
  }

  function sortIcon(key) {
    if (sortKey !== key) return ' ↕';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  }

  // ── P&L Curve popup drag ──────────────────────────────
  useEffect(() => {
    if (!curveDragging) return;
    const onMove = (e) => {
      const newX = e.clientX - curveDragOffset.current.x;
      const newY = e.clientY - curveDragOffset.current.y;
      const rect = curveModalRef.current?.getBoundingClientRect();
      const w = rect?.width || 460;
      setCurvePos({
        x: Math.max(-w + 80, Math.min(window.innerWidth - 80, newX)),
        y: Math.max(0, Math.min(window.innerHeight - 80, newY)),
      });
    };
    const onUp = () => setCurveDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [curveDragging]);

  const getOptPrice = (id) => optPrices[id] ?? (currentPrices[id]?.option ?? '');
  // getStkPrice: check per-trade id first (Yahoo writes both), then ticker key
  // (Tradier/Schwab/Polygon write stock prices under ticker only)
  const getStkPrice = (id, ticker) => {
    if (stkPrices[id] !== undefined) return stkPrices[id];
    if (currentPrices[id]?.stock    != null) return currentPrices[id].stock;
    if (ticker && currentPrices[ticker?.toUpperCase()]?.stock != null)
      return currentPrices[ticker.toUpperCase()].stock;
    return '';
  };
  // IV: manual override first, then per-trade Yahoo/broker data
  const getIvPrice = (id, trade) => ivPrices[id] ?? (currentPrices[id]?.iv != null ? currentPrices[id].iv : '');

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <h2>Trade Log</h2>
          {pill}
          <div className="subtitle">
            {trades.filter(t => !t.condor_chain_id && t.cal_chain_id == null).length} trades · {trades.filter(t => !t.condor_chain_id && t.cal_chain_id == null && t.status==='open').length} open · {trades.filter(t => !t.condor_chain_id && t.cal_chain_id == null && t.status==='closed').length} closed
            {Object.keys(chainGroups).length > 0 && ` · ${Object.keys(chainGroups).length} IC chain${Object.keys(chainGroups).length !== 1 ? 's' : ''}`}
            {Object.keys(calChainGroups).length > 0 && ` · ${Object.keys(calChainGroups).length} Calendar chain${Object.keys(calChainGroups).length !== 1 ? 's' : ''}`}
          </div>
        </div>
      </div>

      {/* ── Dashboard bucket filter banner ── */}
      {filterTickers && filterTickers.size > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px',
          background: 'var(--blue-bg)', border: '1px solid var(--blue-border,#b5d4f4)',
          borderRadius: 8, marginBottom: 10, fontSize: 12 }}>
          <span style={{ color: 'var(--blue)', fontWeight: 700 }}>Filtered:</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            Showing trades for {[...filterTickers].sort().join(', ')} · {filtered.length} trade{filtered.length !== 1 ? 's' : ''}
            {filtered.length === 0 && ' — no open trades. Use + Log Trade to write a covered call.'}
          </span>
          <button onClick={() => onClearFilterTickers?.()}
            style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 10px', borderRadius: 6,
              border: '1px solid var(--blue)', background: 'transparent', color: 'var(--blue)',
              cursor: 'pointer', fontWeight: 600 }}>
            ✕ Clear filter
          </button>
        </div>
      )}

      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-left">
          <input className="search-input" placeholder="Search ticker, strategy, notes..." value={search} onChange={e => { setSearch(e.target.value); if (filterTickers) onClearFilterTickers?.(); }} style={{ width: 240 }} />
          <div className="filter-chips">
            {[
              { key: 'All',    label: 'All' },
              { key: 'Open',   label: 'Open' },
              { key: 'Closed', label: 'Closed' },
              { key: 'Win',    label: 'Winners' },
              { key: 'Loss',   label: 'Losers' },
            ].map(f => (
              <button key={f.key} className={`filter-chip ${filter === f.key ? 'active' : ''}`} onClick={() => { setFilter(f.key); if (f.key === 'Win' || f.key === 'Loss') setWinLossSub('Open'); }}>{f.label}</button>
            ))}
          </div>
        </div>
        <div className="toolbar-right">
          <button className="btn btn-outline btn-sm" onClick={() => exportCSV(filtered)}>↓ Export CSV</button>
          <button className="btn btn-primary btn-sm" onClick={onAddTrade}>+ Log Trade</button>
        </div>
      </div>
      {(filter === 'Win' || filter === 'Loss') && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 16px 6px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 2 }}>Show:</span>
          {['Open', 'Closed', 'All'].map(s => (
            <button key={s}
              onClick={() => setWinLossSub(s)}
              style={{
                fontSize: 11, padding: '2px 10px', borderRadius: 12, border: '1px solid',
                borderColor: winLossSub === s ? 'var(--blue)' : 'var(--border)',
                background: winLossSub === s ? 'var(--accent-light)' : 'var(--bg)',
                color: winLossSub === s ? 'var(--blue)' : 'var(--text-muted)',
                cursor: 'pointer', fontWeight: winLossSub === s ? 700 : 400,
              }}>
              {s}
            </button>
          ))}
          <span style={{ fontSize: 10, color: 'var(--text-muted)', fontStyle: 'italic', marginLeft: 4 }}>
            {winLossSub === 'Open' ? 'Based on current unrealised P&L' : winLossSub === 'Closed' ? 'Settled positions only' : 'Open + closed positions'}
          </span>
        </div>
      )}

      {/* ── Price status bar ── */}
      {/* Broker connected: show live status, no manual entry needed */}
      {/* No broker: show Yahoo/MarketData status + refresh button + manual entry hint */}
      {(() => {
        const isBrokerLive = liveStatus?.status === 'green';
        const isBrokerLoading = liveStatus?.status === 'blue';

        if (isBrokerLive || isBrokerLoading) {
          // Broker active — show live indicator, fields are auto-filled
          return (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '7px 14px', marginBottom: 8,
              background: 'var(--green-bg)', borderRadius: 6,
              border: '1px solid var(--green-border,#a8d5bc)', fontSize: 12,
            }}>
              <span style={{ color: 'var(--green)', flex: 1 }}>
                {isBrokerLoading
                  ? '⏳ Fetching live prices from broker…'
                  : `✓ Live prices from ${liveStatus.label} — Stock $, Opt $, IV and Theo P&L auto-calculated for all open positions.`}
              </span>
            </div>
          );
        }

        // No live broker — show Yahoo/MarketData fetch bar
        if (!onFetchYahoo) return null;
        const ys = yahooStatus || { status: 'idle' };
        const isLoading = ys.status === 'loading';
        const isFailed  = ys.status === 'failed';
        const isPartial = ys.status === 'partial';
        const isDone    = ys.status === 'done';
        const barColor  = isFailed ? 'var(--red-bg)' : isPartial ? 'var(--amber-bg)' : isDone ? 'var(--green-bg)' : 'var(--bg)';
        const txtColor  = isFailed ? 'var(--red)' : isPartial ? 'var(--amber)' : isDone ? 'var(--green)' : 'var(--text-secondary)';
        const updLabel  = pricesUpdatedAt
          ? ` · Updated ${pricesUpdatedAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
          : '';
        return (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 10,
            padding: '7px 14px', marginBottom: 8,
            background: barColor, borderRadius: 6,
            border: `1px solid ${isFailed ? 'var(--red-border)' : isPartial ? 'var(--amber-border)' : 'var(--border)'}`,
            fontSize: 12,
          }}>
            <span style={{ color: txtColor, flex: 1 }}>
              {isLoading && <span>⏳ {ys.message || 'Fetching prices…'}</span>}
              {!isLoading && ys.status === 'idle' && (
                <span style={{ color: 'var(--text-muted)' }}>
                  No broker connected — click <strong>⟳ Refresh Prices</strong> to fetch stock + option prices via Yahoo Finance.
                  Fields left blank after fetch can be entered manually — Theo P&L calculates as soon as Stock $, Opt $ and IV are filled.
                </span>
              )}
              {!isLoading && isDone && (
                <span>✓ {ys.message}{updLabel} — all fields auto-filled. Theo P&L calculated.</span>
              )}
              {!isLoading && isPartial && (
                <span>⚠ {ys.message}{updLabel} — fill in the blank Stock $, Opt $, IV fields to complete Theo P&L.</span>
              )}
              {!isLoading && isFailed && (
                <span>✗ {ys.message} — enter Stock $, Opt $ and IV manually for each open position to see Theo P&L.</span>
              )}
            </span>
            <button
              className="btn btn-outline btn-sm"
              onClick={onFetchYahoo}
              disabled={isLoading}
              style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
            >
              {isLoading ? '⏳ Fetching…' : '⟳ Refresh Prices'}
            </button>
          </div>
        );
      })()}

      {/* Theo P&L banner */}
      {openTrades.length > 0 && (() => {
        const isBrokerLive = liveStatus?.status === 'green';
        if (isBrokerLive) {
          return (
            <div className="pnl-banner" style={{ background: 'var(--bg-hover)', borderColor: 'var(--border)', opacity: 0.6 }}>
              <div style={{ fontSize: 20 }}>✓</div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--text-muted)', marginBottom: 2 }}>Theo P&L — Live Prices Active</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>Stock $, Opt $ and IV are auto-filled from {liveStatus.label}. Theo P&L calculates automatically for all open positions.</div>
              </div>
            </div>
          );
        }
        return (
          <div className="pnl-banner">
            <div style={{ fontSize: 20 }}>💡</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--blue)', marginBottom: 2 }}>Theoretical P&L Calculator</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>Click <strong>⟳ Refresh Prices</strong> above to auto-fill Stock $, Opt $ and IV via Yahoo Finance — or enter them manually. Theo P&L calculates as soon as all three are filled.</div>
            </div>
          </div>
        );
      })()}

      {/* Straddle / Strangle combined-leg hint — only shown when no broker (broker fetches combined price automatically) */}
      {!liveStatus || liveStatus.status !== 'green' ? (
        openTrades.some(t => MULTI_LEG_STRATEGIES.includes(t.strategy)) && (
          <div className="pnl-banner" style={{ background: 'var(--amber-bg)', borderColor: 'var(--amber-border)' }}>
            <div style={{ fontSize: 20 }}>⚡</div>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: 'var(--amber)', marginBottom: 2 }}>Straddle / Strangle — Combined Leg Price</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-secondary)' }}>You have an open Straddle or Strangle. In the <strong>Option Px</strong> column, enter the <em>combined current value of both legs</em> (call + put together) to calculate theoretical P&L correctly.</div>
            </div>
          </div>
        )
      ) : null}

      {/* Table */}
      {/* IC / IB Chain Groups — collapsible, shown above the main table */}
      {Object.keys(chainGroups).length > 0 && (() => {
        const _hasIC = Object.values(chainGroups).some(ct => ct[0]?.strategy === 'Iron Condor');
        const _hasIB = Object.values(chainGroups).some(ct => ct[0]?.strategy === 'Iron Butterfly');
        const _chainLabel = _hasIC && _hasIB ? 'IC / IB Chains' : _hasIB ? 'Iron Butterfly Chains' : 'Iron Condor Chains';
        return (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
            {_chainLabel} ({Object.entries(chainGroups).filter(([, ct]) => {
              const closed = ct.every(t => t.status === 'closed');
              if (filter === 'Open')   return !closed;
              if (filter === 'Closed') return closed;
              if (filter === 'Win')    return ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0),0) > 0;
              if (filter === 'Loss')   return ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0),0) < 0;
              return true;
            }).length})
          </div>
          {Object.entries(chainGroups).map(([chainId, chainTrades]) => {
            const { realisedPnL, unrealisedPnL, totalPnL, chainClosed, hasPrices, isBsEst } = computeChainPnL(chainTrades, currentPrices);
            // Respect filter — skip chains that don't match
            if (filter === 'Open'   && chainClosed)  return null;
            if (filter === 'Closed' && !chainClosed) return null;
            if (filter === 'Win'    && totalPnL <= 0) return null;
            if (filter === 'Loss'   && totalPnL >= 0) return null;
            // Respect filterTickers and search — hide chains that don't match
            const anchor0 = chainTrades[0];
            if (filterTickers && anchor0 && !filterTickers.has(anchor0.ticker)) return null;
            if (search) {
              const q = search.toLowerCase();
              const matchesTicker   = anchor0?.ticker?.toLowerCase().includes(q);
              const matchesStrategy = chainTrades.some(t => t.strategy?.toLowerCase().includes(q));
              const matchesNotes    = chainTrades.some(t => (t.notes || '').toLowerCase().includes(q));
              if (!matchesTicker && !matchesStrategy && !matchesNotes) return null;
            }
            const isExpanded = expandedChains[chainId];
            const anchor = chainTrades.find(t => t.condor_seq === 0) || chainTrades[0];
            const status  = chainClosed ? 'closed' : chainTrades.some(t => t.contracts_closed > 0) ? 'partial' : 'open';

            return (
              <div key={chainId} className="card" style={{ padding: 0, marginBottom: 8, border: '1px solid var(--blue-border)', overflow: 'hidden' }}>
                {/* Chain header */}
                <div
                  style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', cursor: 'pointer', background: 'var(--blue-bg)', borderBottom: isExpanded ? '1px solid var(--blue-border)' : 'none' }}
                  onClick={() => setExpandedChains(e => ({ ...e, [chainId]: !e[chainId] }))}
                >
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>{anchor.ticker}</span>
                  <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--blue)' }}>{anchor.strategy === 'Iron Butterfly' ? 'IB' : 'IC'} Chain #{Math.abs(chainId)}</span>
                  {/* Status badge */}
                  {status === 'closed'  && <span className="badge badge-green" style={{ fontSize: 10 }}>Fully Closed</span>}
                  {status === 'partial' && <span className="badge" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', fontSize: 10 }}>Partial</span>}
                  {status === 'open'    && <span className="badge" style={{ background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 10 }}>Open</span>}
                  {(() => { const ctr = anchor?.contracts_original || anchor?.contracts || 1; return <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:500 }}>{ctr} contract{ctr !== 1 ? 's' : ''}</span>; })()}
                  {/* Open leg badges removed — ▸/▾ arrow is the details toggle */}
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                    <div style={{ textAlign: 'right', minWidth: 80 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Realised</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: realisedPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {realisedPnL >= 0 ? '+' : ''}{fmt(realisedPnL)}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 80 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Unrealised</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 13, fontWeight: 700, color: unrealisedPnL >= 0 ? 'var(--green)' : 'var(--red)', opacity: hasPrices ? 1 : 0.4 }}>
                        {hasPrices ? (unrealisedPnL >= 0 ? '+' : '')+fmt(unrealisedPnL) : '—'}
                      </div>
                      {hasPrices && isBsEst && <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, marginTop: 1 }} title="Black-Scholes estimate — no live option price available">est.</div>}
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 80 }}>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Total P&L</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 800, color: totalPnL >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {hasPrices ? (totalPnL >= 0 ? '+' : '')+fmt(totalPnL) : (realisedPnL >= 0 ? '+' : '')+fmt(realisedPnL)}
                      </div>
                      {hasPrices && isBsEst && <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, marginTop: 1 }} title="Black-Scholes estimate">est.</div>}
                    </div>
                    {/* 📈 P&L Curve — chain-level, uses current open legs */}
                    {!chainClosed && (
                      <button
                        className="btn btn-xs"
                        style={{ fontSize: 9, padding: '1px 6px', background: 'var(--blue-bg)', color: 'var(--blue)', border: '1px solid var(--blue-border)', marginRight: 4 }}
                        title="P&L payoff chart for this condor position"
                        onClick={async e => {
                          e.stopPropagation();
                          const sp = parseFloat(currentPrices?.[anchor.id]?.stock || currentPrices?.[anchor.ticker?.toUpperCase()]?.stock) || 0;
                          if (!sp) return;
                          const curPutLeg  = chainTrades.filter(t => t.condor_leg==='put'  && (t.contracts_open??t.contracts??1)>0).sort((a,b)=>(b.condor_seq||0)-(a.condor_seq||0))[0];
                          if (!curPutLeg) return;
                          const data = getPnlCurveData(curPutLeg, sp, null, curPutLeg.contracts, null, null, chainTrades, currentPrices);
                          if (data) { setCurvePos(null); setPnlCurvePopup({ trade: curPutLeg, data, iv: data.iv, ivLabel: 'IC chain (live legs)', stockPrice: sp }); }
                        }}
                      >
                        📈 Chart
                      </button>
                    )}
                    {/* Adj IC / Adj IB — always visible on header, no expand needed */}
                    {!chainClosed && (
                      <button
                        className="btn btn-xs btn-primary"
                        style={{ fontSize: 10, padding: '3px 9px', fontWeight: 700 }}
                        title={`Open ${anchor.strategy === 'Iron Butterfly' ? 'Iron Butterfly' : 'Iron Condor'} adjustment wizard`}
                        onClick={e => { e.stopPropagation(); setAdjustingIC({ trade: anchor, chainTrades }); }}
                      >
                        {anchor.strategy === 'Iron Butterfly' ? 'Adj IB' : 'Adj IC'}
                      </button>
                    )}
                    <button
                        className="btn btn-xs"
                        style={{ fontSize: 9, padding: '1px 6px', background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red-border)', marginRight: 4 }}
                        title="Delete all legs of this chain"
                        onClick={e => { e.stopPropagation(); onDeleteChain({ chainIds: chainTrades.map(t => t.id), ticker: anchor?.ticker, type: 'ic' }); }}
                      >
                        ✕ Delete
                      </button>
                    {isMock && (
                      <button
                        className="btn btn-xs"
                        style={{ fontSize: 9, padding: '1px 6px', background: '#fff8e6', color: '#92600a', border: '1px solid #f0d898', marginRight: 4 }}
                        title="Explain this Iron Condor chain in plain English"
                        onClick={e => { e.stopPropagation(); setExplainId(anchor?.id); }}
                      >
                        💡 Explain
                      </button>
                    )}
                    <span style={{ color: 'var(--text-muted)', fontSize: 14 }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded leg rows */}
                {isExpanded && (
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%' }}>
                      <thead>
                        <tr>
                          <th style={{ fontSize: 10 }}>Seq</th>
                          <th style={{ fontSize: 10 }}>Leg</th>
                          <th style={{ fontSize: 10 }}>Entry</th>
                          <th style={{ fontSize: 10 }}>Expiry</th>
                          <th style={{ fontSize: 10 }}>Strikes</th>
                          <th style={{ fontSize: 10 }}>Premium</th>
                          <th style={{ fontSize: 10 }}>Open / Closed</th>
                          <th style={{ fontSize: 10 }}>Leg P&L</th>
                          <th style={{ fontSize: 10 }}>Opt $</th>
                        </tr>
                      </thead>
                      <tbody>
                        {chainTrades.sort((a,b) => (a.condor_seq||0) - (b.condor_seq||0) || a.id - b.id).map(ct => {
                          const legPnl = ct.pnl != null ? ct.pnl : (ct.partial_close_pnl || 0);
                          const isOpen = (ct.contracts_open || 0) > 0;
                          return (
                            <tr key={ct.id} style={{ opacity: isOpen ? 1 : 0.65 }}>
                              <td><span className="badge" style={{ background: 'var(--blue-bg)', color: 'var(--blue)', fontSize: 10 }}>IC·A{ct.condor_seq || 0}</span></td>
                              <td style={{ textTransform: 'capitalize', fontSize: 12 }}>{ct.condor_leg || 'full'}</td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{ct.entry_date || '—'}</td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{ct.expiration || '—'}</td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                {ct.strike_sell && ct.strike_buy ? `${ct.strike_sell}/${ct.strike_buy}` : ct.strike_sell ? `$${ct.strike_sell}` : ct.strike_buy ? `$${ct.strike_buy}` : '—'}
                              </td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{ct.entry_price != null ? `$${ct.entry_price.toFixed(2)}` : '—'}</td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                                <span style={{ color: isOpen ? 'var(--blue)' : 'var(--text-muted)' }}>
                                  {ct.contracts_open ?? ct.contracts} / {ct.contracts_closed ?? 0}
                                </span>
                              </td>
                              <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 600 }}>
                                {legPnl !== 0 ? <span className={legPnl >= 0 ? 'profit' : 'loss'}>{legPnl >= 0 ? '+' : ''}{fmt(legPnl)}</span> : '—'}
                              </td>
                              <td style={{ padding: '2px 4px' }}>
                                {isOpen && onPriceUpdate && (() => {
                                  const manualSet = optPrices[ct.id] !== undefined;
                                  const autoVal   = currentPrices[ct.id]?.option;
                                  const hasAuto   = autoVal != null;
                                  return (
                                    <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
                                      <input className="price-input" type="number" step="0.01"
                                        value={optPrices[ct.id] ?? (hasAuto ? autoVal : '')}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setOptPrices(p => ({ ...p, [ct.id]: val }));
                                          if (onPriceUpdate) onPriceUpdate(ct.id, ct.ticker, { option: val ? parseFloat(val) : null });
                                        }}
                                        placeholder="—"
                                        disabled={hasAuto && !manualSet}
                                        style={{ width:64, fontSize:10, fontFamily:'var(--font-mono)',
                                          background: hasAuto && !manualSet ? 'var(--bg-hover)' : '',
                                          color: hasAuto && !manualSet ? 'var(--text-muted)' : 'var(--text-primary)',
                                          cursor: hasAuto && !manualSet ? 'default' : 'text' }}
                                      />
                                      {(hasAuto || manualSet) && <span style={{ fontSize:7, color:'var(--text-muted)' }}>
                                        {manualSet ? 'manual' : 'auto'}
                                      </span>}
                                    </div>
                                  );
                                })()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        );
      })()}

      {/* ── Calendar Spread Chain Groups ─────────────────────────────────── */}
      {Object.keys(calChainGroups).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>
            Calendar Spread Chains ({Object.entries(calChainGroups).filter(([, ct]) => {
              const closed = ct.every(t => t.status === 'closed');
              if (filter === 'Open')   return !closed;
              if (filter === 'Closed') return closed;
              if (filter === 'Win')    return ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0),0) > 0;
              if (filter === 'Loss')   return ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0),0) < 0;
              return true;
            }).length})
          </div>
          {Object.entries(calChainGroups).map(([chainId, chainTrades]) => {
            const { realisedPnL, unrealisedPnL, totalPnL, chainClosed, openLegs, hasPrices, isBsEst } = computeCalChainPnL(chainTrades, currentPrices);
            // Respect filter
            if (filter === 'Open'   && chainClosed)  return null;
            if (filter === 'Closed' && !chainClosed) return null;
            if (filter === 'Win'    && totalPnL <= 0) return null;
            if (filter === 'Loss'   && totalPnL >= 0) return null;
            // Respect filterTickers and search — hide chains that don't match
            const anchor0 = chainTrades[0];
            if (filterTickers && anchor0 && !filterTickers.has(anchor0.ticker)) return null;
            if (search) {
              const q = search.toLowerCase();
              const matchesTicker   = anchor0?.ticker?.toLowerCase().includes(q);
              const matchesStrategy = chainTrades.some(t => t.strategy?.toLowerCase().includes(q));
              const matchesNotes    = chainTrades.some(t => (t.notes || '').toLowerCase().includes(q));
              if (!matchesTicker && !matchesStrategy && !matchesNotes) return null;
            }
            const isExpanded = expandedChains['cal_' + chainId];
            const anchor  = [...chainTrades].sort((a,b) => (a.cal_seq||0)-(b.cal_seq||0))[0];
            const hasOpen = openLegs.length > 0;
            const status  = chainClosed ? 'closed' : 'open';

            return (
              <div key={chainId} className="card" style={{ padding: 0, marginBottom: 8, border: '1px solid #b7e3c0', overflow: 'hidden' }}>
                {/* Chain header */}
                <div
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', cursor:'pointer', background:'#edf7f0', borderBottom: isExpanded ? '1px solid #b7e3c0' : 'none' }}
                  onClick={() => setExpandedChains(e => ({ ...e, ['cal_' + chainId]: !e['cal_' + chainId] }))}
                >
                  <span style={{ fontFamily:'var(--font-mono)', fontWeight:700 }}>{anchor?.ticker}</span>
                  <span style={{ fontSize:11, fontWeight:600, color:'var(--green,#375623)' }}>{anchor?.strategy === 'Diagonal Spread' ? 'Diag' : 'Cal'} Chain #{Math.abs(chainId)}</span>
                  {(() => {
                    // R: show strike + option type in header e.g. '$95C' or '$95P'
                    const anchorStrike = anchor?.strike_sell || anchor?.strike_buy;
                    const anchorOt = anchor?.option_type;
                    if (!anchorStrike) return null;
                    const sfx = anchorOt === 'put' ? 'P' : anchorOt === 'call' ? 'C' : '';
                    return <span style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)', fontWeight:600 }}>${anchorStrike}{sfx}</span>;
                  })()}
                  {status === 'closed' && <span className="badge badge-green" style={{ fontSize:10 }}>Fully Closed</span>}
                  {status === 'open'   && <span className="badge" style={{ background:'#edf7f0', color:'var(--green,#375623)', fontSize:10 }}>Open</span>}
                  {(() => { const ctr = anchor?.contracts_original || anchor?.contracts || 1; return <span style={{ fontSize:11, color:'var(--text-muted)', fontWeight:500 }}>{ctr} contract{ctr !== 1 ? 's' : ''}</span>; })()}
                  {/* Open leg badges removed — ▸/▾ arrow is the details toggle */}
                  <div style={{ marginLeft:'auto', display:'flex', gap:16, alignItems:'flex-start' }}>
                    <div style={{ textAlign:'right', minWidth:80 }}>
                      <div style={{ fontSize:10, color:'var(--text-muted)' }}>Realised</div>
                      <div style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:13, color: realisedPnL>=0 ? 'var(--green)' : 'var(--red)' }}>
                        {realisedPnL>=0?'+':''}{fmt(realisedPnL)}
                      </div>
                    </div>
                    <div style={{ textAlign:'right', minWidth:80 }}>
                      <div style={{ fontSize:10, color:'var(--text-muted)' }}>Unrealised</div>
                      <div style={{ fontFamily:'var(--font-mono)', fontWeight:700, fontSize:13, color: unrealisedPnL>=0 ? 'var(--green)' : 'var(--red)', opacity: hasPrices ? 1 : 0.4 }}>
                        {hasPrices ? (unrealisedPnL>=0?'+':'')+fmt(unrealisedPnL) : '—'}
                      </div>
                      {hasPrices && isBsEst && <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, marginTop: 1 }} title="Black-Scholes estimate — no live option price available">est.</div>}
                    </div>
                    <div style={{ textAlign:'right', minWidth:80 }}>
                      <div style={{ fontSize:10, color:'var(--text-muted)' }}>Total P&L</div>
                      <div style={{ fontFamily:'var(--font-mono)', fontWeight:800, fontSize:14, color: totalPnL>=0 ? 'var(--green)' : 'var(--red)' }}>
                        {hasPrices ? (totalPnL>=0?'+':'')+fmt(totalPnL) : (realisedPnL>=0?'+':'')+fmt(realisedPnL)}
                      </div>
                      {hasPrices && isBsEst && <div style={{ fontSize: 9, color: '#f59e0b', fontWeight: 600, marginTop: 1 }} title="Black-Scholes estimate">est.</div>}
                    </div>
                    {/* 📈 P&L Curve — chain-level, uses current open short + long */}
                    {hasOpen && (() => {
                      const shortLeg = chainTrades.filter(t => t.cal_leg==='short' && t.status==='open').sort((a,b)=>(b.cal_seq||0)-(a.cal_seq||0))[0];
                      const longLeg  = chainTrades.filter(t => t.cal_leg==='long'  && t.status==='open').sort((a,b)=>(b.cal_seq||0)-(a.cal_seq||0))[0];
                      const sp = parseFloat(currentPrices?.[anchor.id]?.stock || currentPrices?.[anchor.ticker?.toUpperCase()]?.stock) || 0;
                      if (!shortLeg || !longLeg || !sp) return null;
                      return (
                        <button
                          className="btn btn-xs"
                          style={{ fontSize: 9, padding: '1px 6px', background: 'var(--blue-bg)', color: 'var(--blue)', border: '1px solid var(--blue-border)', marginRight: 4 }}
                          title="P&L payoff chart — approximate, assumes constant IV across expirations"
                          onClick={e => {
                            e.stopPropagation();
                            const data = getPnlCurveDataCalChain(shortLeg, longLeg, sp, currentPrices, DEFAULT_RISK_FREE_RATE);
                            if (data) {
                              const ivLabel = data.usedLive ? 'Cal chain (live prices)' : 'Cal chain (est. IV · load prices for live curve)';
                              setCurvePos(null);
                              setPnlCurvePopup({ trade: shortLeg, data, iv: data.iv, ivLabel, stockPrice: sp, shortLeg, longLeg, isCalChain: true });
                            }
                          }}
                        >
                          📈 Chart
                        </button>
                      );
                    })()}
                    {hasOpen && onOpenCalAdjust && (
                      <button
                        className="btn btn-xs btn-primary"
                        style={{ fontSize: 10, padding: '3px 9px', fontWeight: 700 }}
                        title={`Open ${anchor?.strategy === 'Diagonal Spread' ? 'Diagonal' : 'Calendar'} spread adjustment wizard`}
                        onClick={e => { e.stopPropagation(); onOpenCalAdjust(anchor, chainTrades); }}
                      >
                        {anchor?.strategy === 'Diagonal Spread' ? 'Adj Diag' : 'Adj Cal'}
                      </button>
                    )}
                    <button
                        className="btn btn-xs"
                        style={{ fontSize: 9, padding: '1px 6px', background: 'var(--red-bg)', color: 'var(--red)', border: '1px solid var(--red-border)', marginRight: 4 }}
                        title="Delete all legs of this calendar chain"
                        onClick={e => { e.stopPropagation(); onDeleteChain({ chainIds: chainTrades.map(t => t.id), ticker: anchor?.ticker, type: 'cal' }); }}
                      >
                        ✕ Delete
                      </button>
                    {isMock && (
                      <button
                        className="btn btn-xs"
                        style={{ fontSize: 9, padding: '1px 6px', background: '#fff8e6', color: '#92600a', border: '1px solid #f0d898' }}
                        title="Explain this Calendar Spread campaign in plain English"
                        onClick={e => { e.stopPropagation(); setExplainId(anchor?.id); }}
                      >
                        💡 Explain
                      </button>
                    )}
                    <span style={{ fontSize:14, color:'var(--text-muted)' }}>{isExpanded ? '▲' : '▼'}</span>
                  </div>
                </div>

                {/* Expanded detail table */}
                {isExpanded && (
                  <div style={{ padding:'10px 14px', background:'var(--bg-card)' }}>
                    <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                      <thead>
                        <tr style={{ borderBottom:'1px solid var(--border)' }}>
                          {['Seq','Leg','Strike','Front Expiry','Back Expiry','Entry $','Exit $','Leg P&L','Status','Contracts','Opt $'].map(h => (
                            <th key={h} style={{ textAlign: h==='Entry $'||h==='Exit $'||h==='Leg P&L' ? 'right' : 'left', padding:'4px 8px', fontWeight:600, fontSize:11, color:'var(--text-muted)' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {[...chainTrades].sort((a,b) => (a.cal_seq||0)-(b.cal_seq||0) || (a.cal_leg||'').localeCompare(b.cal_leg||'')).map(ct => {
                          const strike = ct.cal_leg === 'short' ? ct.strike_sell : ct.strike_buy;
                          const optSuffix = ct.option_type === 'put' ? 'P' : ct.option_type === 'call' ? 'C' : '';
                          const isOpenLeg = ct.status === 'open';
                          const isPartial = isOpenLeg && (ct.contracts_closed||0) > 0;
                          const contractsOpen = ct.contracts_open ?? ct.contracts ?? 1;
                          const contractsOrig = ct.contracts_original ?? ct.contracts ?? 1;
                          return (
                            <tr key={ct.id} style={{ borderBottom:'1px solid #f0f0f0', background: isPartial ? '#fffbeb' : isOpenLeg ? '#edf7f0' : 'transparent' }}>
                              <td style={{ padding:'5px 8px', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>
                                {ct.cal_seq === 0 ? 'Entry' : `Adj ${ct.cal_seq}`}
                              </td>
                              <td style={{ padding:'5px 8px', fontWeight:700, fontSize:11, color: ct.cal_leg==='short' ? 'var(--red)' : 'var(--green,#375623)' }}>
                                {ct.cal_leg === 'short' ? '📉 Short' : '📈 Long'}
                              </td>
                              <td style={{ padding:'5px 8px', fontFamily:'var(--font-mono)', fontWeight:700 }}>{strike != null ? `$${strike}${optSuffix}` : '—'}</td>
                              <td style={{ padding:'5px 8px', fontSize:11 }}>{ct.cal_leg === 'short' ? (ct.expiration ?? '—') : '—'}</td>
                              <td style={{ padding:'5px 8px', fontSize:11, color:'var(--text-primary)' }}>
                                {ct.cal_leg === 'long' ? ct.expiration : '—'}
                              </td>
                              <td style={{ padding:'5px 8px', textAlign:'right', fontFamily:'var(--font-mono)' }}>${ct.entry_price?.toFixed(2)}</td>
                              <td style={{ padding:'5px 8px', textAlign:'right', fontFamily:'var(--font-mono)', color:'var(--text-muted)' }}>
                                {ct.exit_price != null ? `$${ct.exit_price.toFixed(2)}` : '—'}
                              </td>
                              <td style={{ padding:'5px 8px', textAlign:'right', fontFamily:'var(--font-mono)', fontWeight:700 }}>
                                {ct.pnl != null
                                  ? <span style={{ color: ct.pnl>=0 ? 'var(--green)' : 'var(--red)' }}>{ct.pnl>=0?'+':''}{fmt(ct.pnl)}</span>
                                  : isPartial && (ct.partial_close_pnl||0) !== 0
                                    ? <span style={{ color: ct.partial_close_pnl>=0 ? 'var(--green)' : 'var(--red)', fontSize:10 }}>{ct.partial_close_pnl>=0?'+':''}{fmt(ct.partial_close_pnl)}</span>
                                    : <span style={{ color:'var(--text-muted)', fontStyle:'italic' }}>open</span>}
                              </td>
                              <td style={{ padding:'5px 8px' }}>
                                <span className={isPartial ? 'badge' : isOpenLeg ? 'badge badge-green' : 'badge badge-gray'}
                                  style={{ fontSize:9, ...(isPartial ? {background:'var(--amber-bg)',color:'var(--amber)'} : {}) }}>
                                  {isPartial ? 'Partial' : isOpenLeg ? 'Open' : 'Closed'}
                                </span>
                              </td>
                              <td style={{ padding:'5px 8px', fontSize:10, color:'var(--text-muted)', fontFamily:'var(--font-mono)' }}>
                                {contractsOpen}/{contractsOrig}
                              </td>
                              <td style={{ padding:'2px 4px' }}>
                                {isOpenLeg && onPriceUpdate && (() => {
                                  const manualSet = optPrices[ct.id] !== undefined;
                                  const autoVal   = currentPrices[ct.id]?.option;
                                  const hasAuto   = autoVal != null;
                                  return (
                                    <div style={{ display:'flex', flexDirection:'column', gap:1 }}>
                                      <input className="price-input" type="number" step="0.01"
                                        value={optPrices[ct.id] ?? (hasAuto ? autoVal : '')}
                                        onChange={e => {
                                          const val = e.target.value;
                                          setOptPrices(p => ({ ...p, [ct.id]: val }));
                                          if (onPriceUpdate) onPriceUpdate(ct.id, ct.ticker, { option: val ? parseFloat(val) : null });
                                        }}
                                        placeholder="—"
                                        disabled={hasAuto && !manualSet}
                                        style={{ width:64, fontSize:10, fontFamily:'var(--font-mono)',
                                          background: hasAuto && !manualSet ? 'var(--bg-hover)' : '',
                                          color: hasAuto && !manualSet ? 'var(--text-muted)' : 'var(--text-primary)',
                                          cursor: hasAuto && !manualSet ? 'default' : 'text' }}
                                      />
                                      {(hasAuto || manualSet) && <span style={{ fontSize:7, color:'var(--text-muted)' }}>
                                        {manualSet ? 'manual' : 'auto'}
                                      </span>}
                                    </div>
                                  );
                                })()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ borderTop:'2px solid var(--border)', fontWeight:700 }}>
                          <td colSpan={8} style={{ padding:'6px 8px', fontSize:12, color:'var(--text-secondary)' }}>Campaign Total</td>
                          <td style={{ padding:'6px 8px', textAlign:'right', fontFamily:'var(--font-mono)', fontWeight:800, fontSize:13, color: totalPnL>=0 ? 'var(--green)' : 'var(--red)' }}>
                            {totalPnL>=0?'+':''}{fmt(totalPnL)}
                          </td>
                          <td />
                        </tr>
                      </tfoot>
                    </table>
                    {anchor?.notes && (
                      <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:8, fontStyle:'italic' }}>{anchor.notes}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">🔍</div>
          <h3>No trades match</h3>
          <p>Try adjusting your search or filters.</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <DualScrollTable>
            <table>
              <thead>
                <tr>
                  <th style={{ minWidth: 120 }} title={COLUMN_TIPS['Position']} className="sortable" onClick={() => sort('ticker')}>Position ⓘ{sortIcon('ticker')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['DTE']} className="sortable" onClick={() => sort('expiration')}>DTE ⓘ{sortIcon('expiration')}</th>
                  <th style={{ minWidth: 60 }} title={COLUMN_TIPS['Strike']} className="sortable" onClick={() => sort('strike_sell')}>Strike ⓘ{sortIcon('strike_sell')}</th>
                  <th style={{ minWidth: 32, textAlign: 'center' }} title={COLUMN_TIPS['Contracts']} className="sortable" onClick={() => sort('contracts')}>Qty ⓘ{sortIcon('contracts')}</th>
                  <th style={{ minWidth: 64 }} title={COLUMN_TIPS['Stock $']}>Stock $ ⓘ</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['Entry $']} className="sortable" onClick={() => sort('entry_price')}>Entry $ ⓘ{sortIcon('entry_price')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['IV']}>IV % ⓘ</th>
                  <th style={{ minWidth: 64 }} title={COLUMN_TIPS['Opt $']}>Opt $ ⓘ</th>
                  <th style={{ minWidth: 44, textAlign: 'center' }} title={COLUMN_TIPS['% Max']}>% Max ⓘ</th>
                  <th style={{ minWidth: 68 }} title={COLUMN_TIPS['Theo P&L']}>Theo P&L ⓘ</th>
                  <th style={{ minWidth: 60, textAlign: 'center' }} title={COLUMN_TIPS['P&L Curve']}>P&L Curve ⓘ</th>
                  <th style={{ minWidth: 60 }} title={COLUMN_TIPS['P&L']} className="sortable" onClick={() => sort('pnl')}>P&L ⓘ{sortIcon('pnl')}</th>
                  <th style={{ minWidth: 36, textAlign: 'center' }} title={COLUMN_TIPS['Greeks']} className="sortable" onClick={() => sort('delta')}>Greeks ⓘ{sortIcon('delta')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['Entry']} className="sortable" onClick={() => sort('entry_date')}>Entry ⓘ{sortIcon('entry_date')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['Expiry']} className="sortable" onClick={() => sort('expiration')}>Expiry ⓘ{sortIcon('expiration')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['Closed']} className="sortable" onClick={() => sort('exit_date')}>Closed ⓘ{sortIcon('exit_date')}</th>
                  <th style={{ minWidth: 52 }} title={COLUMN_TIPS['Buy Back']} className="sortable" onClick={() => sort('exit_price')}>Buy Back ⓘ{sortIcon('exit_price')}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(trade => {
                  const sc       = STRATEGY_COLORS[trade.strategy] || { bg: '#f0f0f0', color: '#555' };
                  const isOpen   = trade.status === 'open';
                  const curOpt   = getOptPrice(trade.id);
                  const curStk   = getStkPrice(trade.id, trade.ticker);
                  const curIv    = getIvPrice(trade.id, trade);
                  // Only calculate Theo P&L for open trades — closed trades have settled P&L
                  const theoPnlResult = isOpen ? calcTheoPnl(trade, curOpt, curStk, curIv) : null;
                  const theoPnl      = theoPnlResult?.pnl ?? theoPnlResult;
                  const theoIsEst    = theoPnlResult?.isEstimate ?? false;
                  const theoUsedCurrentIv = theoPnlResult?.usedCurrentIv ?? false;

                  // DTE calculation
                  const dte = (() => {
                    if (!trade.expiration) return null;
                    // Closed trades: don't show DTE (past expiry is meaningless noise)
                    if (!isOpen) return null;
                    const diff = Math.ceil((new Date(trade.expiration) - new Date()) / 86400000);
                    return Math.max(0, diff);
                  })();
                  const dteColor = dte == null ? 'var(--text-muted)'
                    : dte <= 7  ? 'var(--red)'
                    : dte <= 21 ? 'var(--amber)'
                    : 'var(--blue)';
                  const dtePct = dte == null ? 0 : Math.min(100, Math.max(0, (1 - dte/45)*100));

                  // Alert bell
                  const alertSev = (() => {
                    if (!isOpen) return null;
                    if (dte != null && dte <= 7)  return 'red';
                    const delta = Math.abs(trade.delta || 0);
                    if (dte != null && dte <= 21) return 'amber';
                    if (delta > 0.50)             return 'red';
                    if (delta > 0.35)             return 'amber';
                    const pct = calcPctMaxProfit(trade, curOpt);
                    if (pct != null && pct >= 50) return 'blue';
                    return null;
                  })();

                  // Stock price ITM indicator
                  const stkNum  = parseFloat(curStk);
                  const kSell   = parseFloat(trade.strike_sell);
                  const kBuy    = parseFloat(trade.strike_buy);
                  const isItm   = (() => {
                    if (!stkNum) return false;
                    if (trade.strategy === 'Covered Call'    && kSell && stkNum >= kSell) return true;
                    if (trade.strategy === 'Cash-Secured Put' && kBuy  && stkNum <= kBuy)  return true;
                    return false;
                  })();

                  const tdS = { padding: '7px 6px', verticalAlign: 'middle' };
                  const monoS = { fontFamily: 'var(--font-mono)', fontSize: 12 };

                  return (
                    <tr key={trade.id} style={{ borderBottom: '1px solid var(--border)' }}>

                      {/* 1. POSITION — ticker + strategy badge inline, buttons in one horizontal row below */}
                      <td style={{ ...tdS, verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                        {/* Row 1: ticker + status badge + roll badge + alert bell + strategy badge */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 800, fontSize: 13, color: 'var(--text-primary)' }}>{trade.ticker}</span>
                          {/* Open/Closed status — immediately visible on every row */}
                          {trade.status === 'open'
                            ? <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--blue-bg)', color: 'var(--blue)', border: '1px solid var(--blue-border)' }}>OPEN</span>
                            : <span style={{ fontSize: 9, fontWeight: 700, padding: '1px 5px', borderRadius: 4, background: 'var(--green-bg)', color: 'var(--green)', border: '1px solid var(--green-border)' }}>CLOSED</span>
                          }
                          {trade.roll_count > 0 && <span className="badge badge-purple" style={{ fontSize: 9, padding: '1px 4px' }}>R{trade.roll_count}</span>}
                          {trade.condor_chain_id && trade.condor_seq > 0 && <span className="badge badge-blue" style={{ fontSize: 9, padding: '1px 4px' }}>IC·A{trade.condor_seq}</span>}
                          {alertSev && (
                            <span
                              title={alertSev === 'red' ? 'Urgent — act now' : alertSev === 'amber' ? 'Warning — review position' : 'Take profit opportunity'}
                              style={{ fontSize: 12, cursor: 'pointer', color: alertSev === 'red' ? 'var(--red)' : alertSev === 'amber' ? 'var(--amber)' : 'var(--blue)' }}
                              onClick={() => { const el = document.getElementById('alerts-insights-monitor'); if (el) el.scrollIntoView({ behavior: 'smooth' }); }}
                            >🔔</span>
                          )}
                          <span className="badge" style={{ background: sc.bg, color: sc.color, fontSize: 9, padding: '1px 5px' }}>{trade.strategy}</span>
                        </div>

                        {/* Row 1b: ACB link line — CC shows ACB, closed CSP shows Assigned */}
                        {trade.lot_id && (() => {
                          const linkedLot = lots.find(l => l.id === trade.lot_id);
                          if (!linkedLot) return null;
                          const isCC  = trade.strategy === 'Covered Call';
                          const isCSP = trade.strategy === 'Cash-Secured Put';
                          if (!isCC && !isCSP) return null;

                          // ACB = avg_cost − (all premiums collected on this lot ÷ shares)
                          // Includes: (a) CC premiums earned = (entry-exit)×contracts×100
                          //           (b) initial CSP premium collected before assignment
                          //               (assigned CSP has exit_price=entry_price so ep-xp=0,
                          //                but the full entry_price IS the premium collected)
                          const lotClosedTrades = trades.filter(t => t.lot_id === linkedLot.id && t.status === 'closed');
                          const closedPrem = lotClosedTrades.reduce((sum, t) => {
                            const ep = parseFloat(t.entry_price) || 0;
                            const xp = parseFloat(t.exit_price)  || 0;
                            if (t.strategy === 'Cash-Secured Put') {
                              // Assigned CSP: exit_price = entry_price, so ep-xp=0 — use ep directly
                              return sum + ep * (t.contracts || 1) * 100;
                            }
                            if (t.strategy === 'Covered Call') {
                              // Called-away CC: exit_price = strike_sell (share sale price, not buyback)
                              // Must use full entry premium, not (ep - xp) which would be hugely negative
                              const isCalledAway = t.strike_sell != null && Math.abs(xp - parseFloat(t.strike_sell)) < 0.01;
                              if (isCalledAway) return sum + ep * (t.contracts || 1) * 100;
                              // Normal CC close: (entry - buyback) × contracts × 100
                              return sum + (ep - xp) * (t.contracts || 1) * 100;
                            }
                            if (CREDIT_STRATEGIES.includes(t.strategy)) return sum + (ep - xp) * (t.contracts || 1) * 100;
                            return sum;
                          }, 0);
                          const sh     = parseFloat(linkedLot.shares)   || 0;
                          const basis  = parseFloat(linkedLot.avg_cost) || 0;
                          const acb    = sh > 0 ? basis - (closedPrem / sh) : basis;
                          const redPct = basis > 0 ? (basis - acb) / basis * 100 : 0;

                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 2 }}>
                              <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>🔗</span>
                              {isCC && (
                                <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                  <span style={{ color: 'var(--green)', fontWeight: 700 }}>ACB ${acb.toFixed(2)}</span>
                                  <span style={{ color: 'var(--text-muted)' }}> · {sh}sh</span>
                                  {redPct > 0.01 && (
                                    <span style={{ color: 'var(--green)', marginLeft: 4 }} title="Cost basis reduction from premiums collected">↓{redPct.toFixed(1)}%</span>
                                  )}
                                </span>
                              )}
                              {isCSP && trade.status === 'closed' && (
                                <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                  Assigned · {sh}sh @ ${basis.toFixed(2)}
                                </span>
                              )}
                            </div>
                          );
                        })()}

                        {/* Row 2: all action buttons in a single horizontal line */}
                        <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                          {isOpen && trade.strategy === 'Cash-Secured Put' && (
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-border)' }} onClick={() => onAssignment(trade)}>Assigned</button>
                          )}
                          {isOpen && trade.strategy === 'Covered Call' && (
                            trade.lot_id
                              ? <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--green-bg)', color: 'var(--green)', border: '1px solid var(--green-border)' }} onClick={() => onCalledAway(trade)}>Called Away</button>
                              : <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--bg)', color: 'var(--red,#c0392b)', border: '1px solid var(--red,#c0392b)', cursor: 'not-allowed', opacity: 0.7 }}
                                  title="No stock lot linked to this CC. Edit the trade to link it to the correct lot before recording Called Away."
                                  onClick={e => e.preventDefault()}>
                                  ⚠ Link lot first
                                </button>
                          )}
                          {isOpen && ROLL_STRATEGIES.includes(trade.strategy) && (
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--purple-bg)', color: 'var(--purple)' }} onClick={() => setRollingTrade(trade)}>Roll</button>
                          )}
                          {isOpen && ['Iron Condor','Iron Butterfly'].includes(trade.strategy) && (
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--blue-bg)', color: 'var(--blue)', border: '1px solid var(--blue-border)' }}
                              onClick={() => { const cId = trade.condor_chain_id || trade.id; setAdjustingIC({ trade, chainTrades: trades.filter(t => (t.condor_chain_id || t.id) === cId) }); }}>
                              {trade.strategy === 'Iron Butterfly' ? 'Adj IB' : 'Adj IC'}
                            </button>
                          )}
                          {isOpen && !['Iron Condor','Iron Butterfly'].includes(trade.strategy) && (
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--color-background-danger)', color: 'var(--color-text-danger)', border: '1px solid var(--color-border-danger)' }}
                              onClick={() => onCloseTrade(trade)}
                              title="Close position — record early exit at a specific price">
                              Close
                            </button>
                          )}
                          {isOpen && (
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: 'var(--color-background-secondary)', color: 'var(--color-text-secondary)', border: '1px solid var(--color-border-secondary)' }}
                              onClick={() => onExpired(trade)}
                              title="Expired worthless — option expired at $0">
                              Expired
                            </button>
                          )}
                          {isOpen && <button className="btn btn-ghost btn-xs" style={{ fontSize: 9, padding: '1px 5px' }} onClick={() => onEdit(trade)}>Edit</button>}
                          <button className="btn btn-danger btn-xs" style={{ fontSize: 9, padding: '1px 5px' }} onClick={() => onDelete(trade.id)}>✕</button>
                          {(
                            <button className="btn btn-xs" style={{ fontSize: 9, padding: '1px 5px', background: '#fff8e6', color: '#92600a', border: '1px solid #f0d898' }}
                              title="Explain this trade in plain English"
                              onClick={() => setExplainId(trade.id)}>
                              💡 Explain
                            </button>
                          )}
                        </div>
                      </td>

                      {/* 2. DTE */}
                      <td style={tdS}>
                        {dte != null ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <span style={{ ...monoS, fontWeight: 800, fontSize: 14, color: dteColor, lineHeight: 1 }}>{dte}</span>
                            <div style={{ height: 3, borderRadius: 2, background: 'var(--border)', width: 36 }}>
                              <div style={{ height: '100%', borderRadius: 2, width: dtePct + '%', background: dteColor }} />
                            </div>
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>

                      {/* 3. STRIKE */}
                      <td style={{ ...tdS, ...monoS }}>
                        {trade.strike_sell && trade.strike_buy
                          ? `${trade.strike_sell}/${trade.strike_buy}`
                          : trade.strike_sell ? `$${trade.strike_sell}`
                          : trade.strike_buy  ? `$${trade.strike_buy}`
                          : '—'}
                      </td>

                      {/* 4. QTY */}
                      <td style={{ ...tdS, ...monoS, textAlign: 'center' }}>{trade.contracts}</td>

                      {/* 5. STOCK PRICE */}
                      <td style={tdS}>
                        {isOpen ? (() => {
                          // autoFilled = Yahoo/broker provided value AND trader hasn't manually overridden
                          // stkPrices[id] defined = manual entry → always editable
                          const autoFilled = (currentPrices[trade.id]?.stock != null ||
                            currentPrices[trade.ticker?.toUpperCase()]?.stock != null)
                            && stkPrices[trade.id] === undefined;
                          const stkVal = getStkPrice(trade.id, trade.ticker);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <input className="price-input" type="number" step="0.01"
                                value={stkVal}
                                onChange={e => {
                                  const val = e.target.value;
                                  setStkPrices(p => ({ ...p, [trade.id]: val }));
                                  if (onPriceUpdate) onPriceUpdate(trade.id, trade.ticker, { stock: val ? parseFloat(val) : null });
                                }}
                                placeholder="—"
                                disabled={autoFilled}
                                style={{
                                  width: 58, fontSize: 11, fontFamily: 'var(--font-mono)',
                                  color: isItm ? 'var(--red)' : autoFilled ? 'var(--text-muted)' : 'var(--text-primary)',
                                  background: autoFilled ? 'var(--bg-hover)' : '',
                                  cursor: autoFilled ? 'default' : 'text',
                                }}
                              />
                              {isItm && <span style={{ fontSize: 8, color: 'var(--red)', fontWeight: 700 }}>ITM</span>}
                              {!isItm && stkVal && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                                {autoFilled ? 'Yahoo' : 'manual'}
                              </span>}
                            </div>
                          );
                        })() : '—'}
                      </td>

                      {/* 6. ENTRY PRICE */}
                      <td style={{ ...tdS, ...monoS }}>{trade.entry_price != null ? '$' + parseFloat(trade.entry_price).toFixed(2) : '—'}</td>

                      {/* 6b. CURRENT IV % */}
                      <td style={tdS}>
                        {isOpen ? (() => {
                          // autoFilled = Yahoo/broker provided IV AND trader hasn't manually overridden
                          const autoFilled = currentPrices[trade.id]?.iv != null
                            && ivPrices[trade.id] === undefined;
                          const val = getIvPrice(trade.id, trade);
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <input className="price-input" type="number" step="0.1" min="0.1" max="500"
                                value={val}
                                onChange={e => {
                                  const v = e.target.value;
                                  setIvPrices(p => ({ ...p, [trade.id]: v }));
                                }}
                                placeholder="—"
                                disabled={autoFilled}
                                style={{
                                  width: 46, fontSize: 11, fontFamily: 'var(--font-mono)',
                                  background: autoFilled ? 'var(--bg-hover)' : '',
                                  color: autoFilled ? 'var(--text-muted)' : 'var(--text-primary)',
                                  cursor: autoFilled ? 'default' : 'text',
                                }}
                              />
                              {val && <span style={{ fontSize: 8, color: 'var(--text-muted)' }}>
                                {autoFilled ? 'Yahoo' : 'manual'}
                              </span>}
                            </div>
                          );
                        })() : '—'}
                      </td>

                      {/* 7. CURRENT OPTION PRICE */}
                      <td style={tdS}>
                        {isOpen ? (() => {
                          // autoFilled = Yahoo/broker provided option price AND trader hasn't manually overridden
                          const autoFilled = currentPrices[trade.id]?.option != null
                            && optPrices[trade.id] === undefined;
                          const isBsEst = autoFilled && currentPrices[trade.id]?.isBsEst === true;
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                              <input className="price-input" type="number" step="0.01"
                                value={getOptPrice(trade.id)}
                                onChange={e => {
                                  const val = e.target.value;
                                  setOptPrices(p => ({ ...p, [trade.id]: val }));
                                  if (onPriceUpdate) onPriceUpdate(trade.id, trade.ticker, { option: val ? parseFloat(val) : null });
                                }}
                                placeholder="—"
                                disabled={autoFilled}
                                style={{
                                  width: 58, fontSize: 11, fontFamily: 'var(--font-mono)',
                                  background: autoFilled ? 'var(--bg-hover)' : '',
                                  color: isBsEst ? 'var(--text-secondary)' : autoFilled ? 'var(--text-muted)' : 'var(--text-primary)',
                                  cursor: autoFilled ? 'default' : 'text',
                                }}
                              />
                              {getOptPrice(trade.id) && <span style={{ fontSize: 8, color: isBsEst ? '#f59e0b' : 'var(--text-muted)' }}
                                title={isBsEst ? `Black-Scholes estimate using entry IV (${trade.iv_entry}%) — Yahoo had no chain data for this expiry. Enter Opt $ manually to override.` : undefined}>
                                {isBsEst ? 'est.' : autoFilled ? 'Yahoo' : 'manual'}
                              </span>}
                            </div>
                          );
                        })() : (() => {
                          // For closed trades show exit_price as Opt $
                          // EXCEPT for called-away CCs and assigned CSPs where exit_price
                          // stores the strike/share price, not an option buyback price
                          if (trade.exit_price == null) return '—';
                          const ep = parseFloat(trade.entry_price) || 0;
                          const xp = parseFloat(trade.exit_price)  || 0;
                          const ss = parseFloat(trade.strike_sell)  || 0;
                          const sb = parseFloat(trade.strike_buy)   || 0;
                          const isCalledAway = trade.strategy === 'Covered Call' &&
                            ss > 0 && Math.abs(xp - ss) < 0.01;
                          const isAssigned   = trade.strategy === 'Cash-Secured Put' &&
                            (xp === ep || (sb > 0 && Math.abs(xp - sb) < 0.01));
                          if (isCalledAway || isAssigned) return '—';
                          return `$${xp.toFixed(2)}`;
                        })()}
                      </td>

                      {/* 8. % MAX */}
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        {(() => {
                          if (!isOpen) return '—';
                          // Check for spread width error before calculating
                          const isSpread = DEBIT_SPREAD_STRATEGIES.includes(trade.strategy) ||
                            ['Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'].includes(trade.strategy);
                          if (isSpread && trade.strike_buy != null && trade.strike_sell != null) {
                            const width = Math.abs(parseFloat(trade.strike_sell) - parseFloat(trade.strike_buy));
                            if (width === 0) {
                              return (
                                <span title="Strike buy equals strike sell — check trade entry" style={{ color: 'var(--amber)', fontSize: 10, fontWeight: 600 }}>
                                  ⚠ width=0
                                </span>
                              );
                            }
                          }
                          const pct = calcPctMaxProfit(trade, curOpt);
                          if (pct == null) return '—';
                          const c = pct >= 75 ? 'var(--green)' : pct >= 40 ? 'var(--amber)' : 'var(--text-secondary)';
                          return (
                            <span style={{ color: c, fontWeight: 700, fontSize: 12 }}>
                              {pct.toFixed(1)}%
                              {pct >= 50 && <span style={{ marginLeft: 3, fontSize: 9, color: 'var(--green)' }}>●</span>}
                            </span>
                          );
                        })()}
                      </td>

                      {/* 9. THEO P&L — open positions only. Closed positions have settled P&L — showing Theo is misleading */}
                      <td style={{ ...tdS, background: 'var(--bg-hover)', cursor: 'default' }}>
                        {!isOpen
                          ? <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>
                          : theoPnl != null ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <span
                              className={theoPnl >= 0 ? 'profit' : 'loss'}
                              style={{ ...monoS, fontWeight: 700, opacity: theoIsEst ? 0.85 : 1 }}
                              title={theoIsEst
                                ? `Black-Scholes estimate using ${theoUsedCurrentIv ? 'current' : 'entry'} IV (${curIv || trade.iv_entry}%) + DTE. Enter Opt $ for exact value.`
                                : 'Exact P&L calculated from current option price.'}
                            >
                              {theoPnl >= 0 ? '+' : ''}{fmt(theoPnl)}
                            </span>
                            {theoIsEst
                              ? <span style={{ fontSize: 8, color: 'var(--amber)', fontWeight: 600 }}>
                                  est. · {theoUsedCurrentIv ? 'cur' : 'entry'} IV
                                </span>
                              : null
                            }
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>—</span>}
                      </td>

                      {/* 10. P&L CURVE */}
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        {isOpen && (trade.strike_sell || trade.strike_buy) &&
                         !['Calendar Spread','Diagonal Spread'].includes(trade.strategy) ? (
                          <button
                            className="btn btn-ghost btn-xs"
                            style={{ fontSize: 9, padding: '2px 6px' }}
                            onClick={async () => {
                              const sp  = parseFloat(curStk) || parseFloat(getStkPrice(trade.id, trade.ticker)) || 100;
                              const vix = await fetchVix();
                              const mult = getVixMultiplier(trade.ticker);
                              const ivEst = popupIv[trade.id] || (trade.iv_entry ? trade.iv_entry / 100 : vix * mult);
                              const label = trade.iv_entry ? `IV ${(ivEst*100).toFixed(0)}% (entry)` : `IV ${(ivEst*100).toFixed(0)}% (${estimateIvLabel(trade.ticker)})`;
                              // FIX #7: Pass linked lot data so CC curve includes share P&L
                              const linkedLot = trade.lot_id ? lots.find(l => l.id === trade.lot_id) : null;
                              const data  = getPnlCurveData(trade, sp, ivEst, trade.contracts, linkedLot?.avg_cost, linkedLot?.shares, trades, currentPrices);
                              setCurvePos(null);
              setPnlCurvePopup({ trade, data, iv: ivEst, ivLabel: label, stockPrice: sp });
                            }}
                          >
                            📈 Chart
                          </button>
                        ) : '—'}
                      </td>

                      {/* 11. REALISED P&L */}
                      <td style={tdS}>
                        {(trade.pnl != null && !isNaN(trade.pnl))
                          ? <span className={trade.pnl >= 0 ? 'profit' : 'loss'} style={monoS}>{trade.pnl >= 0 ? '+' : ''}{fmt(trade.pnl)}</span>
                          : '—'}
                      </td>

                      {/* 12. GREEKS */}
                      <td style={{ ...tdS, textAlign: 'center' }}>
                        {(trade.delta || trade.gamma || trade.theta || trade.vega || trade.iv_entry) ? (
                          <button
                            className="btn btn-ghost btn-xs"
                            style={{ fontSize: 9, padding: '2px 5px' }}
                            onMouseEnter={e => { const r = e.target.getBoundingClientRect(); setGreeksPos({ top: r.bottom + 6, left: r.left }); setGreeksTrade(trade); }}
                            onMouseLeave={() => setGreeksTrade(null)}
                          >Δ</button>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>

                      {/* 13. ENTRY DATE */}
                      <td style={{ ...tdS, ...monoS, color: 'var(--text-muted)', fontSize: 11 }}>{fmtDate(trade.entry_date)}</td>

                      {/* 14. EXPIRY DATE */}
                      <td style={{ ...tdS, ...monoS, color: 'var(--text-muted)', fontSize: 11 }}>{fmtDate(trade.expiration)}</td>

                      {/* 15. CLOSED DATE */}
                      <td style={{ ...tdS, ...monoS, color: 'var(--text-muted)', fontSize: 11 }}>{fmtDate(trade.exit_date)}</td>

                      {/* 16. BUY BACK */}
                      <td style={{ ...tdS, ...monoS, color: 'var(--text-muted)', fontSize: 11 }}>{(() => {
                        const xp = parseFloat(trade.exit_price);
                        if (!trade.exit_price || isNaN(xp) || xp <= 0) return '—';
                        // Assignment/called-away: exit_price = strike (not a market buyback)
                        const sb = parseFloat(trade.strike_buy)  || 0;
                        const ss = parseFloat(trade.strike_sell) || 0;
                        if ((sb > 0 && Math.abs(xp - sb) < 0.01) || (ss > 0 && Math.abs(xp - ss) < 0.01)) return '—';
                        return '$' + xp.toFixed(2);
                      })()}</td>

                    </tr>
                  );
                })}
              </tbody>
            </table>
          </DualScrollTable>
          <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--text-muted)', display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {(() => {
                // Table-eligible trades (excluding IC/Cal chain legs shown in chain sections)
                const tableEligible = trades.filter(t => !t.condor_chain_id && t.cal_chain_id == null);
                const filterTotal = tableEligible.filter(t => {
                  if (filter === 'Open')   return t.status === 'open';
                  if (filter === 'Closed') return t.status === 'closed';
                  if (filter === 'Win')    return t.pnl != null && t.pnl > 0;
                  if (filter === 'Loss')   return t.pnl != null && t.pnl < 0;
                  return true;
                }).length;

                // Count visible chain sections (each chain = 1 position)
                const visibleChains = (() => {
                  let n = 0;
                  Object.values(chainGroups).forEach(ct => {
                    const closed = ct.every(t => t.status === 'closed');
                    const totalPnL = ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0), 0);
                    if (filter === 'Open'   && closed)       return;
                    if (filter === 'Closed' && !closed)      return;
                    if (filter === 'Win'    && totalPnL <= 0) return;
                    if (filter === 'Loss'   && totalPnL >= 0) return;
                    n++;
                  });
                  Object.values(calChainGroups).forEach(ct => {
                    const closed = ct.every(t => t.status === 'closed');
                    const totalPnL = ct.reduce((s,t) => s+(t.pnl||0)+(t.partial_close_pnl||0), 0);
                    if (filter === 'Open'   && closed)       return;
                    if (filter === 'Closed' && !closed)      return;
                    if (filter === 'Win'    && totalPnL <= 0) return;
                    if (filter === 'Loss'   && totalPnL >= 0) return;
                    n++;
                  });
                  return n;
                })();

                // Total = table rows matching filter + chain sections (each = 1 position)
                const grandTotal = filterTotal + visibleChains;
                // Showing = filtered table rows + visible chains (search may reduce table rows)
                const showing = filtered.length + visibleChains;

                return `Showing ${showing} of ${grandTotal} position${grandTotal !== 1 ? 's' : ''}`;
              })()}
            </span>
            <span>Click sortable column headers to sort ↕ asc / ↓ desc</span>
          </div>
        </div>
      )}


      {/* P&L Curve popup */}
      {pnlCurvePopup && (() => {
        const { trade, data, ivLabel, stockPrice } = pnlCurvePopup;
        const iv = popupIv[trade.id] ?? pnlCurvePopup.iv;
        if (!data) return null;
        const { points, breakevens } = data;
        const allVals = points.flatMap(p => [p.expiryPnl, p.todayPnl]).filter(v => !isNaN(v));
        const minV = Math.min(...allVals), maxV = Math.max(...allVals);
        const range = maxV - minV || 1;
        const W = 380, H = 180, PAD_L = 52, PAD_R = 12, PAD_T = 16, PAD_B = 32;
        const xScale = (sp) => PAD_L + ((sp - points[0].sp) / (points[points.length-1].sp - points[0].sp)) * (W - PAD_L - PAD_R);
        const yScale = (v)  => PAD_T + (1 - (v - minV) / range) * (H - PAD_T - PAD_B);
        const zeroY  = yScale(0);
        const expiryPath = points.map((p,i) => `${i===0?'M':'L'}${xScale(p.sp).toFixed(1)},${yScale(p.expiryPnl).toFixed(1)}`).join(' ');
        const todayPath  = points.map((p,i) => `${i===0?'M':'L'}${xScale(p.sp).toFixed(1)},${yScale(p.todayPnl).toFixed(1)}`).join(' ');
        const nowX = xScale(stockPrice);
        // Y axis labels
        const yLabels = [minV, 0, maxV].map(v => ({ v, y: yScale(v) }));
        // X axis labels — 5 evenly spaced
        const xLabels = [0,10,20,30,39].map(i => ({ sp: points[i].sp, x: xScale(points[i].sp) }));
        return (
          <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', zIndex: 4000,
              display: 'flex', alignItems: curvePos ? 'flex-start' : 'center', justifyContent: curvePos ? 'flex-start' : 'center' }}
            onClick={e => !curveDragging && e.target === e.currentTarget && (setPnlCurvePopup(null), setCurvePos(null))}>
            <div ref={curveModalRef} style={curvePos
              ? { position: 'fixed', top: curvePos.y, left: curvePos.x, margin: 0, background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', padding: '16px 20px', minWidth: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }
              : { background: 'var(--bg-card)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border)', padding: '16px 20px', minWidth: 440, boxShadow: '0 8px 32px rgba(0,0,0,0.18)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10,
                cursor: curveDragging ? 'grabbing' : 'grab', userSelect: 'none' }}
                onMouseDown={e => {
                  if (e.button !== 0) return;
                  e.preventDefault();
                  const rect = curveModalRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  curveDragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
                  if (!curvePos) setCurvePos({ x: rect.left, y: rect.top });
                  setCurveDragging(true);
                }}
                title="Drag to move">
                <div>
                  <div style={{ fontWeight: 800, fontSize: 14 }}>{trade.ticker} — {trade.strategy}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>P&L Curve · {ivLabel} · <span style={{fontSize:9,fontStyle:'italic'}}>drag to move</span></div>
                </div>
                <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={() => { setPnlCurvePopup(null); setCurvePos(null); }} style={{ fontSize: 16 }}>✕</button>
              </div>
              {/* IV input */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, fontSize: 12 }}>
                <span style={{ color: 'var(--text-secondary)' }}>Implied Volatility:</span>
                <input type="number" step="1" min="1" max="200"
                  value={Math.round((popupIv[trade.id] ?? iv) * 100)}
                  onChange={e => {
                    const newIv = parseFloat(e.target.value) / 100;
                    if (isNaN(newIv) || newIv <= 0) return;
                    setPopupIv(p => ({ ...p, [trade.id]: newIv }));
                    let newData;
                    if (pnlCurvePopup.isCalChain && pnlCurvePopup.shortLeg && pnlCurvePopup.longLeg) {
                      // Cal/Diagonal chain — override both leg IVs with the user-entered value
                      const sLeg = { ...pnlCurvePopup.shortLeg, iv_entry: newIv * 100 };
                      const lLeg = { ...pnlCurvePopup.longLeg,  iv_entry: newIv * 100 };
                      newData = getPnlCurveDataCalChain(sLeg, lLeg, stockPrice, currentPrices, DEFAULT_RISK_FREE_RATE);
                    } else {
                      const linkedLot = trade.lot_id ? lots.find(l => l.id === trade.lot_id) : null;
                      newData = getPnlCurveData(trade, stockPrice, newIv, trade.contracts, linkedLot?.avg_cost, linkedLot?.shares, trades, currentPrices);
                    }
                    if (newData) setPnlCurvePopup(prev => ({ ...prev, data: newData, iv: newIv }));
                  }}
                  style={{ width: 56, fontFamily: 'var(--font-mono)', fontSize: 12, padding: '2px 4px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--bg)' }}
                />
                <span style={{ color: 'var(--text-muted)' }}>% (edit to update curve)</span>
              </div>
              {/* SVG chart */}
              <svg width={W} height={H} style={{ overflow: 'visible', display: 'block' }}>
                {/* Zero line */}
                {zeroY >= PAD_T && zeroY <= H - PAD_B && (
                  <line x1={PAD_L} y1={zeroY} x2={W - PAD_R} y2={zeroY} stroke="var(--border-strong)" strokeWidth="1" strokeDasharray="3,2"/>
                )}
                {/* Breakeven markers */}
                {breakevens.map((be,i) => (
                  <g key={i}>
                    <line x1={xScale(be)} y1={PAD_T} x2={xScale(be)} y2={H-PAD_B} stroke="var(--text-muted)" strokeWidth="0.5" strokeDasharray="2,2"/>
                    <text x={xScale(be)+2} y={PAD_T+8} fontSize="8" fill="var(--text-muted)">BE</text>
                  </g>
                ))}
                {/* Current stock price vertical line */}
                <line x1={nowX} y1={PAD_T} x2={nowX} y2={H-PAD_B} stroke="var(--blue)" strokeWidth="1" strokeDasharray="2,2"/>
                <text x={nowX+2} y={PAD_T+8} fontSize="8" fill="var(--blue)">now</text>
                {/* Expiry curve */}
                <path d={expiryPath} fill="none" stroke="var(--red)" strokeWidth="2"/>
                {/* Today BS curve */}
                <path d={todayPath} fill="none" stroke="var(--blue)" strokeWidth="1.5" strokeDasharray="4,2"/>
                {/* Y axis */}
                {yLabels.map(({v,y}) => (
                  <g key={v}>
                    <line x1={PAD_L-3} y1={y} x2={PAD_L} y2={y} stroke="var(--border)" strokeWidth="0.5"/>
                    <text x={PAD_L-4} y={y+3} fontSize="8" fill="var(--text-muted)" textAnchor="end">
                      {v >= 0 ? '+' : ''}{v >= 1000 || v <= -1000 ? `$${Math.round(v/100)*100}` : `$${Math.round(v)}`}
                    </text>
                  </g>
                ))}
                <line x1={PAD_L} y1={PAD_T} x2={PAD_L} y2={H-PAD_B} stroke="var(--border)" strokeWidth="0.5"/>
                {/* X axis */}
                <line x1={PAD_L} y1={H-PAD_B} x2={W-PAD_R} y2={H-PAD_B} stroke="var(--border)" strokeWidth="0.5"/>
                {xLabels.map(({sp,x}) => (
                  <text key={sp} x={x} y={H-PAD_B+10} fontSize="8" fill="var(--text-muted)" textAnchor="middle">{sp.toFixed(0)}</text>
                ))}
              </svg>
              {/* Legend */}
              <div style={{ display: 'flex', gap: 16, marginTop: 8, fontSize: 10, color: 'var(--text-muted)' }}>
                <span><span style={{ color: 'var(--red)', fontWeight: 700 }}>—</span> P&L at expiry (exact)</span>
                <span><span style={{ color: 'var(--blue)', fontWeight: 700 }}>- -</span> P&L today (Black-Scholes)</span>
                <span style={{ color: 'var(--text-muted)' }}>— — Breakeven · <span style={{ color: 'var(--blue)' }}>| now</span></span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Greeks floating popup */}
      {greeksTrade && (
        <GreeksPopup trade={greeksTrade} style={{ position: 'fixed', top: greeksPos.top, left: greeksPos.left, zIndex: 3000 }} />
      )}

      {/* Roll modal */}
      {rollingTrade && (
        <RollModal trade={rollingTrade} onRoll={onRoll} onClose={() => setRollingTrade(null)}
          historicalMode={historicalMode}
          isMock={isMock} currentPrices={currentPrices} lots={lots} trades={trades} onPriceUpdate={onPriceUpdate} />
      )}

      {/* IC chain adjust modal */}
      {adjustingIC && (
        <ICAdjustModal
          trade={adjustingIC.trade}
          chainTrades={adjustingIC.chainTrades}
          onAdjust={onICAdjust}
              historicalMode={historicalMode}
          onClose={() => setAdjustingIC(null)}
        />
      )}

      {/* Trade Explain modal */}
      {/* Always look up trade fresh from current trades array so modal reflects latest state */}
      {explainId != null && (() => {
        const liveTrade = trades.find(t => t.id === explainId);
        if (!liveTrade) return null;
        return (
          <TradeExplainModal
            trade={liveTrade}
            trades={trades}
            isMock={isMock}
            onClose={() => setExplainId(null)}
          />
        );
      })()}
    </div>
  );
}
