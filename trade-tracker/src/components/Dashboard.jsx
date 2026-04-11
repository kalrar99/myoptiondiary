// src/components/Dashboard.jsx
import React, { useMemo } from 'react';
import { AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const fmt  = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fmtD = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtK = (n) => n == null ? '—' : (Math.abs(n) >= 1000 ? (n/1000).toFixed(1)+'k' : n.toFixed(0));


// Inline Black-Scholes for Dashboard BS fallback (avoids cross-module import complexity)
function bsDashboard(S, K, T, r, sigma, isCall) {
  if (T <= 0 || sigma <= 0 || S <= 0 || K <= 0) return 0;
  const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  function N(x) { const a=[0,0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429],k=1/(1+0.2316419*Math.abs(x));let p=0,kp=k;for(let i=1;i<=5;i++){p+=a[i]*kp;kp*=k;}const n=Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI);const v=1-n*p;return x>=0?v:1-v; }
  if (isCall) return Math.max(0, S * N(d1) - K * Math.exp(-r * T) * N(d2));
  return Math.max(0, K * Math.exp(-r * T) * N(-d2) - S * N(-d1));
}


export default function Dashboard({ trades, lots, stats, isMock, pill, onAddTrade, currentPrices, yahooStatus, onFetchYahoo, pricesUpdatedAt, liveStatus, onOpenTradesClick, onGoToTrades, onGoToPositions, bucketTickers }) {
  const [showCloseOutDetail, setShowCloseOutDetail] = React.useState(false);
  const [showCapitalDetail,   setShowCapitalDetail]   = React.useState(false);
  const [showGrossDetail,     setShowGrossDetail]     = React.useState(false);
  const [showRealisedDetail,  setShowRealisedDetail]  = React.useState(false);
  const [grossExpanded,       setGrossExpanded]       = React.useState({});   // keyed by ticker index
  const [realisedOptExpanded, setRealisedOptExpanded] = React.useState({});   // option bucket, keyed by ticker
  const [realisedShrExpanded, setRealisedShrExpanded] = React.useState({});   // share bucket, keyed by ticker
  const closed = useMemo(() => trades
    .filter(t => t.status === 'closed' && t.pnl != null)
    .sort((a, b) => new Date(a.exit_date) - new Date(b.exit_date)),
  [trades]);

  // closedPnl: same realised calculation as closedSum in the useMemo below.
  // Used for the Close-Out breakdown chart and the inline "Realised:" label.
  // Includes: closed option P&L + assignment premiums + called-away premiums + closed lot share gains.
  const closedPnl = (() => {
    const optionPnl = closed.reduce((s, t) => {
      if (t.pnl !== 0 && t.pnl != null) return s + t.pnl;
      const entry  = parseFloat(t.entry_price) || 0;
      const exitP  = parseFloat(t.exit_price)  || 0;
      const skb    = parseFloat(t.strike_buy)  || 0;
      const sks    = parseFloat(t.strike_sell) || 0;
      const c      = t.contracts || 1;
      const isCSPAssign    = t.strategy === 'Cash-Secured Put' &&
        (exitP === entry || (skb > 0 && exitP === skb));
      const isCCCalledAway = t.strategy === 'Covered Call' &&
        sks > 0 && Math.abs(exitP - sks) < 0.01;
      if (isCSPAssign || isCCCalledAway) return s + Math.round(entry * c * 100);
      return s;
    }, 0);
    const sharePnl = (lots || [])
      .filter(l => l.close_date && l.close_price != null)
      .reduce((s, l) => {
        // Skip lot share gain only if the CC pnl already includes it (manual workflow).
        // Import workflow stores premium-only pnl → share gain must be added separately.
        const calledAwayCC = closed.find(t =>
          t.lot_id === l.id && t.strategy === 'Covered Call' &&
          t.pnl != null && t.pnl !== 0 &&
          Math.abs(parseFloat(t.exit_price) - parseFloat(l.close_price)) < 0.01
        );
        if (calledAwayCC) {
          const premiumOnly = Math.round((parseFloat(calledAwayCC.entry_price) || 0) * (calledAwayCC.contracts || 1) * 100);
          if (calledAwayCC.pnl > premiumOnly * 1.5) return s; // combined pnl → skip
          // else premium-only → fall through and add share gain
        }
        const gain = (parseFloat(l.close_price) - parseFloat(l.avg_cost)) * parseFloat(l.shares);
        return s + (isNaN(gain) ? 0 : Math.round(gain));
      }, 0);
    return optionPnl + sharePnl;
  })();

  const cumulativeData = useMemo(() => {
    let running = 0;
    // Build list of all realised events: closed trades + closed lot share gains.
    // Sort by date so the cumulative curve is chronologically accurate.
    const tradeEvents = closed.map(t => {
      let tradePnl = t.pnl || 0;
      if (tradePnl === 0) {
        const entry = parseFloat(t.entry_price) || 0;
        const exitP = parseFloat(t.exit_price)  || 0;
        const skb   = parseFloat(t.strike_buy)  || 0;
        const sks   = parseFloat(t.strike_sell) || 0;
        const c     = t.contracts || 1;
        const isCSPAssign    = t.strategy === 'Cash-Secured Put' &&
          (exitP === entry || (skb > 0 && exitP === skb));
        const isCCCalledAway = t.strategy === 'Covered Call' &&
          sks > 0 && Math.abs(exitP - sks) < 0.01;
        if (isCSPAssign || isCCCalledAway) tradePnl = Math.round(entry * c * 100);
      }
      return { date: (t.exit_date || t.entry_date)?.slice(0, 7) || '', pnl: tradePnl, missingExitDate: !t.exit_date, isLot: false };
    });
    // Add closed lot share gain events — dated by close_date
    // Skip lots where a CC called-away trade already includes the share gain in its pnl
    const lotEvents = (lots || [])
      .filter(l => l.close_date && l.close_price != null)
      .filter(l => !closed.find(t =>
        t.lot_id === l.id && t.strategy === 'Covered Call' &&
        t.pnl != null && t.pnl !== 0 &&
        Math.abs(parseFloat(t.exit_price) - parseFloat(l.close_price)) < 0.01
      ))
      .map(l => {
        const gain = Math.round((parseFloat(l.close_price) - parseFloat(l.avg_cost)) * parseFloat(l.shares));
        return { date: l.close_date?.slice(0, 7) || '', pnl: isNaN(gain) ? 0 : gain, missingExitDate: false, isLot: true };
      });
    // Merge and sort by date
    const allEvents = [...tradeEvents, ...lotEvents].sort((a, b) => a.date.localeCompare(b.date));
    return allEvents.map(ev => ({
      date: ev.date,
      pnl: ev.pnl,
      cumulative: (running += ev.pnl),
      missingExitDate: ev.missingExitDate,
    }));
  }, [closed]);

  // Count trades using the entry_date fallback so we can show a banner
  const missingExitDateCount = useMemo(
    () => closed.filter(t => !t.exit_date).length,
    [closed]
  );

  // ── Total P&L Today + Close-Out P&L ──────────────────────
  //
  // TOTAL P&L TODAY = realised + premium already collected on open credit positions
  //   Realised = closed option P&L + assignment premiums + called-away premiums
  //            + closed lot share gains  (all cash already in brokerage account)
  //   Open credit premium = entry_price × c × 100 on open CCs, CSPs, IC legs etc.
  //   Does NOT require current prices — always calculable.
  //   Answers: "what have I actually earned to date including open premium income?"
  //
  // CLOSE-OUT P&L = realised + net option P&L if closed NOW + unrealised stock P&L
  //   Realised:    all cash already received (options + share gains on closed lots)
  //   Option net:  (entry - current) × c × 100 [credit] or (current - entry) [debit]
  //   Stock:       (current_stock - avg_cost) × shares on OPEN lots only
  //                (closed lots are already in Realised — not double-counted here)
  //   Requires current prices for option net + stock. Without prices = realised only.
  //   Answers: "what lands in my account if I exit everything right now?"
  //
  // Gap between them = time value remaining in open positions (early-exit cost).
  const { totalPnlToday, closeOutPnl, openPriced, openTotal, missingPrices,
          estimatedCount, stockPricedCount, stockUnrealisedPnl,
          openCreditPremium, closeOutOptionPnl,
          wheelCount, standaloneCount, openIcChains, openCalChains } = useMemo(() => {

    // closedSum: sum pnl fields of all closed trades.
    // For assigned CSPs (pnl=0): add entry_price×c×100 — real cash collected before assignment.
    //   Detection: strategy=CSP AND (exit_price===entry_price [demo] OR exit_price===strike_buy [live])
    // For called-away CCs (pnl=0): add entry_price×c×100 — real premium collected before call-away.
    //   Detection: strategy=CC AND |exit_price − strike_sell| < 0.01
    // This makes Realised = all cash from closed positions, matching the trader's brokerage account.
    const closedOptionSum = closed.reduce((s, t) => {
      if (t.pnl !== 0 && t.pnl != null) return s + t.pnl;
      // Zero-pnl trade: check if it's an assignment or called-away event
      const entry    = parseFloat(t.entry_price) || 0;
      const exitP    = parseFloat(t.exit_price)  || 0;
      const strikeBuy  = parseFloat(t.strike_buy)  || 0;
      const strikeSell = parseFloat(t.strike_sell) || 0;
      const c        = t.contracts || 1;
      const isCSPAssign = t.strategy === 'Cash-Secured Put' &&
        (exitP === entry || (strikeBuy > 0 && exitP === strikeBuy));
      const isCCCalledAway = t.strategy === 'Covered Call' &&
        strikeSell > 0 && Math.abs(exitP - strikeSell) < 0.01;
      if (isCSPAssign || isCCCalledAway) return s + Math.round(entry * c * 100);
      return s; // pnl=0 for other reasons (e.g. flat trade) — don't add
    }, 0)
    // Add partial_close_pnl from still-open IC/Cal chain legs (reduce_position partial closes).
    // These legs remain status='open' but have already realised cash sitting in partial_close_pnl.
    // TradeLog uses the same pattern — pnl + partial_close_pnl — for chain P&L display.
    + trades.reduce((s, t) => {
      if (t.status !== 'open') return s;                          // closed legs already in closedOptionSum
      if (!t.condor_chain_id && t.cal_chain_id == null) return s; // standalone trades — no partial closes
      return s + (t.partial_close_pnl || 0);
    }, 0);

    // Closed lot share gain/loss — fully realised cash when shares were sold.
    // For manual lot closures (Sell Shares / End Wheel): share gain is ONLY in closedLotShareGain.
    // For CC called-away in LIVE mode: handleCalledAway already stores pnl = full return
    //   (share gain + option premium together) — so we must NOT add closedLotShareGain again.
    // For CC called-away in DEMO mode: pnl=0 by convention — closedLotShareGain IS needed.
    // Detection: if a closed CC trade is linked to this lot AND its pnl != 0,
    //   the share gain is already inside that pnl → skip closedLotShareGain for this lot.
    const closedTrades = closed; // already computed above
    const closedLotShareGain = (lots || [])
      .filter(l => l.close_date && l.close_price != null)
      .reduce((s, l) => {
        // Check if a CC called-away trade already includes the share gain in its pnl
        const calledAwayCC = closedTrades.find(t =>
          t.lot_id === l.id &&
          t.strategy === 'Covered Call' &&
          t.status === 'closed' &&
          t.pnl != null && t.pnl !== 0 &&
          Math.abs(parseFloat(t.exit_price) - parseFloat(l.close_price)) < 0.01
        );
        if (calledAwayCC) {
          const premiumOnly = Math.round((parseFloat(calledAwayCC.entry_price) || 0) * (calledAwayCC.contracts || 1) * 100);
          if (calledAwayCC.pnl > premiumOnly * 1.5) return s; // combined pnl → skip
          // else premium-only → fall through and add share gain
        }
        const gain = (parseFloat(l.close_price) - parseFloat(l.avg_cost)) * parseFloat(l.shares);
        return s + (isNaN(gain) ? 0 : Math.round(gain));
      }, 0);

    // closedSum = all realised option cash + all realised share gains
    const closedSum = closedOptionSum + closedLotShareGain;
    // Exclude IC/IB chain legs from openTrades for pricing/counting purposes.
    // Each IC chain appears as 2 records but represents 1 position.
    // Calendar chain legs are similarly tracked as chains — exclude from standalone counts.
    // Chain-level unrealised P&L is tracked in Trade Log computeChainPnL / computeCalChainPnL.
    const openTrades    = trades.filter(t => t.status === 'open' && !t.condor_chain_id && t.cal_chain_id == null);
    // Keep IC and calendar legs for credit premium calculation (they contribute real cash)
    const allOpenTrades = trades.filter(t => t.status === 'open');
    const CREDIT_SET = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread',
                                'Bear Call Spread','Iron Condor','Iron Butterfly']);

    // ── Gross Premium Collected: gross premium ever credited ─────────────────
    // One-way accumulator: sum of entry_price × contracts × 100 for ALL credit
    // trades ever opened (both open AND closed), plus closed lot share gains.
    //
    // This answers: "How much has selling options ever put into my account?"
    // It NEVER goes down — closing a position early at a loss does not reduce it.
    // That loss is reflected in Realised P&L (the net tile below).
    //
    // The relationship between the three tiles:
    //   Gross Premium Collected = gross premium ceiling (all credits ever collected)
    //   Realised P&L            = what you've kept so far (closed positions net)
    //   Close-Out P&L           = what you'd walk away with if closing everything now
    //
    // Debit trades excluded — you PAID cash, received nothing yet.
    // IC/Cal chain legs included — they represent real cash collected.
    // contracts_open used for open trades (partial closes reduce the count).
    // contracts used for closed trades (full original contracts, already settled).

    // Gross premium from ALL credit trades (open + closed)
    // Always use `contracts` (not contracts_open) — we want the full original
    // lot size ever opened. Partial closes reduce contracts_open but the entry
    // premium on the full original contracts was physically received.
    let allCreditPremium = 0;
    trades.forEach(t => {
      const entry     = parseFloat(t.entry_price) || 0;
      const contracts = t.contracts || 1;  // always full original contracts
      // Calendar/Diagonal: only short legs represent credits collected
      if (t.strategy === 'Calendar Spread' || t.strategy === 'Diagonal Spread') {
        if (t.cal_leg === 'short') allCreditPremium += Math.round(entry * contracts * 100 * 100) / 100;
        return;
      }
      if (!CREDIT_SET.has(t.strategy)) return;
      allCreditPremium += Math.round(entry * contracts * 100 * 100) / 100;
    });

    const totalPnlToday = allCreditPremium;  // options only — share gains belong in Realised P&L

    // openCreditPremium still needed for the badge "X collected on open positions"
    // and for Close-Out P&L subtitle. Keep computing it separately.
    let openCreditPremium = 0;
    allOpenTrades.forEach(t => {
      const entry     = parseFloat(t.entry_price) || 0;
      const contracts = t.contracts_open != null ? t.contracts_open : (t.contracts || 1);
      // Calendar/Diagonal: only open short legs represent credits on open positions
      if (t.strategy === 'Calendar Spread' || t.strategy === 'Diagonal Spread') {
        if (t.cal_leg === 'short') openCreditPremium += Math.round(entry * contracts * 100 * 100) / 100;
        return;
      }
      if (!CREDIT_SET.has(t.strategy)) return;
      openCreditPremium += Math.round(entry * contracts * 100 * 100) / 100;
    });

    // ── Close-Out P&L: mark-to-market on all open positions ──
    // Option net P&L (buy back / sell to close at current price)
    let closeOutOptionPnl = 0;
    let pricedCount       = 0;
    let estimatedCount    = 0;  // BS estimate counter (for amber badge)
    const missing         = [];
    // openTrades = standalone only (no condor_chain_id / cal_chain_id)
    openTrades.forEach(t => {
      const entry     = parseFloat(t.entry_price) || 0;
      const contracts = t.contracts || 1;
      const op        = parseFloat(currentPrices?.[t.id]?.option);
      if (!isNaN(op) && op >= 0) {
        const pnl = CREDIT_SET.has(t.strategy)
          ? (entry - op) * contracts * 100
          : (op - entry) * contracts * 100;
        closeOutOptionPnl += pnl;
        pricedCount++;
      } else {
        // BS fallback for close-out estimate
        const stockPrice = parseFloat(currentPrices?.[t.id]?.stock ||
          currentPrices?.[t.ticker?.toUpperCase()]?.stock);
        const curIvPct = currentPrices?.[t.id]?.iv;
        const ivPct = curIvPct != null ? curIvPct : (t.iv_entry || 0);
        const iv    = ivPct ? ivPct / 100 : null;
        const kSell = parseFloat(t.strike_sell) || 0;
        const kBuy  = parseFloat(t.strike_buy)  || 0;
        const expD  = t.expiration ? new Date(t.expiration) : null;
        const T     = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
        const NO_EST = new Set(['Long Straddle','Long Strangle']);
        const strat = t.strategy;
        if (stockPrice && iv && T > 0 && !NO_EST.has(strat)) {
          let bsOpt = null;
          const S = stockPrice, sig = iv, r2 = 0.053;
          if (strat === 'Covered Call' && kSell)
            bsOpt = bsDashboard(S, kSell, T, r2, sig, true);
          else if (strat === 'Cash-Secured Put' && kBuy)
            bsOpt = bsDashboard(S, kBuy, T, r2, sig, false);
          else if (strat === 'Long Call' && kBuy)
            bsOpt = bsDashboard(S, kBuy, T, r2, sig, true);
          else if (strat === 'Long Put' && kBuy)
            bsOpt = bsDashboard(S, kBuy, T, r2, sig, false);
          else if ((strat === 'Bear Call Spread' || strat === 'Bull Call Spread') && kSell && kBuy)
            bsOpt = bsDashboard(S, kSell, T, r2, sig, true) - bsDashboard(S, kBuy, T, r2, sig, true);
          else if ((strat === 'Bull Put Spread' || strat === 'Bear Put Spread') && kSell && kBuy)
            bsOpt = bsDashboard(S, kBuy, T, r2, sig, false) - bsDashboard(S, kSell, T, r2, sig, false);
          if (bsOpt != null && bsOpt >= 0) {
            const pnl = CREDIT_SET.has(strat)
              ? (entry - bsOpt) * contracts * 100
              : (bsOpt - entry) * contracts * 100;
            closeOutOptionPnl += pnl;
            estimatedCount++;
            pricedCount++;
          } else {
            missing.push(t.ticker);
          }
        } else {
          missing.push(t.ticker);
        }
      }
    });

    // ── IC / IB chains — BS estimate per open leg ─────────────────────────
    // Group open IC/IB legs by condor_chain_id, price each leg independently.
    // Each leg is a credit spread: P&L = (entry − bsSpread) × contracts × 100.
    const icChainGroups = {};
    allOpenTrades.filter(t => (t.strategy === 'Iron Condor' || t.strategy === 'Iron Butterfly') && t.condor_chain_id)
      .forEach(t => { const cid = t.condor_chain_id; if (!icChainGroups[cid]) icChainGroups[cid] = []; icChainGroups[cid].push(t); });
    Object.entries(icChainGroups).forEach(([cid, legs]) => {
      const ticker = legs[0]?.ticker?.toUpperCase();
      const stockPrice = parseFloat(currentPrices?.[ticker]?.stock ||
        Object.values(currentPrices || {}).find(p => p?.ticker === ticker)?.stock);
      if (!stockPrice) { missing.push(ticker); return; }
      let chainPnl = 0; let anyPriced = false;
      legs.forEach(leg => {
        const entry = parseFloat(leg.entry_price) || 0;
        // Use contracts_open so partially-reduced IC/IB legs are sized correctly.
        // Fall back to leg.contracts only when contracts_open is absent (legacy records).
        // IMPORTANT: keep the null-check and the zero-guard separate.
        // `(expr) || 1` would coerce contracts_open=0 to 1 — wrong for a fully-closed leg.
        const cRaw = leg.contracts_open != null ? leg.contracts_open : (leg.contracts ?? 1);
        const c    = cRaw > 0 ? cRaw : 0;
        if (c <= 0) return; // fully closed leg — contributes nothing to unrealised
        const op    = parseFloat(currentPrices?.[leg.id]?.option);
        if (!isNaN(op) && op >= 0) {
          chainPnl += (entry - op) * c * 100; anyPriced = true;
        } else {
          const ivPct = currentPrices?.[leg.id]?.iv != null ? currentPrices[leg.id].iv : (leg.iv_entry || 15);
          const iv = ivPct ? ivPct / 100 : null;
          const kS = parseFloat(leg.strike_sell) || 0;
          const kB = parseFloat(leg.strike_buy)  || 0;
          const expD = leg.expiration ? new Date(leg.expiration) : null;
          const T = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
          if (iv && T > 0 && kS && kB) {
            const isCall = (leg.condor_leg === 'call' || leg.condor_leg === 'full'); // 'full' = IB body leg, priced as call side
            const bsSpread = Math.max(0, bsDashboard(stockPrice, kS, T, 0.053, iv, isCall) - bsDashboard(stockPrice, kB, T, 0.053, iv, isCall));
            chainPnl += (entry - bsSpread) * c * 100; anyPriced = true; estimatedCount++;
          }
        }
      });
      if (anyPriced) { closeOutOptionPnl += chainPnl; pricedCount++; }
      else { missing.push(ticker); }
    });

    // ── Calendar / Diagonal chains — BS estimate per open leg ────────────
    // Price each open leg independently: short=credit formula, long=debit formula.
    const calChainGroups = {};
    allOpenTrades.filter(t => t.cal_chain_id)
      .forEach(t => { const cid = t.cal_chain_id; if (!calChainGroups[cid]) calChainGroups[cid] = []; calChainGroups[cid].push(t); });
    Object.entries(calChainGroups).forEach(([cid, legs]) => {
      const ticker = legs[0]?.ticker?.toUpperCase();
      const stockPrice = parseFloat(currentPrices?.[ticker]?.stock ||
        Object.values(currentPrices || {}).find(p => p?.ticker === ticker)?.stock);
      if (!stockPrice) { missing.push(ticker); return; }
      let chainPnl = 0; let anyPriced = false;
      legs.forEach(leg => {
        const entry = parseFloat(leg.entry_price) || 0;
        // Use contracts_open so partially-reduced Calendar/Diagonal legs are sized correctly.
        // Fall back to leg.contracts only when contracts_open is absent (legacy records).
        // Keep null-check and zero-guard separate — `|| 1` would coerce 0 to 1 incorrectly.
        const cRaw = leg.contracts_open != null ? leg.contracts_open : (leg.contracts ?? 1);
        const c    = cRaw > 0 ? cRaw : 0;
        if (c <= 0) return; // fully closed leg — contributes nothing to unrealised
        const isShort = leg.cal_leg === 'short';
        const op    = parseFloat(currentPrices?.[leg.id]?.option);
        if (!isNaN(op) && op >= 0) {
          chainPnl += isShort ? (entry - op) * c * 100 : (op - entry) * c * 100; anyPriced = true;
        } else {
          const ivPct = currentPrices?.[leg.id]?.iv != null ? currentPrices[leg.id].iv : (leg.iv_entry || 15);
          const iv = ivPct ? ivPct / 100 : null;
          const k  = parseFloat(leg.strike_sell || leg.strike_buy) || 0;
          const expD = leg.expiration ? new Date(leg.expiration) : null;
          const T = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
          if (iv && T > 0 && k) {
            const isCallOpt = leg.option_type !== 'put';
            const bsOpt = bsDashboard(stockPrice, k, T, 0.053, iv, isCallOpt);
            if (bsOpt != null && bsOpt >= 0) {
              chainPnl += isShort ? (entry - bsOpt) * c * 100 : (bsOpt - entry) * c * 100;
              anyPriced = true; estimatedCount++;
            }
          }
        }
      });
      if (anyPriced) { closeOutOptionPnl += chainPnl; pricedCount++; }
      else { missing.push(ticker); }
    });

    // ── Stock unrealised P&L — all open lots ─────────────────
    const openLots = (lots || []).filter(l => !l.close_date);
    let stockUnrealisedPnl = 0;
    let stockPricedCount   = 0;
    openLots.forEach(lot => {
      const ticker     = lot.ticker?.toUpperCase();
      const stockPrice = parseFloat(
        currentPrices?.[ticker]?.stock ||
        Object.values(currentPrices || {}).find(p => p?.ticker === ticker)?.stock
      );
      if (stockPrice > 0) {
        const cost   = parseFloat(lot.avg_cost) || 0;
        const shares = parseFloat(lot.shares)   || 0;
        if (cost > 0 && shares > 0) {
          stockUnrealisedPnl += (stockPrice - cost) * shares;
          stockPricedCount++;
        }
      }
    });

    const closeOutPnl   = closedSum + closeOutOptionPnl + stockUnrealisedPnl;
    const uniqueMissing = [...new Set(missing)];

    return {
      totalPnlToday,
      closeOutPnl,
      openCreditPremium,
      closeOutOptionPnl,
      openPriced:        pricedCount,
      estimatedCount,
      // Count IC/Cal chains as 1 position each (not 2 legs) — matches bucket tile count
      openIcChains:      (() => { const s=new Set(); allOpenTrades.filter(t=>t.condor_chain_id).forEach(t=>s.add(t.condor_chain_id)); return s.size; })(),
      openCalChains:     (() => { const s=new Set(); allOpenTrades.filter(t=>t.cal_chain_id!=null).forEach(t=>s.add(t.cal_chain_id)); return s.size; })(),
      openTotal:         openTrades.length, // individual trades (no chain legs)
      wheelCount:        openTrades.filter(t => t.lot_id != null).length,
      standaloneCount:   openTrades.filter(t => t.lot_id == null).length,
      missingPrices:     uniqueMissing,
      stockPricedCount,
      stockUnrealisedPnl,
    };
  }, [closed, trades, currentPrices, lots]);

  // ── Capital Deployed ──────────────────────────────────────
  // Complete capital-at-risk across all open strategies:
  //   CSP          → strike × contracts × 100  (cash reserved for assignment)
  //   Stock lots   → avg_cost × shares  (capital tied up in shares)
  //   Debit strats → entry_price × contracts × 100  (cash paid upfront)
  //                  (Long Call/Put, BCS, BPS, Straddle, Strangle, Calendar, Diagonal)
  //   Credit spreads → (spread_width − credit) × contracts × 100  (margin held)
  //                  (Bull Put Spread, Bear Call Spread)
  //   IC / IB chains → max(put_width, call_width) − total_credit × contracts × 100
  //                  (broker margins only the wider side — can't lose both simultaneously)
  //   CCs          → not counted — shares already in stock capital
  const { cspCapital, stockCapital, debitCapital, marginCapital, icCapital, totalCapital } = useMemo(() => {
    const open = trades.filter(t => t.status === 'open');

    // 1. CSP cash reserved
    const csp = open
      .filter(t => t.strategy === 'Cash-Secured Put')
      .reduce((s, t) => s + (parseFloat(t.strike_buy) || 0) * (t.contracts || 1) * 100, 0);

    // 2. Stock lots — net cost basis = (avg_cost × shares) minus all wheel premiums collected
    // This reflects real capital still at risk after premium income has reduced the cost basis.
    // Uses same premium calculation logic as StockPositions calcLotPremium.
    const CREDIT_STRATS_CAP = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'];
    const openLots = (lots || []).filter(l => !l.close_date);
    const stock = openLots.reduce((s, l) => {
      const rawCost = (parseFloat(l.avg_cost) || 0) * (parseFloat(l.shares) || 0);
      // Sum all premiums from trades linked to this lot
      const lotTrades = trades.filter(t => t.lot_id === l.id);
      const premiums = lotTrades.reduce((ps, t) => {
        const entry = t.entry_price || 0;
        const exit  = t.exit_price  || 0;
        const closed = t.status === 'closed';
        const isCredit = CREDIT_STRATS_CAP.includes(t.strategy);
        const isCSPAssign = closed && t.strategy === 'Cash-Secured Put' &&
          (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
           (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
        const effectiveExit = isCSPAssign ? 0 : exit;
        const prem = isCredit
          ? (entry - (closed ? effectiveExit : 0)) * t.contracts * 100
          : ((closed ? effectiveExit : 0) - entry) * t.contracts * 100;
        return ps + prem;
      }, 0);
      return s + Math.max(0, rawCost - premiums);
    }, 0);

    // 3. Debit strategies — premium paid is capital deployed
    // Standalone debit strategies are stored as a single record whose entry_price IS the net debit.
    // Calendar / Diagonal are stored as 2-leg chains (cal_chain_id). Must net long − short,
    // not sum both legs — otherwise capital deployed is overstated by the short-leg credit.
    const DEBIT_STRATS_STANDALONE = new Set(['Long Call','Long Put','Bull Call Spread','Bear Put Spread',
                                             'Long Straddle','Long Strangle']);
    const standaloneDebit = open
      .filter(t => DEBIT_STRATS_STANDALONE.has(t.strategy) && !t.cal_chain_id)
      .reduce((s, t) => s + (parseFloat(t.entry_price) || 0) * (t.contracts || 1) * 100, 0);

    // Calendar / Diagonal chains: net debit = (long leg entry − short leg entry) × contracts × 100
    // Persona 1: the long leg costs more than the short leg credit — net cash out of pocket is the diff.
    const calDebitGroups = {};
    open.filter(t => (t.strategy === 'Calendar Spread' || t.strategy === 'Diagonal Spread') && t.cal_chain_id)
        .forEach(t => {
          const cid = t.cal_chain_id;
          if (!calDebitGroups[cid]) calDebitGroups[cid] = [];
          calDebitGroups[cid].push(t);
        });
    const calDiagDebit = Object.values(calDebitGroups).reduce((s, legs) => {
      const longLeg  = legs.find(l => l.cal_leg === 'long');
      const shortLeg = legs.find(l => l.cal_leg === 'short');
      const longEntry  = parseFloat(longLeg?.entry_price)  || 0;
      const shortEntry = parseFloat(shortLeg?.entry_price) || 0;
      const contracts  = (longLeg || shortLeg)?.contracts  || 1;
      return s + Math.max(0, longEntry - shortEntry) * contracts * 100;
    }, 0);

    const debit = standaloneDebit + calDiagDebit;

    // 4. Credit spreads — margin = (spread_width − credit) × contracts × 100
    const CREDIT_SPREAD_STRATS = new Set(['Bull Put Spread','Bear Call Spread']);
    const margin = open
      .filter(t => CREDIT_SPREAD_STRATS.has(t.strategy))
      .reduce((s, t) => {
        const ss = parseFloat(t.strike_sell) || 0;
        const sb = parseFloat(t.strike_buy)  || 0;
        const width = Math.abs(ss - sb);
        const credit = parseFloat(t.entry_price) || 0;
        return s + Math.max(0, width - credit) * (t.contracts || 1) * 100;
      }, 0);

    // 5. IC / IB chains — margin = max(put_width, call_width) − total_credit per chain
    // Group open IC/IB legs by chain ID, then compute margin per chain
    const icGroups = {};
    open.filter(t => (t.strategy === 'Iron Condor' || t.strategy === 'Iron Butterfly') && t.condor_chain_id)
        .forEach(t => {
          const cid = t.condor_chain_id;
          if (!icGroups[cid]) icGroups[cid] = [];
          icGroups[cid].push(t);
        });
    const ic = Object.values(icGroups).reduce((s, legs) => {
      const totalCredit = legs.reduce((c, t) => c + (parseFloat(t.entry_price) || 0), 0);
      const widths = legs.map(t => Math.abs((parseFloat(t.strike_sell)||0) - (parseFloat(t.strike_buy)||0)));
      const maxWidth = Math.max(...widths, 0);
      const ct = legs[0]?.contracts || 1;
      return s + Math.max(0, maxWidth - totalCredit) * ct * 100;
    }, 0);

    return {
      cspCapital:    csp,
      stockCapital:  stock,
      debitCapital:  debit,
      marginCapital: margin,
      icCapital:     ic,
      totalCapital:  csp + stock + debit + margin + ic,
    };
  }, [trades, lots]);

  // ── Capital Deployed per-ticker breakdown ─────────────────────────────────
  const capitalByTicker = useMemo(() => {
    const open = trades.filter(t => t.status === 'open');
    const CREDIT_STRATS_CAP2 = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'];
    const DEBIT_STRATS2 = new Set(['Long Call','Long Put','Bull Call Spread','Bear Put Spread',
                                    'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread']);
    const CREDIT_SPREAD2 = new Set(['Bull Put Spread','Bear Call Spread']);
    const openLots2 = (lots || []).filter(l => !l.close_date);
    const byTicker = {};
    const add = (ticker, component, amount, label) => {
      const t2 = (ticker||'').toUpperCase();
      if (!byTicker[t2]) byTicker[t2] = { total: 0, rows: [] };
      byTicker[t2].total += amount;
      if (amount > 0) byTicker[t2].rows.push({ label, amount });
    };
    // Stock lots net cost
    openLots2.forEach(l => {
      const rawCost = (parseFloat(l.avg_cost)||0)*(parseFloat(l.shares)||0);
      const lotTrades = trades.filter(t => t.lot_id === l.id);
      const premiums = lotTrades.reduce((ps,t) => {
        const entry=t.entry_price||0, exit=t.exit_price||0, closed=t.status==='closed';
        const isCredit=CREDIT_STRATS_CAP2.includes(t.strategy);
        const isCSPAssign=closed&&t.strategy==='Cash-Secured Put'&&
          (parseFloat(t.exit_price)===parseFloat(t.entry_price)||(t.strike_buy!=null&&parseFloat(t.exit_price)===parseFloat(t.strike_buy)));
        const effExit=isCSPAssign?0:exit;
        return ps+(isCredit?(entry-(closed?effExit:0))*t.contracts*100:((closed?effExit:0)-entry)*t.contracts*100);
      },0);
      const net=Math.max(0,rawCost-premiums);
      add(l.ticker,'stock',net,`${l.shares}sh net cost (after premiums)`);
    });
    // CSPs
    open.filter(t=>t.strategy==='Cash-Secured Put').forEach(t=>{
      const cap=(parseFloat(t.strike_buy)||0)*(t.contracts||1)*100;
      add(t.ticker,'csp',cap,`CSP $${t.strike_buy} ×${t.contracts||1} reserved`);
    });
    // Debit strategies
    open.filter(t=>DEBIT_STRATS2.has(t.strategy)).forEach(t=>{
      const cap=(parseFloat(t.entry_price)||0)*(t.contracts||1)*100;
      const s=t.strategy.replace('Long Call','LC').replace('Long Put','LP')
        .replace('Bull Call Spread','BCS').replace('Bear Put Spread','BPS')
        .replace('Long Straddle','Straddle').replace('Long Strangle','Strangle')
        .replace('Calendar Spread','Cal').replace('Diagonal Spread','Diagonal');
      const strike=t.strike_sell||t.strike_buy;
      add(t.ticker,'debit',cap,`${s}${strike?' $'+strike:''} debit ×${t.contracts||1}`);
    });
    // Credit spread margin
    open.filter(t=>CREDIT_SPREAD2.has(t.strategy)).forEach(t=>{
      const ss=parseFloat(t.strike_sell)||0,sb=parseFloat(t.strike_buy)||0;
      const cap=Math.max(0,Math.abs(ss-sb)-(parseFloat(t.entry_price)||0))*(t.contracts||1)*100;
      const s=t.strategy==='Bull Put Spread'?'BPS':'BCS';
      add(t.ticker,'margin',cap,`${s} $${ss}/$${sb} margin ×${t.contracts||1}`);
    });
    // IC/IB margin
    const icG={};
    open.filter(t=>(t.strategy==='Iron Condor'||t.strategy==='Iron Butterfly')&&t.condor_chain_id)
        .forEach(t=>{const cid=t.condor_chain_id;if(!icG[cid])icG[cid]=[];icG[cid].push(t);});
    Object.values(icG).forEach(legs=>{
      const tc=legs.reduce((c,t)=>c+(parseFloat(t.entry_price)||0),0);
      const mw=Math.max(...legs.map(t=>Math.abs((parseFloat(t.strike_sell)||0)-(parseFloat(t.strike_buy)||0))),0);
      const cap=Math.max(0,mw-tc)*(legs[0]?.contracts||1)*100;
      const strat=legs[0]?.strategy==='Iron Butterfly'?'IB':'IC';
      add(legs[0]?.ticker,'ic',cap,`${strat} chain margin ×${legs[0]?.contracts||1}`);
    });
    // Sort by total descending
    return Object.entries(byTicker)
      .map(([ticker,d])=>({ticker,total:d.total,pct:totalCapital>0?d.total/totalCapital*100:0,rows:d.rows}))
      .filter(d=>d.total>0)
      .sort((a,b)=>b.total-a.total);
  }, [trades, lots, totalCapital]);

  // ── Gross Premium drilldown — open credit premium by ticker ──────────────
  // Used for the "▼ By ticker" toggle on the Gross Premium Collected tile.
  // Shows only OPEN positions grouped by ticker, with strategy sub-rows.
  // Answers: "which names are carrying the most premium risk right now?"
  const grossByTicker = useMemo(() => {
    const CREDIT_SET2 = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread',
                                  'Bear Call Spread','Iron Condor','Iron Butterfly']);
    const STRAT_SHORT = {
      'Covered Call':    'CC',
      'Cash-Secured Put':'CSP',
      'Bull Put Spread': 'BPS',
      'Bear Call Spread':'BCS',
      'Iron Condor':     'IC',
      'Iron Butterfly':  'IB',
    };
    const byTicker = {};
    // Include ALL trades (open + closed) — matches allCreditPremium one-way accumulator.
    // Closed IC legs must stay visible; the drilldown must always sum to the headline tile.
    // Use t.contracts (original full count) for both open and closed trades.
    trades.forEach(t => {
      const entry     = parseFloat(t.entry_price) || 0;
      const contracts = t.contracts || 1;  // always original count — matches allCreditPremium
      // Calendar/Diagonal: only short legs are credits — mirror allCreditPremium logic exactly
      if (t.strategy === 'Calendar Spread' || t.strategy === 'Diagonal Spread') {
        if (t.cal_leg !== 'short') return;
      } else if (!CREDIT_SET2.has(t.strategy)) {
        return;
      }
      const amount    = Math.round(entry * contracts * 100 * 100) / 100;
      const ticker    = (t.ticker || '').toUpperCase();
      const strat     = t.cal_leg === 'short'
        ? (t.strategy === 'Diagonal Spread' ? 'Diag Short' : 'Cal Short')
        : (STRAT_SHORT[t.strategy] || t.strategy);
      const strike    = t.strike_sell || t.strike_buy;
      const isClosed  = t.status === 'closed';
      const label     = `${strat}${strike ? ' $' + strike : ''} ×${contracts}${isClosed ? ' ✓' : ''}`;
      if (!byTicker[ticker]) byTicker[ticker] = { amount: 0, openCount: 0, closedCount: 0, rows: [] };
      byTicker[ticker].amount += amount;
      if (isClosed) byTicker[ticker].closedCount += 1;
      else          byTicker[ticker].openCount   += 1;
      byTicker[ticker].rows.push({ label, amount, isClosed });
    });
    const total = Object.values(byTicker).reduce((s, d) => s + d.amount, 0);
    return Object.entries(byTicker)
      .map(([ticker, d]) => ({
        ticker,
        amount: d.amount,
        pct: total > 0 ? d.amount / total * 100 : 0,
        openCount:   d.openCount,
        closedCount: d.closedCount,
        rows: d.rows.sort((a, b) => b.amount - a.amount),
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker)); // A-Z by ticker
  }, [trades]);

  // ── Realised P&L drilldown ────────────────────────────────────────────────
  // Produces two buckets: Option Income + Share Gains.
  // Uses IDENTICAL logic to closedOptionSum + closedLotShareGain in the main
  // useMemo — so the rows are guaranteed to sum to exactly stats.totalPnl.
  const realisedBreakdown = useMemo(() => {
    const STRAT_SHORT = {
      'Covered Call':'CC','Cash-Secured Put':'CSP','Bull Put Spread':'BPS',
      'Bear Call Spread':'BCS','Iron Condor':'IC','Iron Butterfly':'IB',
      'Long Call':'LC','Long Put':'LP','Bull Call Spread':'BCLS',
      'Bear Put Spread':'BPutS','Long Straddle':'Straddle','Long Strangle':'Strangle',
      'Calendar Spread':'Cal','Diagonal Spread':'Diagonal',
    };

    // ── Bucket 1: Option income (closed trades, assignment/called-away corrected) ──
    const optionRows = [];
    closed.forEach(t => {
      let pnl = 0;
      if (t.pnl !== 0 && t.pnl != null) {
        pnl = t.pnl;
      } else {
        const entry      = parseFloat(t.entry_price) || 0;
        const exitP      = parseFloat(t.exit_price)  || 0;
        const strikeBuy  = parseFloat(t.strike_buy)  || 0;
        const strikeSell = parseFloat(t.strike_sell) || 0;
        const c          = t.contracts || 1;
        const isCSPAssign = t.strategy === 'Cash-Secured Put' &&
          (exitP === entry || (strikeBuy > 0 && exitP === strikeBuy));
        const isCCCalledAway = t.strategy === 'Covered Call' &&
          strikeSell > 0 && Math.abs(exitP - strikeSell) < 0.01;
        if (isCSPAssign) {
          pnl = Math.round(entry * c * 100);
        } else if (isCCCalledAway) {
          pnl = Math.round(entry * c * 100);
        } else {
          return; // pnl=0 for other reasons — skip
        }
      }
      const ticker  = (t.ticker || '').toUpperCase();
      const strat   = STRAT_SHORT[t.strategy] || t.strategy;
      const strike  = t.strike_sell || t.strike_buy;
      const entry   = parseFloat(t.entry_price) || 0;
      const exitP   = parseFloat(t.exit_price)  || 0;
      const strikeBuy  = parseFloat(t.strike_buy)  || 0;
      const strikeSell = parseFloat(t.strike_sell) || 0;
      const c          = t.contracts || 1;
      const isCSPAssign2 = t.strategy === 'Cash-Secured Put' &&
        (exitP === entry || (strikeBuy > 0 && exitP === strikeBuy));
      const isCCCalledAway2 = t.strategy === 'Covered Call' &&
        strikeSell > 0 && Math.abs(exitP - strikeSell) < 0.01;
      const tag = isCSPAssign2 ? ' (assigned)' : isCCCalledAway2 ? ' (called away)' : '';
      optionRows.push({
        ticker,
        label: `${strat}${strike ? ' $' + strike : ''}${tag} ×${c}`,
        pnl,
        date: t.exit_date || t.entry_date || '',
      });
    });

    // Partial closes on open IC/Cal chain legs — reduce_position leaves leg status='open'
    // but realised cash sits in partial_close_pnl. Must include so drilldown ties to tile.
    trades.forEach(t => {
      if (t.status !== 'open') return;
      if (!t.condor_chain_id && t.cal_chain_id == null) return;
      const partial = t.partial_close_pnl || 0;
      if (partial === 0) return;
      const ticker = (t.ticker || '').toUpperCase();
      const strat  = STRAT_SHORT[t.strategy] || t.strategy;
      const strike = t.strike_sell || t.strike_buy;
      optionRows.push({
        ticker,
        label: `${strat}${strike ? ' $' + strike : ''} (partial) ×${t.contracts_closed || '?'}`,
        pnl: partial,
        date: t.entry_date || '',
      });
    });

    // ── Bucket 2: Share gains (closed lots, same double-count guard as closedLotShareGain) ──
    const shareRows = [];
    (lots || []).filter(l => l.close_date && l.close_price != null).forEach(l => {
      const calledAwayCC = closed.find(t =>
        t.lot_id === l.id && t.strategy === 'Covered Call' &&
        t.pnl != null && t.pnl !== 0 &&
        Math.abs(parseFloat(t.exit_price) - parseFloat(l.close_price)) < 0.01
      );
      if (calledAwayCC) {
        // Only skip if pnl already includes share gain (manual workflow).
        // Import workflow stores premium-only pnl → share gain must be added separately.
        const premiumOnly = Math.round((parseFloat(calledAwayCC.entry_price) || 0) * (calledAwayCC.contracts || 1) * 100);
        if (calledAwayCC.pnl > premiumOnly * 1.5) return; // combined pnl → skip
        // else premium-only → fall through and add share gain
      }
      const gain = Math.round((parseFloat(l.close_price) - parseFloat(l.avg_cost)) * parseFloat(l.shares));
      if (isNaN(gain)) return;
      shareRows.push({
        ticker: (l.ticker || '').toUpperCase(),
        label: `${l.shares}sh @ $${l.avg_cost} → $${l.close_price}`,
        pnl: gain,
        date: l.close_date || '',
      });
    });

    // Sort by ticker A-Z
    const byTickerSort = (a, b) => (a.ticker || '').localeCompare(b.ticker || '');
    optionRows.sort(byTickerSort);
    shareRows.sort(byTickerSort);

    // Aggregate flat rows into per-ticker groups for accordion render
    const groupByTicker = (rows) => {
      const map = {};
      rows.forEach(r => {
        if (!map[r.ticker]) map[r.ticker] = { ticker: r.ticker, pnl: 0, trades: [] };
        map[r.ticker].pnl += r.pnl;
        map[r.ticker].trades.push(r);
      });
      return Object.values(map).sort((a, b) => (a.ticker || '').localeCompare(b.ticker || ''));
    };

    const optionGroups = groupByTicker(optionRows);
    const shareGroups  = groupByTicker(shareRows);

    const optionTotal = optionRows.reduce((s, r) => s + r.pnl, 0);
    const shareTotal  = shareRows.reduce((s, r) => s + r.pnl, 0);
    const grandTotal  = optionTotal + shareTotal;

    return { optionRows, shareRows, optionGroups, shareGroups, optionTotal, shareTotal, grandTotal };
  }, [closed, lots, trades]);


  // Was: totalPnlToday - closedPnl = openCreditPremium (WRONG — showed cash collected, not MtM)
  // Now: closeOutOptionPnl — actual buy-back cost net vs entry (matches headline closeOutPnl)
  const openTheo        = closeOutOptionPnl;
  const hasAnyPrices    = openPriced > 0 || estimatedCount > 0;
  const hasStockPrices  = stockPricedCount > 0;
    const ictColor        = totalPnlToday >= 0 ? '#1a7a4a' : '#c0392b';

  const byStrategy = useMemo(() => {
    const map = {};
    // All closed trades including IC/IB and Calendar chain legs
    // so the bars sum exactly to the Realised P&L tile
    const allClosed = trades.filter(t => t.status === 'closed' && t.pnl !== null);
    allClosed.forEach(t => {
      if (!map[t.strategy]) map[t.strategy] = 0;
      map[t.strategy] += t.pnl;
    });
    return Object.entries(map)
      .map(([strategy, pnl]) => ({ strategy, pnl }))
      .sort((a, b) => b.pnl - a.pnl);
  }, [trades]);

  // Monthly income bar chart — last 12 calendar months
  const monthlyData = useMemo(() => {
    const map = {};
    closed.forEach(t => {
      if (!t.exit_date) return;
      const key = t.exit_date.slice(0, 7); // YYYY-MM
      map[key] = (map[key] || 0) + (t.pnl || 0);
    });
    // Build last 12 months whether or not there are trades
    const result = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
      result.push({ month: label, pnl: map[key] || 0, key });
    }
    // Only show if there is at least one non-zero month
    return result.some(r => r.pnl !== 0) ? result : [];
  }, [closed]);

  const finalPnl   = cumulativeData.length ? cumulativeData[cumulativeData.length-1].cumulative : 0;
  const isProfit   = finalPnl >= 0;
  const pnlColor   = isProfit ? '#1a7a4a' : '#c0392b';
  
  if (!trades.length) {
    return (
      <div>
        <div className="page-header">
          <div className="page-header-left"><h2>Analytics</h2>{pill}</div>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">📈</div>
          <h3>No trades yet</h3>
          <p>Log your first trade to see your performance analytics.</p>
          <div className="empty-state-actions">
            <button className="btn btn-primary" onClick={onAddTrade}>+ Log First Trade</button>
          </div>
        </div>
      </div>
    );
  }

  const statCards = [
    // ── Row 1: Gross Premium first (largest view) → Realised (closed only) → quality metrics ──
    { label: 'Gross Premium Collected', isGross: true, value: totalPnlToday >= 0 ? '+' + fmtD(totalPnlToday) : fmtD(totalPnlToday), color: ictColor, badge: openCreditPremium > 0 ? `+${fmt(openCreditPremium)} on open positions` : 'All premiums settled', badgeBg: 'var(--bg)',
      tooltip: 'Gross premium ever credited to your account from selling options — the entry price of every credit trade ever opened (Covered Calls, CSPs, spreads, IC legs), whether still open or already closed. Plus share gains on closed lots.\n\nThis is a one-way accumulator — it never goes down. Closing early at a loss does not reduce it; that loss appears in Realised P&L instead.\n\nThink of it as the ceiling: the maximum you could have kept if every credit position had expired worthless. Realised P&L shows what you have actually kept. Close-Out P&L shows what you would walk away with today.' },

    { label: 'Win Rate',      value: stats.winRate.toFixed(1) + '%', color: stats.winRate >= 50 ? '#1a7a4a' : '#c0392b', badge: `${stats.closedTrades} closed`, badgeBg: 'var(--bg)',
      tooltip: `% of closed single-leg trades that were profitable. IC and Calendar chain legs are excluded — those are multi-leg trades tracked at chain level in Trade Log. Assignments and called-away events (P&L = $0 by convention) are included in the denominator as neutral outcomes — keeping this metric conservative.`,
      streak: stats.streak > 1 ? `${stats.streak} ${stats.streakType} streak` : null,
      streakColor: stats.streakType === 'win' ? '#1a7a4a' : '#c0392b' },
    { label: 'Profit Factor', value: stats.profitFactor > 99 ? '∞' : stats.profitFactor.toFixed(2), color: '#1a5fa8', badge: 'Win ÷ loss $', badgeBg: 'var(--blue-bg)',
      tooltip: 'Average winning trade $ ÷ average losing trade $. Above 1.5 is solid; above 2.0 is excellent. Excludes IC and Calendar chain legs (multi-leg trades tracked at chain level). Zero-P&L assignments and called-away events are excluded from both numerator and denominator.' },
    { label: 'Wheel Positions',    value: stats.wheelTrades,     color: '#1a7a4a', badge: 'Shares + active option', badgeBg: 'var(--green-bg)', onClick: () => onGoToTrades?.(bucketTickers?.wheelSet),
      tooltip: 'Open lots with an active CC or CSP written against them. Click to manage in Trade Log.' },
    { label: 'Unhedged Shares',    value: stats.unhedgedLots,    color: '#b7730a', badge: stats.unhedgedLots > 0 ? 'Write a CC →' : 'All lots covered', badgeBg: 'var(--amber-bg)', onClick: () => onGoToPositions?.(),
      tooltip: 'Lots with no active option written against them — capital not working. Click to go to Stock Positions and write a covered call on each unhedged lot.' },
    { label: 'Standalone Trades',  value: stats.standaloneTrades, color: '#1a5fa8', badge: 'No share ownership', badgeBg: 'var(--blue-bg)', onClick: () => onGoToTrades?.(bucketTickers?.standaloneSet),
      tooltip: 'Open positions with no share lot: CSPs not yet assigned, credit and debit spreads (Bull Put, Bear Call, Bull Call, Bear Put), long options, straddles, strangles, diagonals, and IC/Calendar chains (each chain counted as 1 position). Click to filter Trade Log to these tickers.' },
  ];

  const statCardsBottom = [
    { label: 'Realised P&L',  value: fmtD(realisedBreakdown.grandTotal),  color: realisedBreakdown.grandTotal >= 0 ? '#1a7a4a' : '#c0392b', badge: realisedBreakdown.grandTotal >= 0 ? '▲ Closed positions' : '▼ Net Loss', badgeBg: realisedBreakdown.grandTotal >= 0 ? 'var(--green-bg)' : 'var(--red-bg)',
      isRealised: true,
      tooltip: 'Settled cash from closed positions only — option P&L, assignment premiums (CSPs), called-away CC premiums, and share gains/losses when lots were sold. Open positions not included. The difference between this and Gross Premium Collected is the premium sitting in your account on positions still running.' },
    { label: 'Capital Deployed', value: fmt(totalCapital), color: '#1a5fa8', badge: totalCapital > 0 ? `${fmt(stockCapital)} stock · ${fmt(cspCapital)} CSP` : 'No open positions', badgeBg: 'var(--blue-bg)', isCapital: true,
      tooltip: `Total capital still at risk across all open positions:\n• Stock lots (net): ${fmt(stockCapital)} — purchase cost minus all wheel premiums collected so far. This is the real capital still working in your shares.\n• CSP reserved: ${fmt(cspCapital)} — strike × contracts × 100 held for potential assignment.\n• Debit strategies: ${fmt(debitCapital)} — premium paid for Long Calls/Puts, spreads, straddles; net debit (long − short leg) for Calendar and Diagonal chains.\n• Credit spread margin: ${fmt(marginCapital)} — (spread width − credit) × contracts × 100.\n• IC/IB margin: ${fmt(icCapital)} — max spread width − total credit (broker margins wider side only).\nCovered Calls not counted separately — shares already in stock capital.` },
    { label: 'Best Trade',  value: fmt(stats.bestTrade),  color: '#1a7a4a', badge: 'All time', badgeBg: 'var(--green-bg)',
      tooltip: 'Largest single outcome across all closed trades and chains — including IC chains, Iron Butterfly chains and Calendar chains (summed across all legs). This is your true best result regardless of strategy structure.' },
    { label: 'Worst Trade', value: fmt(stats.worstTrade), color: '#c0392b', badge: 'All time', badgeBg: 'var(--red-bg)',
      tooltip: 'Largest single loss across all closed trades and chains — including IC chains, Iron Butterfly chains and Calendar chains (summed across all legs). This is your true worst result. Use it to evaluate position sizing — your biggest loss tells you how well your risk management held.' },
  ];

  const tileStyle = {
    padding: '10px 12px',
  };
  const tileValueStyle = {
    fontSize: 18,
    fontWeight: 800,
    fontFamily: 'var(--font-mono)',
    lineHeight: 1.1,
    marginBottom: 4,
  };
  const tileLabelStyle = {
    fontSize: 10,
    color: 'var(--text-muted)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    marginBottom: 4,
  };
  const tileBadgeStyle = {
    fontSize: 9.5,
    padding: '1px 6px',
    borderRadius: 10,
    display: 'inline-block',
    fontWeight: 600,
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <h2>Analytics</h2>
          {pill}
          <div className="subtitle">Your options trading performance at a glance</div>
        </div>
      </div>

      {/* ── IF CLOSED TODAY — Hero tile ─────────────────────── */}
      <div style={{
        background: closeOutPnl >= 0
          ? 'linear-gradient(135deg, #1B3A5C 0%, #1a7a4a 100%)'
          : 'linear-gradient(135deg, #1B3A5C 0%, #c0392b 100%)',
        borderRadius: 12,
        padding: '20px 28px',
        marginBottom: 16,
        color: '#fff',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 24,
        cursor: 'default',
        boxShadow: '0 4px 16px rgba(0,0,0,0.15)',
      }}>

        {/* Left: the number */}
        <div>
          <div
            title="Mark-to-market portfolio value if you closed everything right now: settled P&L from closed trades + buy-back cost of all open options + unrealised stock gain/loss. Requires current prices — use ⟳ Refresh Prices or enter Stock $ / Opt $ in Trade Log."
            style={{ fontSize: 13, fontWeight: 800, letterSpacing: '0.04em', opacity: 0.95, marginBottom: 8, textTransform: 'uppercase', cursor: 'default', display: 'inline-block', borderBottom: '1px dashed rgba(255,255,255,0.35)' }}>
            Close-Out P&L
          </div>
          <div style={{ fontSize: 42, fontWeight: 800, fontFamily: 'monospace', lineHeight: 1, letterSpacing: '-0.02em' }}>
            {closeOutPnl >= 0 ? '+' : ''}{fmt(closeOutPnl)}
          </div>
          <div style={{ fontSize: 12, opacity: 0.75, marginTop: 6, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <span title="All realised cash: closed option P&amp;L + assignment premiums + called-away premiums + closed lot share gains">Realised: {realisedBreakdown.grandTotal >= 0 ? '+' : ''}{fmt(realisedBreakdown.grandTotal)}</span>
            {hasAnyPrices ? (
              <span>
                Options net: {openTheo >= 0 ? '+' : ''}{fmt(openTheo)}
                <span style={{ marginLeft: 6, opacity: 0.8 }}>
                  ({wheelCount} wheel · {standaloneCount + openIcChains + openCalChains} standalone
                  {estimatedCount > 0 && <span style={{ color: '#fcd34d' }}> · {estimatedCount} est.</span>}
                  )
                {missingPrices.length > 0 && (
                  <div style={{ color: '#f87171', fontSize: 11, marginTop: 3, fontWeight: 600 }}>
                    Enter option prices manually in Trade Log for: {missingPrices.join(', ')}
                  </div>
                )}
                </span>
              </span>
            ) : (
              <span style={{ opacity: 0.7 }}>
                {yahooStatus?.status === 'loading'
                  ? '⏳ Fetching prices…'
                  : onFetchYahoo
                    ? <span>Click <strong>⟳ Refresh Prices</strong> → for Yahoo Finance quotes, or enter <strong>Stock $</strong> / <strong>Opt $</strong> manually in Trade Log</span>
                    : <span>Enter <strong>Stock $</strong> and <strong>Opt $</strong> in Trade Log to see close-out value</span>
                }
              </span>
            )}
            {hasStockPrices && (
              <span>
                Stock: {stockUnrealisedPnl >= 0 ? '+' : ''}{fmt(stockUnrealisedPnl)}
                <span style={{ marginLeft: 4, opacity: 0.7 }}>({stockPricedCount} lot{stockPricedCount !== 1 ? 's' : ''})</span>
              </span>
            )}
            {(hasAnyPrices || hasStockPrices) && (
              <button
                onClick={e => { e.stopPropagation(); setShowCloseOutDetail(v => !v); }}
                style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)',
                  color: '#fff', borderRadius: 4, padding: '2px 8px', fontSize: 10.5, cursor: 'pointer',
                  fontWeight: 600, letterSpacing: '0.02em', marginLeft: 4 }}
              >
                {showCloseOutDetail ? '▲ Hide details' : '▼ See details'}
              </button>
            )}
          </div>

          {/* ── Collapsible close-out breakdown ───────────── */}
          {showCloseOutDetail && (hasAnyPrices || hasStockPrices) && (() => {
            const CREDIT_SET2 = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly']);
            const openStandalone = trades.filter(t => t.status === 'open' && !t.condor_chain_id && t.cal_chain_id == null);
            const openLots2 = (lots || []).filter(l => !l.close_date);
            const STRAT_SHORT2 = s => s.replace('Covered Call','CC').replace('Cash-Secured Put','CSP')
              .replace('Bear Call Spread','BCS').replace('Bull Put Spread','BPS')
              .replace('Bull Call Spread','BCS').replace('Bear Put Spread','BPS')
              .replace('Long Call','LC').replace('Long Put','LP')
              .replace('Long Straddle','Straddle').replace('Long Strangle','Strangle')
              .replace('Iron Condor','IC').replace('Iron Butterfly','IB')
              .replace('Diagonal Spread','Diagonal').replace('Calendar Spread','Cal');

            // Per-position option rows — standalone trades
            const optRows = [];
            openStandalone.forEach(t => {
              const op = parseFloat(currentPrices?.[t.id]?.option);
              const entry = parseFloat(t.entry_price) || 0;
              const c = t.contracts || 1;
              const isBsEst = currentPrices?.[t.id]?.isBsEst;
              let pnl = null;
              if (!isNaN(op) && op >= 0) {
                pnl = CREDIT_SET2.has(t.strategy)
                  ? (entry - op) * c * 100
                  : (op - entry) * c * 100;
              }
              if (pnl == null) return;
              const strike = t.strike_sell || t.strike_buy;
              const label = `${t.ticker} ${STRAT_SHORT2(t.strategy)}${strike ? ' $'+strike : ''}${c > 1 ? ' ×'+c : ''}`;
              optRows.push({ label, pnl, isBsEst });
            });

            // IC / IB chain rows — one row per chain (sum of leg P&Ls)
            const icGroups2 = {};
            trades.filter(t => t.status === 'open' && (t.strategy === 'Iron Condor' || t.strategy === 'Iron Butterfly') && t.condor_chain_id)
              .forEach(t => { const cid = t.condor_chain_id; if (!icGroups2[cid]) icGroups2[cid] = []; icGroups2[cid].push(t); });
            Object.entries(icGroups2).forEach(([cid, legs]) => {
              const ticker = legs[0]?.ticker?.toUpperCase();
              const strat  = legs[0]?.strategy || 'Iron Condor';
              const stockPrice = parseFloat(currentPrices?.[ticker]?.stock ||
                Object.values(currentPrices || {}).find(p => p?.ticker === ticker)?.stock);
              if (!stockPrice) return;
              let chainPnl = 0; let anyPriced = false;
              legs.forEach(leg => {
                const entry = parseFloat(leg.entry_price) || 0;
                const c = leg.contracts || 1;
                const op = parseFloat(currentPrices?.[leg.id]?.option);
                if (!isNaN(op) && op >= 0) {
                  chainPnl += (entry - op) * c * 100; anyPriced = true;
                } else {
                  const ivPct = currentPrices?.[leg.id]?.iv != null ? currentPrices[leg.id].iv : (leg.iv_entry || 15);
                  const iv = ivPct ? ivPct / 100 : null;
                  const kS = parseFloat(leg.strike_sell) || 0;
                  const kB = parseFloat(leg.strike_buy)  || 0;
                  const expD = leg.expiration ? new Date(leg.expiration) : null;
                  const T = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
                  if (iv && T > 0 && kS && kB) {
                    const isCall = (leg.condor_leg === 'call' || leg.condor_leg === 'full'); // 'full' = IB body leg, priced as call side
                    const bsSpread = Math.max(0, bsDashboard(stockPrice, kS, T, 0.053, iv, isCall) - bsDashboard(stockPrice, kB, T, 0.053, iv, isCall));
                    chainPnl += (entry - bsSpread) * c * 100; anyPriced = true;
                  }
                }
              });
              if (!anyPriced) return;
              const totalCredit = legs.reduce((s, l) => s + (parseFloat(l.entry_price) || 0), 0);
              const c = legs[0]?.contracts || 1;
              optRows.push({ label: `${ticker} ${STRAT_SHORT2(strat)} #${cid} $${totalCredit.toFixed(2)} ×${c}`, pnl: chainPnl, isBsEst: true });
            });

            // Cal / Diagonal chain rows — one row per chain
            const calGroups2 = {};
            trades.filter(t => t.status === 'open' && t.cal_chain_id)
              .forEach(t => { const cid = t.cal_chain_id; if (!calGroups2[cid]) calGroups2[cid] = []; calGroups2[cid].push(t); });
            Object.entries(calGroups2).forEach(([cid, legs]) => {
              const ticker = legs[0]?.ticker?.toUpperCase();
              const strat  = legs[0]?.strategy || 'Calendar Spread';
              const stockPrice = parseFloat(currentPrices?.[ticker]?.stock ||
                Object.values(currentPrices || {}).find(p => p?.ticker === ticker)?.stock);
              if (!stockPrice) return;
              let chainPnl = 0; let anyPriced = false;
              legs.forEach(leg => {
                const entry = parseFloat(leg.entry_price) || 0;
                const c = leg.contracts || 1;
                const isShort = leg.cal_leg === 'short';
                const op = parseFloat(currentPrices?.[leg.id]?.option);
                if (!isNaN(op) && op >= 0) {
                  chainPnl += isShort ? (entry - op) * c * 100 : (op - entry) * c * 100; anyPriced = true;
                } else {
                  const ivPct = currentPrices?.[leg.id]?.iv != null ? currentPrices[leg.id].iv : (leg.iv_entry || 15);
                  const iv = ivPct ? ivPct / 100 : null;
                  const k = parseFloat(leg.strike_sell || leg.strike_buy) || 0;
                  const expD = leg.expiration ? new Date(leg.expiration) : null;
                  const T = expD ? Math.max(0.001, (expD - new Date()) / (365 * 86400000)) : 0;
                  if (iv && T > 0 && k) {
                    const isCallOpt2 = leg.option_type !== 'put';
                    const bsOpt = bsDashboard(stockPrice, k, T, 0.053, iv, isCallOpt2);
                    if (bsOpt != null && bsOpt >= 0) {
                      chainPnl += isShort ? (entry - bsOpt) * c * 100 : (bsOpt - entry) * c * 100; anyPriced = true;
                    }
                  }
                }
              });
              if (!anyPriced) return;
              const shortLeg = legs.find(l => l.cal_leg === 'short');
              const strike = shortLeg?.strike_sell || legs[0]?.strike_buy;
              const c = legs[0]?.contracts || 1;
              optRows.push({ label: `${ticker} ${STRAT_SHORT2(strat)} #${cid}${strike ? ' $'+strike : ''} ×${c}`, pnl: chainPnl, isBsEst: true });
            });

            // Per-lot stock rows
            const stockRows = [];
            openLots2.forEach(lot => {
              const ticker = lot.ticker?.toUpperCase();
              const sp = parseFloat(currentPrices?.[ticker]?.stock);
              if (!sp) return;
              const cost = parseFloat(lot.avg_cost) || 0;
              const shares = parseFloat(lot.shares) || 0;
              const pnl = (sp - cost) * shares;
              stockRows.push({ label: `${ticker} ${shares}sh @ $${cost} → $${sp.toFixed(0)}`, pnl });
            });

            const divStyle = { height: 1, background: 'rgba(255,255,255,0.15)', margin: '10px 0' };
            const rowStyle = { display: 'flex', justifyContent: 'space-between', fontSize: 11.5, padding: '2px 0' };
            const pnlColor = (v) => v >= 0 ? '#6ee7b7' : '#fca5a5';

            return (
              <div style={{ marginTop: 10, background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '12px 16px', fontSize: 11.5 }} onClick={e => e.stopPropagation()}>
                {/* Realised */}
                <div style={rowStyle}>
                  <span style={{ opacity: 0.75 }}>Settled cash (closed trades)</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(closedPnl), fontWeight: 600 }}>{stats.totalPnl >= 0 ? '+' : ''}{fmt(stats.totalPnl)}</span>
                </div>

                {/* Options section */}
                {optRows.length > 0 && (<>
                  <div style={divStyle} />
                  <div style={{ opacity: 0.6, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>If you closed all options now</div>
                  {optRows.map((r, i) => (
                    <div key={i} style={rowStyle}>
                      <span style={{ opacity: 0.85 }}>{r.label}{r.isBsEst && <span style={{ color: '#fcd34d', marginLeft: 4, fontSize: 9 }}>est.</span>}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(r.pnl) }}>{r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}</span>
                    </div>
                  ))}
                  <div style={{ ...rowStyle, borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 4, paddingTop: 4, fontWeight: 700 }}>
                    <span>Options net</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(openTheo) }}>{openTheo >= 0 ? '+' : ''}{fmt(openTheo)}</span>
                  </div>
                </>)}

                {/* Stock section */}
                {stockRows.length > 0 && (<>
                  <div style={divStyle} />
                  <div style={{ opacity: 0.6, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>If you sold all shares now</div>
                  {stockRows.map((r, i) => (
                    <div key={i} style={rowStyle}>
                      <span style={{ opacity: 0.85 }}>{r.label}</span>
                      <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(r.pnl) }}>{r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}</span>
                    </div>
                  ))}
                  <div style={{ ...rowStyle, borderTop: '1px solid rgba(255,255,255,0.1)', marginTop: 4, paddingTop: 4, fontWeight: 700 }}>
                    <span>Stock net ({stockPricedCount} lots)</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(stockUnrealisedPnl) }}>{stockUnrealisedPnl >= 0 ? '+' : ''}{fmt(stockUnrealisedPnl)}</span>
                  </div>
                </>)}

                {/* Total */}
                <div style={{ ...divStyle, background: 'rgba(255,255,255,0.25)' }} />
                <div style={{ ...rowStyle, fontWeight: 800, fontSize: 13 }}>
                  <span>Close-Out P&L</span>
                  <span style={{ fontFamily: 'var(--font-mono)', color: pnlColor(closeOutPnl) }}>{closeOutPnl >= 0 ? '+' : ''}{fmt(closeOutPnl)}</span>
                </div>
                <div style={{ fontSize: 10, opacity: 0.5, marginTop: 6, fontStyle: 'italic' }}>
                  Assumes all positions closed at current market prices simultaneously.
                </div>
              </div>
            );
          })()}
        </div>

        {/* Right: missing prices warning or live badge */}
        <div style={{ textAlign: 'right', flexShrink: 0 }}>
          {(() => {
            const isBrokerLive    = liveStatus?.status === 'green';
            const isBrokerLoading = liveStatus?.status === 'blue';
            const sourceName = isBrokerLive || isBrokerLoading
              ? (liveStatus.label || 'Broker')
              : (yahooStatus?.message?.includes('MarketData') ? 'MarketData.app' : 'Yahoo Finance');

            // Broker connected — fully auto
            if (isBrokerLive) {
              return (
                <div style={{ background: 'rgba(255,255,255,0.18)', borderRadius: 8, padding: '8px 14px', fontSize: 11.5 }}>
                  <div style={{ fontWeight: 700 }}>✓ Live — {sourceName}</div>
                  <div style={{ opacity: 0.75, marginTop: 3 }}>
                    {openPriced} option{openPriced!==1?'s':''} priced
                    {estimatedCount > 0 ? ` · ${estimatedCount} BS est.` : ''}
                    {hasStockPrices ? ` · ${stockPricedCount} stock lot${stockPricedCount!==1?'s':''}` : ''}
                  </div>
                </div>
              );
            }

            // Broker loading
            if (isBrokerLoading) {
              return (
                <div style={{ background: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 14px', fontSize: 11.5 }}>
                  <div style={{ fontWeight: 700 }}>⏳ Fetching from {sourceName}…</div>
                </div>
              );
            }

            // No broker — Yahoo/MarketData path
            if (missingPrices.length > 0 && hasAnyPrices) {
              return (
                <div style={{ background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 14px', fontSize: 11.5, maxWidth: 240 }}>
                  <div style={{ fontWeight: 700, marginBottom: 3 }}>⚠ Partial prices — {sourceName}</div>
                  <div style={{ opacity: 0.85, marginBottom: 6 }}>{missingPrices.join(', ')} — not priced</div>
                  <div style={{ opacity: 0.75, fontSize: 11 }}>
                    Close-Out P&L is incomplete. Go to Trade Log and enter Stock $, Opt $ and IV for these tickers.
                  </div>
                </div>
              );
            }

            if (!hasAnyPrices) {
              return (
                <div style={{ background: 'rgba(255,255,255,0.12)', borderRadius: 8, padding: '8px 14px', fontSize: 11.5, maxWidth: 220, textAlign: 'right' }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {yahooStatus?.status === 'loading' ? `⏳ Fetching via ${sourceName}…` : 'Prices not loaded'}
                  </div>
                  <div style={{ opacity: 0.75, marginBottom: 10, fontSize: 11 }}>
                    {yahooStatus?.status === 'loading'
                      ? (yahooStatus.message || `Fetching from ${sourceName}…`)
                      : yahooStatus?.status === 'failed'
                        ? `${sourceName} unavailable. Enter prices manually in Trade Log for Theo P&L and Close-Out P&L.`
                        : `Close-Out P&L needs current prices. Click ⟳ to fetch via ${sourceName}, or enter Stock $, Opt $ and IV in Trade Log.`}
                  </div>
                  {onFetchYahoo && yahooStatus?.status !== 'loading' && (
                    <button
                      onClick={e => { e.stopPropagation(); onFetchYahoo(); }}
                      style={{ background: 'rgba(255,255,255,0.25)', border: '1px solid rgba(255,255,255,0.5)',
                        color: '#fff', borderRadius: 5, padding: '6px 14px', fontSize: 12, cursor: 'pointer',
                        fontWeight: 700, letterSpacing: '0.02em' }}
                    >
                      ⟳ Refresh Prices
                    </button>
                  )}
                </div>
              );
            }

            // All prices loaded
            return (
              <div style={{ background: 'rgba(255,255,255,0.18)', borderRadius: 8, padding: '8px 14px', fontSize: 11.5 }}>
                <div style={{ fontWeight: 700 }}>✓ Prices loaded · {openTotal} positions</div>
                <div style={{ opacity: 0.75, marginTop: 3 }}>
                  {openPriced} option{openPriced!==1?'s':''} priced
                  {estimatedCount > 0 ? ` · ${estimatedCount} BS est.` : ''}
                  {hasStockPrices ? ` · ${stockPricedCount} stock lot${stockPricedCount!==1?'s':''}` : ''}
                </div>
              </div>
            );
          })()}

          {/* Price source footer */}
          <div style={{ fontSize: 10.5, opacity: 0.55, marginTop: 8 }}>
            {(() => {
              const isBrokerLive = liveStatus?.status === 'green';
              if (isBrokerLive) return `Live via ${liveStatus.label} · updates every 30s · Click to view open trades`;
              if (pricesUpdatedAt) {
                const mins = Math.round((Date.now() - pricesUpdatedAt.getTime()) / 60000);
                const src  = yahooStatus?.message?.includes('MarketData') ? 'MarketData.app' : 'Yahoo Finance';
                return `Prices from ${src} · ${mins < 1 ? 'just now' : `${mins} min ago`} · Click to view open trades`;
              }
              const ys = yahooStatus || {};
              if (ys.status === 'idle' || !ys.status) return 'No prices — click ⟳ Refresh in Trade Log or connect a broker · Click to view open trades';
              if (ys.status === 'loading') return 'Fetching prices… · Click to view open trades';
              return 'Click to view open trades';
            })()}
          </div>
        </div>
      </div>

      {/* ── Stat cards — 6 top + 4 bottom ──────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 10 }}>
        {statCards.map((c, i) => (
          c.isGross ? (
            <div key={i} className="stat-card" style={tileStyle} title={c.tooltip}>
              <div style={tileLabelStyle}>{c.label}</div>
              <div style={{ ...tileValueStyle, color: c.color }}>{c.value}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ ...tileBadgeStyle, background: c.badgeBg, color: c.color }}>{c.badge}</div>
                {grossByTicker.length > 0 && (
                  <button
                    onClick={() => setShowGrossDetail(v => !v)}
                    style={{ background: 'var(--green-bg)', border: '1px solid var(--green)', color: '#1a7a4a',
                      borderRadius: 4, padding: '1px 7px', fontSize: 9.5, cursor: 'pointer', fontWeight: 700 }}
                  >
                    {showGrossDetail ? '▲ Hide' : '▼ By ticker'}
                  </button>
                )}
              </div>
              {showGrossDetail && grossByTicker.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {grossByTicker.map((d, di) => {
                    const isExp = !!grossExpanded[di];
                    const tradeCount = d.openCount + d.closedCount;
                    const badgeBg  = d.openCount > 0 ? 'var(--green-bg)'  : 'var(--bg-muted, #f0f0f0)';
                    const badgeClr = d.openCount > 0 ? '#1a7a4a'          : 'var(--text-muted)';
                    const badgeTxt = d.openCount > 0 ? `${d.openCount} open` : 'closed';
                    return (
                      <div key={di}>
                        {/* Ticker header row — clickable */}
                        <div
                          onClick={() => setGrossExpanded(prev => ({ ...prev, [di]: !prev[di] }))}
                          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '4px 4px', borderRadius: 4, cursor: 'pointer',
                            background: isExp ? 'var(--green-bg)' : 'transparent' }}
                          onMouseEnter={e => { if (!isExp) e.currentTarget.style.background = 'var(--bg-hover, #f5f5f5)'; }}
                          onMouseLeave={e => { e.currentTarget.style.background = isExp ? 'var(--green-bg)' : 'transparent'; }}
                        >
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block',
                              transform: isExp ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>▶</span>
                            <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>{d.ticker}</span>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{tradeCount} trade{tradeCount !== 1 ? 's' : ''}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                            <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#1a7a4a' }}>{fmt(d.amount)}</span>
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, fontWeight: 600,
                              background: badgeBg, color: badgeClr }}>{badgeTxt}</span>
                          </div>
                        </div>
                        {/* Expanded strategy sub-rows */}
                        {isExp && (
                          <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 10, paddingLeft: 8, marginBottom: 4 }}>
                            {d.rows.map((r, ri) => (
                              <div key={ri} style={{ display: 'flex', justifyContent: 'space-between',
                                fontSize: 10, color: 'var(--text-muted)', padding: '2px 0' }}>
                                <span>{r.label}</span>
                                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{fmt(r.amount)}</span>
                              </div>
                            ))}

                          </div>
                        )}
                      </div>
                    );
                  })}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700 }}>
                    <span style={{ color: 'var(--text-muted)' }}>Total</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: '#1a7a4a' }}>{fmt(totalPnlToday)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
          <div
            key={i}
            className={`stat-card${c.onClick ? ' clickable' : ''}`}
            style={{ ...tileStyle, cursor: c.onClick ? 'pointer' : 'default' }}
            onClick={c.onClick}
            title={c.tooltip}
          >
            <div style={tileLabelStyle}>{c.label}</div>
            <div style={{ ...tileValueStyle, color: c.color }}>{c.value}</div>
            {c.streak && (
              <div style={{ fontSize: 9, fontWeight: 700, color: c.streakColor, background: c.streakColor + '18', padding: '1px 6px', borderRadius: 10, display: 'inline-block', marginBottom: 3 }}>
                {c.streak}
              </div>
            )}
            <div style={{ ...tileBadgeStyle, background: c.badgeBg, color: c.color }}>{c.badge}</div>
          </div>
          )
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
        {statCardsBottom.map((c, i) => (
          c.isRealised ? (
            <div key={i} className="stat-card" style={tileStyle} title={c.tooltip}>
              <div style={tileLabelStyle}>{c.label}</div>
              <div style={{ ...tileValueStyle, color: c.color }}>{c.value}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ ...tileBadgeStyle, background: c.badgeBg, color: c.color }}>{c.badge}</div>
                {(realisedBreakdown.optionRows.length > 0 || realisedBreakdown.shareRows.length > 0) && (
                  <button
                    onClick={() => setShowRealisedDetail(v => !v)}
                    style={{ background: c.color + '18', border: `1px solid ${c.color}`, color: c.color,
                      borderRadius: 4, padding: '1px 7px', fontSize: 9.5, cursor: 'pointer', fontWeight: 700 }}
                  >
                    {showRealisedDetail ? '▲ Hide' : '▼ Details'}
                  </button>
                )}
              </div>
              {showRealisedDetail && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {/* Bucket 1 — Option income */}
                  {realisedBreakdown.optionGroups.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
                        display: 'flex', justifyContent: 'space-between' }}>
                        <span>Option Income</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: realisedBreakdown.optionTotal >= 0 ? '#1a7a4a' : '#c0392b' }}>
                          {realisedBreakdown.optionTotal >= 0 ? '+' : ''}{fmt(realisedBreakdown.optionTotal)}
                        </span>
                      </div>
                      {realisedBreakdown.optionGroups.map((g, gi) => {
                        const isExp = !!realisedOptExpanded[gi];
                        const dot   = g.pnl >= 0 ? '#1a7a4a' : '#c0392b';
                        return (
                          <div key={gi}>
                            <div
                              onClick={() => setRealisedOptExpanded(prev => ({ ...prev, [gi]: !prev[gi] }))}
                              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '3px 4px', borderRadius: 4, cursor: 'pointer',
                                background: isExp ? (g.pnl >= 0 ? 'var(--green-bg)' : 'var(--red-bg, #fff0f0)') : 'transparent' }}
                              onMouseEnter={e => { if (!isExp) e.currentTarget.style.background = 'var(--bg-hover, #f5f5f5)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = isExp ? (g.pnl >= 0 ? 'var(--green-bg)' : 'var(--red-bg, #fff0f0)') : 'transparent'; }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block',
                                  transform: isExp ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>▶</span>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block', flexShrink: 0 }} />
                                <span style={{ fontWeight: 700, fontSize: 11, color: 'var(--text-primary)' }}>{g.ticker}</span>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{g.trades.length} closed</span>
                              </div>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: dot }}>
                                {g.pnl >= 0 ? '+' : ''}{fmt(g.pnl)}
                              </span>
                            </div>
                            {isExp && (
                              <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 10, paddingLeft: 8, marginBottom: 2 }}>
                                {g.trades.map((r, ri) => (
                                  <div key={ri} style={{ display: 'flex', justifyContent: 'space-between',
                                    fontSize: 10, color: 'var(--text-muted)', padding: '2px 0',
                                    minWidth: 0, overflow: 'hidden' }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 6 }}>{r.label}</span>
                                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, flexShrink: 0,
                                      color: r.pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                                      {r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}
                                    </span>
                                  </div>
                                ))}

                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Bucket 2 — Share gains */}
                  {realisedBreakdown.shareGroups.length > 0 && (
                    <div style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
                        textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4,
                        borderTop: realisedBreakdown.optionGroups.length > 0 ? '1px solid var(--border)' : 'none',
                        paddingTop: realisedBreakdown.optionGroups.length > 0 ? 6 : 0,
                        display: 'flex', justifyContent: 'space-between' }}>
                        <span>Share Gains / Losses</span>
                        <span style={{ fontFamily: 'var(--font-mono)', color: realisedBreakdown.shareTotal >= 0 ? '#1a7a4a' : '#c0392b' }}>
                          {realisedBreakdown.shareTotal >= 0 ? '+' : ''}{fmt(realisedBreakdown.shareTotal)}
                        </span>
                      </div>
                      {realisedBreakdown.shareGroups.map((g, gi) => {
                        const isExp = !!realisedShrExpanded[gi];
                        const dot   = g.pnl >= 0 ? '#1a7a4a' : '#c0392b';
                        return (
                          <div key={gi}>
                            <div
                              onClick={() => setRealisedShrExpanded(prev => ({ ...prev, [gi]: !prev[gi] }))}
                              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                                padding: '3px 4px', borderRadius: 4, cursor: 'pointer',
                                background: isExp ? (g.pnl >= 0 ? 'var(--green-bg)' : 'var(--red-bg, #fff0f0)') : 'transparent' }}
                              onMouseEnter={e => { if (!isExp) e.currentTarget.style.background = 'var(--bg-hover, #f5f5f5)'; }}
                              onMouseLeave={e => { e.currentTarget.style.background = isExp ? (g.pnl >= 0 ? 'var(--green-bg)' : 'var(--red-bg, #fff0f0)') : 'transparent'; }}
                            >
                              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                                <span style={{ fontSize: 9, color: 'var(--text-muted)', display: 'inline-block',
                                  transform: isExp ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.15s' }}>▶</span>
                                <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, display: 'inline-block', flexShrink: 0 }} />
                                <span style={{ fontWeight: 700, fontSize: 11, color: 'var(--text-primary)' }}>{g.ticker}</span>
                                <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>{g.trades.length} lot{g.trades.length !== 1 ? 's' : ''}</span>
                              </div>
                              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, fontWeight: 600, color: dot }}>
                                {g.pnl >= 0 ? '+' : ''}{fmt(g.pnl)}
                              </span>
                            </div>
                            {isExp && (
                              <div style={{ borderLeft: '2px solid var(--border)', marginLeft: 10, paddingLeft: 8, marginBottom: 2 }}>
                                {g.trades.map((r, ri) => (
                                  <div key={ri} style={{ display: 'flex', justifyContent: 'space-between',
                                    fontSize: 10, color: 'var(--text-muted)', padding: '2px 0',
                                    minWidth: 0, overflow: 'hidden' }}>
                                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginRight: 6 }}>{r.label}</span>
                                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, flexShrink: 0,
                                      color: r.pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>
                                      {r.pnl >= 0 ? '+' : ''}{fmt(r.pnl)}
                                    </span>
                                  </div>
                                ))}

                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Grand total shown in tile above */}

                </div>
              )}
            </div>
          ) : c.isCapital ? (
            <div key={i} className="stat-card" style={tileStyle} title={c.tooltip}>
              <div style={tileLabelStyle}>{c.label}</div>
              <div style={{ ...tileValueStyle, color: c.color }}>{c.value}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <div style={{ ...tileBadgeStyle, background: c.badgeBg, color: c.color }}>{c.badge}</div>
                {capitalByTicker.length > 0 && (
                  <button
                    onClick={() => setShowCapitalDetail(v => !v)}
                    style={{ background: 'var(--blue-bg)', border: '1px solid var(--blue)', color: '#1a5fa8',
                      borderRadius: 4, padding: '1px 7px', fontSize: 9.5, cursor: 'pointer', fontWeight: 700 }}
                  >
                    {showCapitalDetail ? '▲ Hide' : '▼ By ticker'}
                  </button>
                )}
              </div>
              {showCapitalDetail && capitalByTicker.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  {capitalByTicker.map(({ ticker, total, pct, rows }) => (
                    <div key={ticker} style={{ marginBottom: 8 }}>
                      {/* Ticker header row */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 2 }}>
                        <span style={{ fontWeight: 700, fontSize: 12, color: 'var(--text-primary)' }}>{ticker}</span>
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: '#1a5fa8' }}>{fmt(total)}</span>
                          <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--blue-bg)', borderRadius: 3, padding: '1px 5px', fontWeight: 600 }}>{pct.toFixed(1)}%</span>
                        </div>
                      </div>
                      {/* Progress bar */}
                      <div style={{ height: 3, background: 'var(--border)', borderRadius: 2, marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${Math.min(100, pct)}%`, background: '#1a5fa8', borderRadius: 2 }} />
                      </div>
                      {/* Detail rows */}
                      {rows.map((r, ri) => (
                        <div key={ri} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', paddingLeft: 8 }}>
                          <span>{r.label}</span>
                          <span style={{ fontFamily: 'var(--font-mono)' }}>{fmt(r.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 700 }}>
                    <span>Total</span>
                    <span style={{ fontFamily: 'var(--font-mono)', color: '#1a5fa8' }}>{fmt(totalCapital)}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div key={i} className="stat-card" style={tileStyle} title={c.tooltip}>
              <div style={tileLabelStyle}>{c.label}</div>
              <div style={{ ...tileValueStyle, color: c.color }}>{c.value}</div>
              <div style={{ ...tileBadgeStyle, background: c.badgeBg, color: c.color }}>{c.badge}</div>
            </div>
          )
        ))}
      </div>

      {/* Charts row */}
      <div className="charts-row">
        <div className="chart-card">
          <div className="chart-title">Cumulative P&L</div>
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={cumulativeData}>
              <defs>
                <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={pnlColor} stopOpacity={0.25} />
                  <stop offset="95%" stopColor={pnlColor} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} />
              <Tooltip formatter={(v) => fmt(v)} labelStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="cumulative" stroke={pnlColor} strokeWidth={2} fill="url(#pnlGrad)" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
          {/* FIX #16: Warn when closed trades are missing exit_date (plotted by entry_date instead) */}
          {missingExitDateCount > 0 && (
            <div style={{ fontSize: 11, color: 'var(--amber)', marginTop: 6, padding: '4px 8px', background: 'var(--amber-bg)', borderRadius: 4 }}>
              ⚠ {missingExitDateCount} closed trade{missingExitDateCount > 1 ? 's are' : ' is'} missing an exit date — plotted by entry date. Edit those trades to improve accuracy.
            </div>
          )}
        </div>

        <div className="chart-card">
          <div className="chart-title">Win / Loss Split</div>
          <ResponsiveContainer width="100%" height={180}>
            <PieChart>
              <Pie data={[{ name: 'Wins', value: stats.closedTrades > 0 ? Math.round(stats.winRate) : 0 }, { name: 'Losses', value: stats.closedTrades > 0 ? 100 - Math.round(stats.winRate) : 100 }]}
                cx="50%" cy="50%" innerRadius={40} outerRadius={65}
                dataKey="value" label={({ name, value }) => `${name} ${value}%`} labelLine={false}
              >
                <Cell fill="#1a7a4a" />
                <Cell fill="#c0392b" />
              </Pie>
              <Tooltip formatter={(v) => v + '%'} />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Monthly Income Bar Chart ── */}
      {monthlyData.length > 0 && (
        <div className="chart-card" style={{ marginBottom: 14 }}>
          <div className="chart-title" title="Premium income collected per calendar month. Green = profitable month, red = net loss month.">
            Monthly Income
            <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>
              (last 12 months · hover for details)
            </span>
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={monthlyData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <XAxis dataKey="month" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtK} />
              <Tooltip
                formatter={(v) => [fmt(v), 'P&L']}
                labelStyle={{ fontSize: 11 }}
                contentStyle={{ fontSize: 11 }}
              />
              <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                {monthlyData.map((e, i) => (
                  <Cell key={i} fill={e.pnl >= 0 ? '#1a7a4a' : '#c0392b'} fillOpacity={0.85} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* P&L by strategy */}
      {byStrategy.length > 0 && (() => {
        // Dynamic height: 32px per bar + 24px padding, min 120
        const chartH = Math.max(120, byStrategy.length * 32 + 24);
        // Custom label at end of bar showing $ value
        const BarLabel = ({ x, y, width, height, value }) => {
          if (value == null) return null;
          const isPos = value >= 0;
          const labelX = isPos ? x + width + 4 : x + width - 4;
          const anchor = isPos ? 'start' : 'end';
          return (
            <text x={labelX} y={y + height / 2} dy={4}
              textAnchor={anchor} fill={isPos ? '#1a7a4a' : '#c0392b'}
              fontSize={10} fontFamily="var(--font-mono)" fontWeight={600}>
              {isPos ? '+' : ''}{fmt(value)}
            </text>
          );
        };
        return (
          <div className="chart-card" style={{ marginBottom: 14 }}>
            <div className="chart-title">P&L by Strategy</div>
            <ResponsiveContainer width="100%" height={chartH}>
              <BarChart data={byStrategy} layout="vertical"
                margin={{ left: 8, right: 72, top: 4, bottom: 4 }}
                barCategoryGap="35%">
                <XAxis type="number" hide />
                <YAxis type="category" dataKey="strategy"
                  tick={{ fontSize: 11, fontFamily: 'var(--font-sans)', fill: 'var(--text-secondary)' }}
                  width={160} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v) => [fmt(v), 'P&L']} />
                <Bar dataKey="pnl" radius={3} maxBarSize={18}
                  label={<BarLabel />}>
                  {byStrategy.map((e, i) => (
                    <Cell key={i} fill={e.pnl >= 0 ? '#1a7a4a' : '#c0392b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        );
      })()}

    </div>
  );
}
