// src/utils/tradingCalendar.js
// Shared trading calendar utilities — used by demoEngine, TradeLog, Alerts, ICAdjustModal.
// FIX #3:  Holiday-aware Friday snap for roll modal expiry.
// FIX #14: Centralised risk-free rate constant (replaces hardcoded 0.05/0.053).

export const DEFAULT_RISK_FREE_RATE = 0.053;
// Default IV used in BSM estimates when iv_entry is blank and no broker connected.
// Applied silently — never pre-fills the TradeForm field.
// 15% is a reasonable broad-market default for SPY/QQQ-type positions.
export const DEFAULT_BSM_IV = 15; // percent

// ── Black-Scholes helpers (exported for TradeForm suggestions + TradeLog curves) ──
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const s=x<0?-1:1; const ax=Math.abs(x);
  const t=1/(1+p*ax);
  const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-ax*ax);
  return s*y;
}
const N = x => 0.5*(1+erf(x/Math.sqrt(2)));

export function bsmPrice(S, K, T, sigma, isCall, r = DEFAULT_RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const d1 = (Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  return isCall ? S*N(d1)-K*Math.exp(-r*T)*N(d2) : K*Math.exp(-r*T)*N(-d2)-S*N(-d1);
}

// delta: ∂V/∂S  (call positive, put negative)
export function bsmDelta(S, K, T, sigma, isCall, r = DEFAULT_RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0 || S <= 0) return isCall ? 0 : -1;
  const d1 = (Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  return isCall ? N(d1) : N(d1)-1;
}

// theta: daily time decay in $ (negative for both buyer and seller, but works for seller)
export function bsmTheta(S, K, T, sigma, isCall, r = DEFAULT_RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0 || S <= 0) return 0;
  const d1 = (Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const nd1 = Math.exp(-0.5*d1*d1)/Math.sqrt(2*Math.PI);
  const annualTheta = isCall
    ? -(S*nd1*sigma)/(2*Math.sqrt(T)) - r*K*Math.exp(-r*T)*N(d2)
    : -(S*nd1*sigma)/(2*Math.sqrt(T)) + r*K*Math.exp(-r*T)*N(-d2);
  return annualTheta / 365; // per calendar day
}

function easterSunday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25);
  const g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4;
  const l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451);
  return { month: Math.floor((h+l-7*m+114)/31), day: ((h+l-7*m+114)%31)+1 };
}

const _cache = {};
function fridayHolidaysForYear(year) {
  const s = new Set();
  const {month:em,day:ed} = easterSunday(year);
  const gf = new Date(year,em-1,ed); gf.setDate(gf.getDate()-2);
  s.add(toISO(gf));
  for (const [mo,da] of [[1,1],[7,4],[12,25]]) {
    const d = new Date(year,mo-1,da);
    if (d.getDay()===6) { d.setDate(d.getDate()-1); s.add(toISO(d)); }
  }
  return s;
}

export function isMarketHoliday(iso) {
  const yr = parseInt(iso.slice(0,4),10);
  if (!_cache[yr]) _cache[yr] = fridayHolidaysForYear(yr);
  return _cache[yr].has(iso);
}

// Use local date to avoid UTC timezone shift (toISOString gives UTC which can be wrong day)
const toISO = d => {
  const yr  = d.getFullYear();
  const mo  = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${yr}-${mo}-${day}`;
};

export function nearestExpiryFriday(fromDate) {
  // Rebuild from local components to avoid UTC timezone copy shift
  const src = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const dt = new Date(src.getFullYear(), src.getMonth(), src.getDate());
  while (dt.getDay()!==5) dt.setDate(dt.getDate()+1);
  if (isMarketHoliday(toISO(dt))) dt.setDate(dt.getDate()-1);
  return toISO(dt);
}

export function lastExpiryFriday(fromDate) {
  const src = fromDate instanceof Date ? fromDate : new Date(fromDate);
  const dt = new Date(src.getFullYear(), src.getMonth(), src.getDate());
  while (dt.getDay()!==5) dt.setDate(dt.getDate()-1);
  if (isMarketHoliday(toISO(dt))) dt.setDate(dt.getDate()-1);
  return toISO(dt);
}

export function expiryAhead(n) {
  // Build from local date components to avoid UTC timezone ambiguity
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
  return nearestExpiryFriday(d);
}
export function expiryAgo(n) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
  return lastExpiryFriday(d);
}
