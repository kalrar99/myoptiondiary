// src/components/Alerts.jsx
// Standalone view — Alerts & Actionable Insights Monitor

import React, { useState, useMemo } from 'react';
import { DEFAULT_RISK_FREE_RATE, nearestExpiryFriday } from '../utils/tradingCalendar';

export default function Alerts({ trades, pill, currentPrices, onRoll: onRollProp, onCloseTrade: onCloseTradeprop, alertsFrom, onBackToPositions, onGoToTradeLog }) {
  const [expanded,     setExpanded]     = useState({});
  const [rollingTrade, setRollingTrade] = useState(null); // eslint-disable-line no-unused-vars

  // Delegate roll to parent if provided, otherwise use internal state
  function onRoll(trade) {
    if (onRollProp) onRollProp(trade);
    else setRollingTrade(trade);
  }

  // Black-Scholes approximation (Abramowitz & Stegun normal CDF)
  function bsApprox(S, K, T_days, iv_pct, isCall) {
    if (!S || !K || T_days <= 0 || !iv_pct) return null;
    const T = T_days / 365;
    const s = iv_pct / 100;
    const r = DEFAULT_RISK_FREE_RATE;
    const d1 = (Math.log(S / K) + (r + 0.5 * s * s) * T) / (s * Math.sqrt(T));
    const d2 = d1 - s * Math.sqrt(T);
    function N(x) {
      const a = [0, 0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
      const k = 1 / (1 + 0.2316419 * Math.abs(x));
      let poly = 0, kpow = k;
      for (let i = 1; i <= 5; i++) { poly += a[i] * kpow; kpow *= k; }
      const n = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
      const val = 1 - n * poly;
      return x >= 0 ? val : 1 - val;
    }
    if (isCall) return Math.max(0, S * N(d1) - K * Math.exp(-r * T) * N(d2));
    return Math.max(0, K * Math.exp(-r * T) * N(-d2) - S * N(-d1));
  }

  // ── N(x) CDF helper — Abramowitz & Stegun ────────────────
  function normCdf(x) {
    const a = [0, 0.319381530, -0.356563782, 1.781477937, -1.821255978, 1.330274429];
    const k = 1 / (1 + 0.2316419 * Math.abs(x));
    let poly = 0, kpow = k;
    for (let i = 1; i <= 5; i++) { poly += a[i] * kpow; kpow *= k; }
    const n = Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
    const val = 1 - n * poly;
    return x >= 0 ? val : 1 - val;
  }

  // ── BS Delta — correct N(d1) formula ─────────────────────
  function bsDelta(S, K, T_days, iv_pct, isCall) {
    if (!S || !K || T_days <= 0 || !iv_pct) return null;
    const T  = Math.max(T_days / 365, 0.001);
    const s  = iv_pct / 100;
    const r  = DEFAULT_RISK_FREE_RATE;
    const d1 = (Math.log(S / K) + (r + 0.5 * s * s) * T) / (s * Math.sqrt(T));
    return isCall ? normCdf(d1) : normCdf(d1) - 1; // put delta is negative
  }

  // ── CC/CSP Roll scenarios — the ONLY strategies that get numerical roll cards ──
  // Restricted to Covered Call and Cash-Secured Put where the mathematics is
  // unambiguous: one strike, one expiry, one direction, one premium.
  // Fixes: IV uses currentIv first; delta uses correct N(d1); breakeven fixed.
  function buildRollScenarios(trade, currentStock, dte, currentIv) {
    const entry     = trade.entry_price || 0;
    const contracts = trade.contracts   || 1;
    const strike    = trade.strike_sell || trade.strike_buy || 0;
    // Use current IV from Yahoo/MarketData when available, fall back to entry IV
    const iv        = currentIv || trade.iv_entry || 35;
    const isCall    = trade.strategy === 'Covered Call';
    // Conservative stock proxy when no Yahoo: 2% OTM from strike
    const S         = currentStock || (isCall ? strike * 0.98 : strike * 1.02);
    const hasRealS  = !!currentStock;

    const curTheo   = bsApprox(S, strike, Math.max(dte || 1, 1), iv, isCall);
    const buyback   = curTheo != null ? Math.round(curTheo * 100) / 100 : null;
    const closePnl  = buyback != null ? Math.round((entry - buyback) * contracts * 100) : null;
    // OCC standard strike increments
    // Use $5 for strikes >$50 — consistent with TradeForm and RollModal fix
    const strikeStep = strike < 5 ? 0.5 : strike < 25 ? 1 : strike < 50 ? 2.5 : 5;
    const improvedStrike = isCall ? strike + strikeStep : strike - strikeStep;

    function scenario(label, newDTE, newStrike, isClose, isRecommended) {
      if (isClose) {
        const pct = entry > 0 ? Math.round((entry - (buyback||0)) / entry * 100) : null;
        return {
          label, isClose: true, isRecommended: false,
          newStrike: null, newDTE: null, newPremium: null, buyback,
          netCredit: null, combinedPnl: closePnl, newDelta: null, newBreakeven: null,
          rationale: closePnl != null && closePnl >= 0
            ? `Position is profitable (${pct ?? '?'}% of max premium captured). Closing locks in the gain and frees capital for a fresh 45-DTE trade.`
            : `Currently at a loss. Closing limits damage to $${Math.abs(closePnl ?? 0).toLocaleString()} and removes gamma risk. Capital freed for a better setup.`,
          pros: ['Removes gamma risk entirely', 'Frees capital immediately', 'Locks in any premium captured'],
          cons: ['Forgoes remaining time value', closePnl != null && closePnl < 0 ? 'Realises the current loss' : 'Caps further profit'],
          riskNote: 'Clean exit. No remaining obligation.',
          isEstimated: !hasRealS,
        };
      }
      const np = bsApprox(S, newStrike, newDTE, iv, isCall);
      const newPremium  = np != null ? Math.round(np * 100) / 100 : null;
      const netCredit   = newPremium != null && buyback != null ? Math.round((newPremium - buyback) * 100) / 100 : null;
      const combinedPnl = netCredit != null ? Math.round((entry - buyback + newPremium) * contracts * 100) : null;

      // Correct delta: N(d1) for calls, N(d1)-1 for puts
      const rawDelta = bsDelta(S, newStrike, newDTE, iv, isCall);
      const newDelta = rawDelta != null ? Math.abs(rawDelta).toFixed(2) : null;

      // Correct breakeven: net credit reduces the effective strike obligation
      // For CC: breakeven = newStrike - net credit per share (stock needs to close here for max profit)
      // For CSP: breakeven = newStrike + net debit per share
      const netCreditPerShare = (entry - (buyback||0) + (newPremium||0));
      const newBreakeven = isCall
        ? Math.round((newStrike - netCreditPerShare) * 100) / 100
        : Math.round((newStrike + netCreditPerShare) * 100) / 100;

      const isDebit = netCredit != null && netCredit < 0;
      // Anchor expiry from trade expiration, not today — identical logic to RollModal.scenarioExpiry().
      // 'Roll +45d' means 45 fresh days of theta past the current expiry, not 45 days from today.
      // This ensures the Alerts card and the RollModal always show the same target date.
      function scenarioExpiryFromTrade(daysFromExpiry) {
        const base = trade.expiration ? new Date(trade.expiration) : new Date();
        base.setDate(base.getDate() + daysFromExpiry);
        let exp = nearestExpiryFriday(base);
        // Guard: never roll to the same expiry — push out one more Friday
        if (exp === trade.expiration) {
          const d = new Date(exp); d.setDate(d.getDate() + 7);
          exp = nearestExpiryFriday(d);
        }
        return exp;
      }
      const newExpiry = newDTE ? scenarioExpiryFromTrade(newDTE) : null;
      return {
        label, isClose: false, isRecommended,
        newStrike, newDTE, newExpiry, newPremium, buyback, netCredit, combinedPnl,
        newDelta, newBreakeven,
        rationale: isDebit
          ? 'Rolling for a net debit violates the golden rule — you are paying to extend a losing position without collecting new premium.'
          : isCall
            ? `Rolling +${newDTE}d from expiry to $${newStrike} collects additional premium and resets the theta clock. ${newStrike > strike ? 'Higher strike gives the stock more room to run.' : 'Same strike buys time.'}`
            : `Rolling +${newDTE}d from expiry to $${newStrike} collects credit and lowers your effective cost basis. ${newStrike < strike ? 'Lower strike reduces assignment risk.' : 'Same strike buys time for the stock to recover.'}`,
        pros: isDebit ? ['None \u2014 net debit is not recommended'] : [
          `Collects $${netCredit?.toFixed(2) ?? '?'} net credit`,
          'Resets theta decay clock',
          newStrike !== strike ? `${isCall ? 'Higher' : 'Lower'} strike improves position` : 'Same strike \u2014 pure time extension',
        ],
        cons: isDebit ? ['Paying to extend a losing position', 'Violates golden rule'] : [
          'Extends capital commitment',
          `On risk for ${newDTE} more days`,
        ],
        riskNote: isDebit ? '\u26a0 Golden rule violated \u2014 net debit roll not recommended.' : `New breakeven: $${newBreakeven?.toFixed(2) ?? '?'} \u00b7 New delta: ${newDelta ?? '?'}`,
        isEstimated: !hasRealS,
      };
    }

    return [
      scenario('Close Now',                                 0,             strike,         true,  false),
      scenario('Roll Out \u00b7 +30d',                                    30,            strike,         false, false),
      scenario('Roll Out \u00b7 +45d \u2605',                            45,            strike,         false, true),
      scenario(isCall ? `Roll Out and Up \u00b7 +45d \u00b7 Strike +$${strikeStep}` : `Roll Out and Down \u00b7 +45d \u00b7 Strike -$${strikeStep}`, 45, improvedStrike, false, false),
    ];
  }

  // ── Guidance card for strategies where numbers would mislead ──────────────
  // Pure text — always accurate regardless of price availability.
  function buildGuidanceCard(trade, theoPnl) {
    const strat = trade.strategy;
    const entry = trade.entry_price || 0;
    const gainPct = theoPnl != null && entry > 0
      ? Math.round((Math.abs(theoPnl) / (entry * (trade.contracts||1) * 100)) * 100)
      : null;
    const isWinning = theoPnl != null && theoPnl > 0;
    const isLosing  = theoPnl != null && theoPnl < 0;

    if (strat === 'Long Call' || strat === 'Long Put') {
      const dir = strat === 'Long Call' ? 'call' : 'put';
      const opp = strat === 'Long Call' ? 'bull call spread' : 'bear put spread';
      if (isLosing && gainPct != null && gainPct >= 50)
        return { title: 'Consider closing', body: `This long ${dir} has lost ${gainPct}% of its value. Long options rarely recover from a 50%+ loss without adding more risk. Closing now limits the damage and frees capital for a better setup.`, action: 'close' };
      if (isWinning && gainPct != null && gainPct >= 100)
        return { title: 'Consider locking in profits', body: `This long ${dir} is up ${gainPct}%. Consider selling a further OTM option against it to convert to a ${opp} — this returns premium to your account and reduces your cost basis while keeping upside exposure.`, action: 'profit' };
      return { title: 'Monitor closely', body: `Long ${dir}s are time-sensitive — theta decay works against you every day. If the expected move has not materialised with less than 21 DTE remaining, consider cutting the position rather than watching it decay to zero.`, action: 'watch' };
    }

    if (strat === 'Long Straddle' || strat === 'Long Strangle') {
      return { title: 'Consider legging out', body: `If one leg is significantly more profitable than the other, consider closing just the winning leg (legging out) while keeping the losing leg open for a potential reversal. Always close the short option first if legging out of any spread. At 21 DTE or less with no significant move, cut the entire position to preserve remaining value.`, action: 'watch' };
    }

    if (strat === 'Bull Call Spread' || strat === 'Bear Put Spread') {
      if (isWinning && gainPct != null && gainPct >= 75)
        return { title: 'Take profit', body: `At ${gainPct}% of max profit, close the entire spread now. Rolling a debit spread for more debit increases your breakeven and adds risk — the correct management is to close at target and redeploy.`, action: 'profit' };
      if (isLosing && gainPct != null && gainPct >= 50)
        return { title: 'Consider cutting the loss', body: `This debit spread has lost ${gainPct}% of its value. The maximum loss is already defined — there is no further risk reduction from holding. Closing frees capital for a better directional setup.`, action: 'close' };
      return { title: 'Monitor the position', body: `Debit spreads need the underlying to move in your direction by expiry. With less than 21 DTE remaining and the spread not yet profitable, consider closing to avoid total loss of premium paid.`, action: 'watch' };
    }

    return { title: 'Manage in Trade Log', body: 'Use the Trade Log to close, roll, or adjust this position.', action: 'watch' };
  }

  // ── Strategy sets for alert classification ────────────
  const CREDIT_STRATS = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly']);
  const DEBIT_STRATS  = new Set(['Long Call','Long Put','Bull Call Spread','Bear Put Spread','Long Straddle','Long Strangle']);
  const SPREAD_STRATS = new Set(['Bull Call Spread','Bear Put Spread','Bull Put Spread','Bear Call Spread']);
  const CAL_STRATS    = new Set(['Calendar Spread','Diagonal Spread']);
  const IC_STRATS     = new Set(['Iron Condor','Iron Butterfly']);

  // Standalone open trades — excludes IC and calendar chain legs
  const standaloneTrades = trades.filter(t =>
    t.status === 'open' && !t.condor_chain_id && t.cal_chain_id == null
  );
  const openTrades = trades.filter(t => t.status === 'open');

  // Group IC chains that have open legs
  const icChainMap = useMemo(() => {
    const map = {};
    trades.forEach(t => {
      if (!t.condor_chain_id) return;
      const key = String(t.condor_chain_id);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    });
    Object.keys(map).forEach(k => {
      if (!map[k].some(t => (t.contracts_open || 0) > 0)) delete map[k];
    });
    return map;
  }, [trades]);

  // Group Calendar chains that have open legs
  const calChainMap = useMemo(() => {
    const map = {};
    trades.forEach(t => {
      if (t.cal_chain_id == null) return;
      const key = String(t.cal_chain_id);
      if (!map[key]) map[key] = [];
      map[key].push(t);
    });
    Object.keys(map).forEach(k => {
      if (!map[k].some(t => t.status === 'open')) delete map[k];
    });
    return map;
  }, [trades]);

  const alerts = useMemo(() => {
    const result  = [];
    const sevOrd  = { red: 0, amber: 1, blue: 2 };

    // ════════════════════════════════════════════════════
    // SECTION 1 — Standalone trades (CC, CSP, spreads, Long options)
    // ════════════════════════════════════════════════════
    standaloneTrades.forEach(trade => {
      const dte      = trade.expiration ? Math.ceil((new Date(trade.expiration) - new Date()) / 86400000) : null;
      const entry    = parseFloat(trade.entry_price) || 0;
      const curOpt   = currentPrices?.[trade.id]?.option;
      const curStk   = parseFloat(currentPrices?.[trade.id]?.stock || currentPrices?.[trade.ticker?.toUpperCase()]?.stock);
      const strat    = trade.strategy;
      const isCredit = CREDIT_STRATS.has(strat);
      const isDebit  = DEBIT_STRATS.has(strat);
      const c        = trade.contracts || 1;

      // Theo P&L (exact or BS estimate)
      let theoPnl = null, theoPnlIsEst = false;
      if (curOpt != null && entry > 0) {
        theoPnl = Math.round((isCredit ? entry - curOpt : curOpt - entry) * c * 100);
      } else if (curStk && dte != null && dte > 0) {
        const K = parseFloat(trade.strike_sell || trade.strike_buy);
        const curIvPct = currentPrices?.[trade.id]?.iv;
        const ivPct = curIvPct != null ? curIvPct : (trade.iv_entry || 0);
        const NO_BS = new Set(['Iron Condor','Iron Butterfly','Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread']);
        const isCallA = ['Covered Call','Bear Call Spread','Bull Call Spread','Long Call'].includes(strat);
        if (K > 0 && ivPct > 0 && entry > 0 && !NO_BS.has(strat)) {
          const bsOpt = bsApprox(curStk, K, dte, ivPct, isCallA);
          if (bsOpt != null && bsOpt >= 0) {
            theoPnl = Math.round((isCredit ? entry - bsOpt : bsOpt - entry) * c * 100);
            theoPnlIsEst = true;
          }
        }
      }

      // Live delta via BS
      let delta = Math.abs(trade.delta || 0);
      if (curStk && dte != null && dte > 0) {
        const K = parseFloat(trade.strike_sell || trade.strike_buy);
        const iv = (trade.iv_entry || 35) / 100;
        const T  = Math.max(0.001, dte / 365);
        const isCall = ['Covered Call','Bear Call Spread','Bull Call Spread','Long Call'].includes(strat);
        if (K > 0 && iv > 0) {
          const d1 = (Math.log(curStk / K) + (0.053 + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
          const nd = x => { const a=[0,0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429],k=1/(1+0.2316419*Math.abs(x)); let p=0,kp=k; for(let i=1;i<=5;i++){p+=a[i]*kp;kp*=k;} const n=Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); const v=1-n*p; return x>=0?v:1-v; };
          delta = Math.abs(isCall ? nd(d1) : nd(d1) - 1);
        }
      }
      const deltaSource = (curStk && dte != null && dte > 0) ? 'live' : 'entry';
      const pct = (curOpt != null && isCredit && entry > 0)
        ? Math.min(100, ((entry - curOpt) / entry) * 100) : null;

      const fa = []; // fireAlerts

      // ── TIER 1: Always-on (no price needed) ─────────────
      if (dte != null && dte <= 7)
        fa.push({ sev:'red',   reason:`${dte} DTE \u2014 expires in ${dte} day${dte!==1?'s':''}. Worth reviewing today.` });

      // Delta > 0.50: assignment risk for credit strategies only
      if (!IC_STRATS.has(strat) && !CAL_STRATS.has(strat) && !isDebit && delta > 0.50)
        fa.push({ sev:'red',   reason:`Delta ${delta.toFixed(2)} (${deltaSource}) — high assignment/exercise probability.` });
      // For debit strategies: delta > 0.50 means strongly directional (not an assignment risk)
      if (isDebit && Math.abs(delta) > 0.70)
        fa.push({ sev:'amber', reason:`Delta ${delta.toFixed(2)} (${deltaSource}) — strongly directional. position is strongly directional.` });

      if (dte != null && dte <= 21 && dte > 7) {
        const msg = isDebit
          ? 'Theta decay accelerating \u2014 time working against long position.'
          : 'Entering gamma danger zone. Monitor daily.';
        fa.push({ sev:'amber', reason:`${dte} DTE \u2014 ${msg}` });
      }

      if (!IC_STRATS.has(strat) && !CAL_STRATS.has(strat) && !isDebit && delta > 0.35 && delta <= 0.50)
        fa.push({ sev:'amber', reason:`Delta ${delta.toFixed(2)} (${deltaSource}) — elevated assignment risk.` });

      // ── TIER 2: Price-enhanced (fires when Yahoo/broker has data) ──
      if (curStk && isCredit) {
        const ss = parseFloat(trade.strike_sell);
        const ls = parseFloat(trade.strike_buy);
        if (strat === 'Covered Call' && ss > 0) {
          if (curStk >= ss)
            fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} \u2265 $${ss} call strike \u2014 CC is in-the-money — shares may be called away at expiry.` });
          else if (curStk >= ss * 0.97)
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} within 3% of $${ss} call strike \u2014 stock is within 3% of the call strike.` });
        }
        if (strat === 'Cash-Secured Put' && ls > 0) {
          if (curStk <= ls)
            fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} \u2264 $${ls} put strike \u2014 CSP is in-the-money — assignment is possible at expiry.` });
          else if (curStk <= ls * 1.03)
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} within 3% of $${ls} put strike \u2014 stock is within 3% of the put strike.` });
        }
        // P2 #9: CC — stock has dropped sharply vs entry date stock price
        // We approximate entry stock price from strike_sell + typical CC delta OTM buffer
        // Better signal: compare curStk to strike (if curStk << strike, lot is deeply underwater)
        if (strat === 'Covered Call') {
          const ss = parseFloat(trade.strike_sell) || 0;
          // If stock has dropped far below the CC strike, the premium doesn't offset the share loss
          // Proxy: stock is >20% below the call strike (strike was set near stock at entry)
          if (ss > 0 && curStk < ss * 0.80)
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is more than 20% below the $${ss} call strike \u2014 the CC premium may not offset the unrealised loss on shares. Worth reviewing the wheel thesis for this position.` });
        }
        // P2 #10: CSP — stock has dropped sharply, reconsider assignment desirability
        if (strat === 'Cash-Secured Put') {
          const ls2 = parseFloat(trade.strike_buy) || 0;
          if (ls2 > 0 && curStk < ls2 * 0.85)
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is more than 15% below the $${ls2} put strike \u2014 worth considering whether assignment at the strike price still fits the original thesis.` });
        }
      }
      // P1 #4+5: Credit spread short-strike proximity + breach (BPS / BCS)
      if ((strat === 'Bull Put Spread' || strat === 'Bear Call Spread') && curStk) {
        const shortStrike = parseFloat(trade.strike_sell) || 0;
        if (shortStrike > 0) {
          if (strat === 'Bull Put Spread') {
            if (curStk <= shortStrike)
              fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} has reached the put short strike $${shortStrike} \u2014 the spread is fully at risk. Max loss is the spread width minus credit received.` });
            else if (((curStk - shortStrike) / curStk) * 100 < 3)
              fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within 3% of put short strike $${shortStrike} \u2014 the spread is approaching its tested zone.` });
          } else {
            if (curStk >= shortStrike)
              fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} has reached the call short strike $${shortStrike} \u2014 the spread is fully at risk. Max loss is the spread width minus credit received.` });
            else if (((shortStrike - curStk) / curStk) * 100 < 3)
              fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within 3% of call short strike $${shortStrike} \u2014 the spread is approaching its tested zone.` });
          }
          // 2× stop-loss: loss >= 2× credit — OptionAlpha defined-risk spread rule
          if (curOpt != null && entry > 0) {
            const spreadLossPct = ((parseFloat(curOpt) - entry) / entry) * 100;
            if (spreadLossPct >= 200)
              fa.push({ sev:'red', reason:`Spread value is 2\u00d7 the original credit \u2014 a common stop-loss level for defined-risk spreads.` });
          }
        }
      }

      // Credit profit targets
      if (pct != null && pct >= 80)
        fa.push({ sev:'blue', reason:`${pct.toFixed(0)}% of max credit captured \u2014 premium largely captured.` });
      else if (pct != null && pct >= 50)
        fa.push({ sev:'blue', reason:`${pct.toFixed(0)}% of max credit \u2014 position has reached 50% of max credit — a widely used exit point where reward-to-risk becomes less favourable.` });

      // Debit 50% stop-loss
      if (isDebit && curOpt != null && entry > 0) {
        const lossPct = ((entry - parseFloat(curOpt)) / entry) * 100;
        if (lossPct >= 50)
          fa.push({ sev:'red', reason:`Lost ${lossPct.toFixed(0)}% of premium paid \u2014 50% of premium paid has been lost — a common stop-loss threshold.` });
      }
      // P1 #8: Long options — deeply OTM (delta < 0.30)
      if ((strat === 'Long Call' || strat === 'Long Put') && delta > 0 && delta < 0.30 && dte != null && dte > 0) {
        fa.push({ sev:'amber', reason:`Delta ${delta.toFixed(2)} (${deltaSource}) \u2014 option is deeply out-of-the-money. Statistical probability of expiring worthless is above 70%.` });
      }

      // Long call/put profit target (doubled money)
      if ((strat === 'Long Call' || strat === 'Long Put') && curOpt != null && entry > 0) {
        const gainPct = ((parseFloat(curOpt) - entry) / entry) * 100;
        if (gainPct >= 100)
          fa.push({ sev:'blue', reason:`Long ${strat === 'Long Call' ? 'call' : 'put'} up ${gainPct.toFixed(0)}% \u2014 option has doubled in value — a common take-profit level.` });
      }
      // Debit spread 75% profit target
      if (SPREAD_STRATS.has(strat) && isDebit && curOpt != null && entry > 0) {
        const sw = Math.abs((parseFloat(trade.strike_sell)||0) - (parseFloat(trade.strike_buy)||0));
        const maxGain = sw > 0 ? (sw - entry) * c * 100 : null;
        if (maxGain != null && maxGain > 0) {
          const gainPct = ((parseFloat(curOpt) - entry) * c * 100 / maxGain) * 100;
          if (gainPct >= 75)
            fa.push({ sev:'blue', reason:`${gainPct.toFixed(0)}% of max profit on debit spread \u2014 debit spread is near its profit target.` });
          // P2 #15: debit spread near max profit with <7 DTE — last few percent not worth pin risk
          if (gainPct >= 75 && dte != null && dte <= 7)
            fa.push({ sev:'blue', reason:`Spread at ${gainPct.toFixed(0)}% of max profit with ${dte} DTE \u2014 very little additional gain remains vs the risk of holding through expiry.` });
        }
      }

      // P2 #11: Straddle/Strangle — IV crush (IV dropped ≥30% since entry)
      if ((strat === 'Long Straddle' || strat === 'Long Strangle') && curStk) {
        const curIv = currentPrices?.[trade.id]?.iv;
        const entryIv = trade.iv_entry;
        if (curIv != null && entryIv > 0) {
          const ivDrop = ((entryIv - curIv) / entryIv) * 100;
          if (ivDrop >= 30)
            fa.push({ sev:'amber', reason:`IV has dropped ${ivDrop.toFixed(0)}% since entry (${entryIv}% \u2192 ${curIv.toFixed(1)}%) \u2014 IV contraction works against long volatility positions even when the stock moves.` });
        }
      }

      // P2 #12: Straddle/Strangle — one leg up >100% (legging-out opportunity)
      if ((strat === 'Long Straddle' || strat === 'Long Strangle') && curOpt != null && entry > 0) {
        // curOpt for straddle/strangle is the combined value — individual leg not separately tracked.
        // If combined value is up >50% the position is working well overall.
        const combGainPct = ((parseFloat(curOpt) - entry) / entry) * 100;
        if (combGainPct >= 50)
          fa.push({ sev:'blue', reason:`Long volatility position up ${combGainPct.toFixed(0)}% \u2014 if one leg is driving most of the gain, legging out of that leg locks in profit while keeping the other leg open for a potential reversal.` });
      }

      if (!fa.length) return;
      fa.sort((a, b) => sevOrd[a.sev] - sevOrd[b.sev]);
      result.push({ type:'trade', trade, sev:fa[0].sev, reason:fa[0].reason, extras:fa.slice(1), dte, delta, pct, theoPnl, theoPnlIsEst });
    });

    // ════════════════════════════════════════════════════
    // SECTION 2 — Iron Condor / Butterfly chain alerts
    // ════════════════════════════════════════════════════
    Object.entries(icChainMap).forEach(([chainId, chainTrades]) => {
      const anchor    = chainTrades.find(t => (t.condor_seq||0) === 0) || chainTrades[0];
      const dte       = anchor.expiration ? Math.ceil((new Date(anchor.expiration) - new Date()) / 86400000) : null;
      const curStk    = parseFloat(currentPrices?.[anchor.id]?.stock || currentPrices?.[anchor.ticker?.toUpperCase()]?.stock);
      const maxCredit = chainTrades.filter(t => (t.condor_seq||0) === 0)
                                   .reduce((s, t) => s + (t.entry_price||0) * (t.contracts_original||t.contracts||1) * 100, 0);
      let realisedPnL = 0, unrealisedPnL = 0;
      chainTrades.forEach(t => {
        const cl = t.contracts_closed || 0;
        if (cl > 0 && t.exit_price != null) realisedPnL += (t.entry_price - t.exit_price) * cl * 100;
        realisedPnL += t.partial_close_pnl || 0;
        const oc = t.contracts_open || 0;
        if (oc > 0) { const cur = currentPrices?.[t.id]?.option; if (cur != null) unrealisedPnL += (t.entry_price - cur) * oc * 100; }
      });
      const totalPnL  = realisedPnL + unrealisedPnL;
      const putLeg    = chainTrades.filter(t => t.condor_leg === 'put'  && (t.contracts_open||0) > 0).sort((a,b) => (b.condor_seq||0)-(a.condor_seq||0))[0];
      const callLeg   = chainTrades.filter(t => t.condor_leg === 'call' && (t.contracts_open||0) > 0).sort((a,b) => (b.condor_seq||0)-(a.condor_seq||0))[0];
      const putShort  = parseFloat(putLeg?.strike_sell)  || 0;
      const callShort = parseFloat(callLeg?.strike_sell) || 0;
      const isIB  = anchor.strategy === 'Iron Butterfly';
      const fa = [];
      // Tier 1: DTE
      if (dte != null && dte <= 7)
        fa.push({ sev:'red',   reason:`${dte} DTE \u2014 IC expires imminently — position needs attention.` });
      else if (dte != null && dte <= 21)
        fa.push({ sev:'red',   reason:`${dte} DTE \u2014 gamma risk increases significantly inside 21 days.` });
      else if (dte != null && dte <= 30)
        fa.push({ sev:'amber', reason:`${dte} DTE \u2014 approaching the 21-day management window.` });
      // Tier 2: Wing breach / approach
      // IB uses wing-width proximity (tight profit tent); IC uses 5% of stock price
      const putWingWidth  = putLeg  ? Math.abs((parseFloat(putLeg.strike_sell)||0)  - (parseFloat(putLeg.strike_buy)||0))  : 0;
      const callWingWidth = callLeg ? Math.abs((parseFloat(callLeg.strike_sell)||0) - (parseFloat(callLeg.strike_buy)||0)) : 0;
      if (curStk) {
        if (putShort > 0 && curStk <= putShort)
          fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} has reached put short strike $${putShort} \u2014 the put wing is at risk.` });
        else if (putShort > 0) {
          if (isIB && putWingWidth > 0) {
            // IB: alert at 0.5× wing width from body (tight tent)
            if ((curStk - putShort) <= putWingWidth * 0.5)
              fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within half a wing-width of put short $${putShort} \u2014 ${anchor.ticker} is near the edge of the butterfly's profit tent.` });
            // IB: RED at 1× wing width from body
            if ((curStk - putShort) <= putWingWidth)
              fa.push({ sev:'red', reason:`Stock $${curStk.toFixed(2)} is within 1 wing-width of put short $${putShort} \u2014 the butterfly is at or near breakeven on the put side.` });
          } else if (!isIB && ((curStk - putShort) / curStk) * 100 < 5) {
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within 5% of put short $${putShort} \u2014 the spread is approaching its tested zone.` });
          }
        }
        if (callShort > 0 && curStk >= callShort)
          fa.push({ sev:'red',   reason:`Stock $${curStk.toFixed(2)} has reached call short strike $${callShort} \u2014 the call wing is at risk.` });
        else if (callShort > 0) {
          if (isIB && callWingWidth > 0) {
            if ((callShort - curStk) <= callWingWidth * 0.5)
              fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within half a wing-width of call short $${callShort} \u2014 ${anchor.ticker} is near the edge of the butterfly's profit tent.` });
            if ((callShort - curStk) <= callWingWidth)
              fa.push({ sev:'red', reason:`Stock $${curStk.toFixed(2)} is within 1 wing-width of call short $${callShort} \u2014 the butterfly is at or near breakeven on the call side.` });
          } else if (!isIB && ((callShort - curStk) / curStk) * 100 < 5) {
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is within 5% of call short $${callShort} \u2014 the spread is approaching its tested zone.` });
          }
        }
      }
      // P&L based
      if (maxCredit > 0) {
        const profitPct = (totalPnL / maxCredit) * 100;
        const lossPct   = (-totalPnL / maxCredit) * 100;
        if (profitPct >= 50)
          fa.push({ sev:'blue', reason:`IC at ${profitPct.toFixed(0)}% of max credit ($${totalPnL.toFixed(0)}) \u2014 position has reached 50% of max credit — a widely used exit point where reward-to-risk becomes less favourable.` });
        if (lossPct >= 200)
          fa.push({ sev:'red',  reason:`IC loss is ${lossPct.toFixed(0)}% of max credit \u2014 loss has reached 2\u00d7 the original credit \u2014 a common stop-loss level.` });
        else if (lossPct >= 100)
          fa.push({ sev:'amber',reason:`IC loss equals max credit \u2014 loss equals the original credit \u2014 a common stop-loss reference point.` });
      }
      // P2 #13: one wing fully closed — remaining position is a single credit spread
      if (!putLeg && callLeg)
        fa.push({ sev:'amber', reason:`Put wing is fully closed \u2014 the remaining open call spread has a different risk profile than the original ${isIB ? 'butterfly' : 'condor'}. Margin and delta are now based on the call spread alone.` });
      else if (putLeg && !callLeg)
        fa.push({ sev:'amber', reason:`Call wing is fully closed \u2014 the remaining open put spread has a different risk profile than the original ${isIB ? 'butterfly' : 'condor'}. Margin and delta are now based on the put spread alone.` });
      if (!fa.length) return;
      fa.sort((a, b) => sevOrd[a.sev] - sevOrd[b.sev]);
      result.push({ type:'ic_chain', chainId, chainTrades, anchor, sev:fa[0].sev, reason:fa[0].reason, extras:fa.slice(1), dte, totalPnL, maxCredit });
    });

    // ════════════════════════════════════════════════════
    // SECTION 3 — Calendar / Diagonal chain alerts
    // ════════════════════════════════════════════════════
    Object.entries(calChainMap).forEach(([chainId, chainTrades]) => {
      const shortLeg = chainTrades.filter(t => t.cal_leg === 'short' && t.status === 'open').sort((a,b) => (b.cal_seq||0)-(a.cal_seq||0))[0];
      const anchor   = [...chainTrades].sort((a,b) => (a.cal_seq||0)-(b.cal_seq||0))[0];
      if (!shortLeg) return;
      const frontDte    = shortLeg.expiration ? Math.ceil((new Date(shortLeg.expiration) - new Date()) / 86400000) : null;
      const curStk      = parseFloat(currentPrices?.[anchor.id]?.stock || currentPrices?.[anchor.ticker?.toUpperCase()]?.stock);
      const curIv       = currentPrices?.[shortLeg.id]?.iv;
      const realisedPnL = chainTrades.reduce((s, t) => s + (t.pnl || 0), 0);
      const netDebit    = chainTrades.reduce((s, t) => {
        const paid = t.cal_leg === 'long' ? (t.entry_price||0) : -(t.entry_price||0);
        const recv = t.status === 'closed' && t.exit_price != null
          ? (t.cal_leg === 'short' ? -(t.exit_price||0) : (t.exit_price||0)) : 0;
        return s + (paid + recv) * (t.contracts||1) * 100;
      }, 0);
      const fa = [];
      // Tier 1: Front month DTE
      if (frontDte != null && frontDte <= 7)
        fa.push({ sev:'red',   reason:`Front month expires in ${frontDte} day${frontDte!==1?'s':''} \u2014 short leg is in its final days — gamma whipsaw risk is elevated.` });
      else if (frontDte != null && frontDte <= 14)
        fa.push({ sev:'amber', reason:`Front month ${frontDte} DTE \u2014 many traders roll the short leg with 5\u20137 days remaining.` });
      else if (frontDte != null && frontDte <= 21)
        fa.push({ sev:'amber', reason:`Front month ${frontDte} DTE \u2014 typical window to plan the next cycle roll.` });
      // P1 #3: Short leg ITM — assignment risk (uses option_type now available)
      if (curStk && shortLeg && shortLeg.status === 'open') {
        const shortStrike = parseFloat(shortLeg.strike_sell) || 0;
        const optType = shortLeg.option_type || anchor.option_type || null;
        if (shortStrike > 0 && optType) {
          const isCallCal = optType === 'call';
          if (isCallCal && curStk >= shortStrike)
            fa.push({ sev:'red', reason:`Stock $${curStk.toFixed(2)} is at or above the short call strike $${shortStrike} \u2014 short leg is in-the-money. Early assignment is possible on American-style options.` });
          else if (!isCallCal && curStk <= shortStrike)
            fa.push({ sev:'red', reason:`Stock $${curStk.toFixed(2)} is at or below the short put strike $${shortStrike} \u2014 short leg is in-the-money. Early assignment is possible.` });
        }
      }

      // P1 #6: Back month (long leg) < 45 DTE — long protection eroding
      const longLegOpen = chainTrades.filter(t => t.cal_leg === 'long' && t.status === 'open')
                                     .sort((a,b) => (b.cal_seq||0)-(a.cal_seq||0))[0];
      if (longLegOpen) {
        const longExpiry = longLegOpen.expiration_back || longLegOpen.expiration;
        if (longExpiry) {
          const longDte = Math.ceil((new Date(longExpiry) - new Date()) / 86400000);
          if (longDte > 0 && longDte < 45)
            fa.push({ sev:'amber', reason:`Back month expires in ${longDte} days \u2014 when the long leg has less than 45 days of time value remaining, the calendar's vega edge begins to erode.` });
        }
      }

      // P1 #7: Diagonal — short leg recently expired worthless (workflow trigger)
      if (anchor.strategy === 'Diagonal Spread') {
        const latestShortClosed = chainTrades
          .filter(t => t.cal_leg === 'short' && t.status === 'closed')
          .sort((a,b) => (b.cal_seq||0)-(a.cal_seq||0))[0];
        const hasOpenShort = chainTrades.some(t => t.cal_leg === 'short' && t.status === 'open');
        const hasOpenLong  = chainTrades.some(t => t.cal_leg === 'long'  && t.status === 'open');
        if (!hasOpenShort && hasOpenLong && latestShortClosed) {
          const exitPx = parseFloat(latestShortClosed.exit_price) || 0;
          if (exitPx < 0.10) // expired near-worthless
            fa.push({ sev:'blue', reason:`Short leg expired near-worthless \u2014 the long back-month anchor is still open. A new short leg can be sold to restart premium collection.` });
        }
      }

      // Tier 2: Tent off-centre (>1 SD from strike)
      if (curStk && shortLeg) {
        const strike = parseFloat(shortLeg.strike_sell || shortLeg.strike_buy) || 0;
        if (strike > 0) {
          const iv   = (curIv || shortLeg.iv_entry || 25) / 100;
          const T    = Math.max(0.001, (frontDte || 30) / 365);
          const oneSD = strike * iv * Math.sqrt(T);
          if (Math.abs(curStk - strike) >= oneSD) {
            const dir = curStk > strike ? 'above' : 'below';
            fa.push({ sev:'amber', reason:`Stock $${curStk.toFixed(2)} is >1 SD ${dir} $${strike} strike \u2014 stock is more than 1 standard deviation from the calendar strike — the profit tent is off-centre.` });
          }
        }
      }
      // Tier 2: IV crush
      if (curIv && shortLeg?.iv_entry) {
        const ivDrop = ((shortLeg.iv_entry - curIv) / shortLeg.iv_entry) * 100;
        if (ivDrop >= 25)
          fa.push({ sev:'amber', reason:`IV dropped ${ivDrop.toFixed(0)}% since entry (${shortLeg.iv_entry}% → ${curIv.toFixed(1)}%) \u2014 IV has fallen significantly since entry — lower IV reduces the calendar's vega edge.` });
        // P2 #14: IV spike — vega expansion is helping but creates mean-reversion risk
        const ivRise = ((curIv - shortLeg.iv_entry) / shortLeg.iv_entry) * 100;
        if (ivRise >= 40)
          fa.push({ sev:'amber', reason:`IV has risen ${ivRise.toFixed(0)}% since entry (${shortLeg.iv_entry}% \u2192 ${curIv.toFixed(1)}%) \u2014 vega expansion is benefiting the calendar. Closing into an IV spike locks in the vega gain before a potential reversion.` });
      }
      // Profit target: 20% of net debit
      if (netDebit < 0 && realisedPnL > 0) {
        const profitPct = (realisedPnL / Math.abs(netDebit)) * 100;
        if (profitPct >= 20)
          fa.push({ sev:'blue', reason:`Calendar at ${profitPct.toFixed(0)}% return on net debit \u2014 position has reached the SteadyOptions 20\u201330% return-on-debit target.` });
      }
      if (!fa.length) return;
      fa.sort((a, b) => sevOrd[a.sev] - sevOrd[b.sev]);
      result.push({ type:'cal_chain', chainId, chainTrades, anchor, sev:fa[0].sev, reason:fa[0].reason, extras:fa.slice(1), dte:frontDte, realisedPnL, netDebit });
    });

    return result.sort((a, b) => sevOrd[a.sev] - sevOrd[b.sev]);
  }, [standaloneTrades, icChainMap, calChainMap, currentPrices]);


  const sevColor = s => s === 'red' ? 'var(--red)' : s === 'amber' ? 'var(--amber)' : 'var(--blue)';
  const sevBg    = s => s === 'red' ? 'var(--red-bg)' : s === 'amber' ? 'var(--amber-bg)' : 'var(--blue-bg)';
  const fmtPnl   = v => v == null ? '—' : `${v >= 0 ? '+' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  const monoS    = { fontFamily: 'var(--font-mono)' };

  const urgentCount    = alerts.filter(a => a.sev === 'red').length;
  const watchCount     = alerts.filter(a => a.sev === 'amber').length;
  const takeProfitCount = alerts.filter(a => a.sev === 'blue').length;

  return (
    <div>
      {/* Context nav strip — shown only when navigated from Stock Positions */}
      {alertsFrom === 'positions' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '8px 16px', marginBottom: 8,
          background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
          fontSize: 12,
        }}>
          <button
            onClick={onBackToPositions}
            style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12,
              background: 'none', border: '1px solid var(--border)', borderRadius: 6,
              padding: '4px 10px', cursor: 'pointer', color: 'var(--text-secondary)',
              fontWeight: 600 }}>
            ← Stock Positions
          </button>
          <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
            Review alerts below, then act in Trade Log (Roll / Close / Expired)
          </span>
          <button
            onClick={onGoToTradeLog}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5,
              fontSize: 12, background: 'var(--blue-bg)', border: '1px solid var(--blue-border,#b5d4f4)',
              borderRadius: 6, padding: '4px 10px', cursor: 'pointer',
              color: 'var(--blue)', fontWeight: 600 }}>
            Open Trade Log →
          </button>
        </div>
      )}
      {/* Page header */}
      <div className="page-header">
        <div className="page-header-left">
          <h2>⚡ Alerts &amp; Insights</h2>
          {pill}
          <div className="subtitle">
            {openTrades.length} open positions monitored
            {' '}({Object.keys(icChainMap).length} IC chain{Object.keys(icChainMap).length!==1?'s':''} · {Object.keys(calChainMap).length} cal chain{Object.keys(calChainMap).length!==1?'s':''})
            {alerts.length > 0 && ` · ${alerts.length} need attention`}
          </div>
        </div>
      </div>

      {/* Summary badges */}
      {alerts.length > 0 && (
        <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
          {urgentCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--red-bg)', border: '1px solid var(--red-border)',
              borderRadius: 20, fontSize: 12, fontWeight: 700, color: 'var(--red)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--red)', display: 'inline-block', boxShadow: '0 0 6px var(--red)' }} />
              {urgentCount} urgent
            </div>
          )}
          {watchCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--amber-bg)', border: '1px solid var(--amber-border)',
              borderRadius: 20, fontSize: 12, fontWeight: 700, color: 'var(--amber)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--amber)', display: 'inline-block' }} />
              {watchCount} watch
            </div>
          )}
          {takeProfitCount > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px',
              background: 'var(--blue-bg)', border: '1px solid var(--blue-border)',
              borderRadius: 20, fontSize: 12, fontWeight: 700, color: 'var(--blue)' }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--blue)', display: 'inline-block' }} />
              {takeProfitCount} take-profit
            </div>
          )}
        </div>
      )}

      {/* Main content */}
      {alerts.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '64px 24px', gap: 12, textAlign: 'center' }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: 'var(--text-primary)' }}>All positions healthy</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 360, lineHeight: 1.6 }}>
            No open positions require immediate attention. Alerts appear here when positions are close to expiry, have high delta, or have reached a profit target.
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'hidden', border: '1px solid var(--border)' }}>
          <div style={{ padding: '10px 16px', background: 'var(--surface)', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, fontWeight: 700 }}>
            <span>⚡</span>
            <span>Alerts &amp; Actionable Insights Monitor</span>
          </div>

          {/* No prices note — shown when Yahoo hasn't been fetched */}
          {openTrades.length > 0 && Object.keys(currentPrices || {}).length === 0 && (
            <div style={{ padding:'10px 16px', background:'var(--blue-bg)', borderBottom:'1px solid var(--blue-border)', fontSize:11.5, color:'var(--blue)' }}>
              ℹ️ <strong>Price-based alerts unavailable.</strong> Click "Fetch Yahoo Prices" in Trade Log to enable strike-breach, profit-target, and stop-loss alerts. DTE and delta alerts are always active.
            </div>
          )}

          {alerts.map((alert) => {
            const { sev, reason, extras } = alert;
            const isChain  = alert.type === 'ic_chain' || alert.type === 'cal_chain';
            const trade    = alert.trade || alert.anchor;
            const alertKey = isChain ? `${alert.type}_${alert.chainId}` : String(trade?.id);
            const isExp    = expanded[alertKey];
            const dte      = alert.dte;
            const theoPnl  = alert.theoPnl;
            const theoPnlIsEst = alert.theoPnlIsEst;
            const strat    = trade?.strategy || '';

            // Strategy classification for panel type
            const isCC_CSP    = strat === 'Covered Call' || strat === 'Cash-Secured Put';
            const isBPS_BCS   = strat === 'Bull Put Spread' || strat === 'Bear Call Spread';
            const isGuidance  = !isChain && !isCC_CSP && !isBPS_BCS;
            const showPanel   = !isChain;

            // Button label per strategy
            const btnLabel = isCC_CSP  ? '💡 Roll Scenarios' :
                             isBPS_BCS ? '📋 Management Options' :
                             isGuidance ? '💡 Guidance' : null;

            // Data for panels
            const curStkRaw = currentPrices?.[trade?.id]?.stock || currentPrices?.[trade?.ticker?.toUpperCase()]?.stock;
            const curStk    = curStkRaw ? parseFloat(curStkRaw) : null;
            const curIv     = currentPrices?.[trade?.id]?.iv || null;

            // CC/CSP: build 4 roll scenarios — ONLY when we have a real live stock price.
            // Persona 1 rule: BSM with strike*0.98 proxy + stale entry IV is worse than
            // useless — it looks authoritative but the numbers are unreliable.
            // Trader who needs scenarios must refresh prices in Trade Log first.
            const scenarios = (isCC_CSP && isExp && trade && curStk != null)
              ? buildRollScenarios(trade, curStk, dte, curIv)
              : null;

            // BPS/BCS: compute spread close cost (both legs via BS)
            const spreadClose = (isBPS_BCS && isExp && trade && curStk) ? (() => {
              const ssRaw = parseFloat(trade.strike_sell);
              const sbRaw = parseFloat(trade.strike_buy);
              const iv    = curIv || trade.iv_entry || 30;
              const d     = Math.max(dte || 1, 1);
              const isCS  = strat === 'Bear Call Spread'; // sells call
              // Short leg (strike_sell): we are short this option
              const shortPx = bsApprox(curStk, ssRaw, d, iv, isCS);
              // Long leg (strike_buy): we are long this option
              const longPx  = bsApprox(curStk, sbRaw, d, iv, isCS);
              if (!shortPx || !longPx) return null;
              const shortCost = Math.round(shortPx * 100) / 100;  // cost to buy back
              const longProcd = Math.round(longPx  * 100) / 100;  // proceeds from selling
              const netCost   = Math.round((shortCost - longProcd) * (trade.contracts||1) * 100);
              const entryCredit = (trade.entry_price||0) * (trade.contracts||1) * 100;
              const closePnl    = Math.round(entryCredit - netCost);
              return { shortCost, longProcd, netCost, closePnl, isEstimated: true };
            })() : null;

            // Guidance card for Long/debit strategies
            const guidance = (isGuidance && isExp && trade)
              ? buildGuidanceCard(trade, theoPnl)
              : null;

            // Chain type label
            const chainLabel = alert.type === 'ic_chain'
              ? `IC Chain #${alert.chainId} \u00b7 ${alert.chainTrades?.length} legs`
              : alert.type === 'cal_chain'
              ? `Cal Chain #${alert.chainId} \u00b7 ${alert.chainTrades?.length} legs`
              : null;

            return (
              <div key={alertKey}>
                {/* Alert header row */}
                <div style={{
                  display: 'grid', gridTemplateColumns: 'auto 1fr auto auto',
                  gap: 10, alignItems: 'center', padding: '11px 16px',
                  background: isExp ? sevBg(sev) + '44' : 'transparent',
                  borderBottom: isExp ? 'none' : '1px solid var(--border)',
                  transition: 'background 0.15s',
                }}>
                  <span style={{ width:9, height:9, borderRadius:'50%', background:sevColor(sev), display:'inline-block', boxShadow:`0 0 6px ${sevColor(sev)}`, flexShrink:0 }} />
                  <span style={{ fontSize:13 }}>
                    <strong style={{ color:'var(--text-primary)', fontFamily:'var(--font-mono)' }}>{trade?.ticker}</strong>
                    <span style={{ color:'var(--text-muted)', marginLeft:6, fontSize:12 }}>
                      {chainLabel || strat}
                    </span>
                    <span style={{ color:'var(--text-secondary)', marginLeft:10 }}>{reason}</span>
                    {extras?.length > 0 && extras.map((ex, i) => (
                      <span key={i} style={{ display:'block', fontSize:11, color:'var(--text-muted)', marginLeft:16, marginTop:2 }}>
                        <span style={{ color:sevColor(ex.sev), fontWeight:600, marginRight:4 }}>{ex.sev==='red'?'●':ex.sev==='amber'?'◐':'○'}</span>
                        {ex.reason}
                      </span>
                    ))}
                  </span>
                  {theoPnl != null && (
                    <span style={{ ...monoS, fontWeight:700, fontSize:12, color:theoPnl>=0?'var(--green)':'var(--red)', opacity:theoPnlIsEst?0.8:1 }}
                      title={theoPnlIsEst ? 'BS estimate — enter option price for exact value' : undefined}>
                      {fmtPnl(theoPnl)}{theoPnlIsEst && <span style={{ fontSize:9, color:'var(--amber)', marginLeft:3 }}>est.</span>}
                    </span>
                  )}
                  {showPanel && btnLabel ? (
                    <button
                      onClick={() => setExpanded(e => ({ ...e, [alertKey]: !e[alertKey] }))}
                      style={{
                        fontSize:10, padding:'4px 12px',
                        background: isExp ? 'var(--accent)' : 'var(--accent-light)',
                        color: isExp ? '#fff' : 'var(--accent)',
                        border:'1px solid var(--accent-border)', borderRadius:4,
                        cursor:'pointer', fontFamily:'var(--font-mono)', fontWeight:600,
                        whiteSpace:'nowrap',
                      }}>
                      {isExp ? '\u25be Hide' : btnLabel}
                    </button>
                  ) : (
                    <span style={{ fontSize:11, color:'var(--text-muted)', fontStyle:'italic' }}>
                      {isChain ? 'Manage in Trade Log' : ''}
                    </span>
                  )}
                </div>

                {/* ── CC / CSP: no live price — prompt to refresh ── */}
                {isExp && isCC_CSP && !curStk && (
                  <div style={{ padding:'12px 16px', background:'var(--amber-bg,#fffbe6)',
                    borderBottom:'1px solid var(--border)',
                    display:'flex', alignItems:'center', gap:10 }}>
                    <span style={{ fontSize:14 }}>⚠</span>
                    <span style={{ fontSize:12, color:'var(--amber,#92600a)' }}>
                      <strong>Roll scenarios need a live price.</strong>{' '}
                      Go to Trade Log and click <strong>⟳ Refresh Prices</strong> to load current quotes,
                      then return here for accurate roll numbers.
                    </span>
                  </div>
                )}

                {/* ── CC / CSP: 4 Roll Scenario Cards ────────────────── */}
                {isExp && scenarios && (
                  <div style={{ padding:'16px 16px 14px', background:sevBg(sev)+'28', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ marginBottom:12 }}>
                      <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:4 }}>
                        Roll scenarios for <span style={{ fontFamily:'var(--font-mono)', color:sevColor(sev) }}>{trade.ticker}</span>
                        {scenarios[0]?.isEstimated && <span style={{ fontSize:10, color:'var(--amber)', marginLeft:8, fontWeight:400 }}>est. — no live stock price</span>}
                      </div>
                      <div style={{ fontSize:11, color:'var(--text-muted)', lineHeight:1.6 }}>
                        <strong>Golden rule:</strong> only roll for a net credit.
                        Click <strong>Execute this roll →</strong> to open the Roll form pre-filled.
                        {' '}Premiums via Black-Scholes · IV {curIv ? `${curIv.toFixed(1)}% (live)` : `${trade.iv_entry ?? '~35'}% (entry)`} · r=5.3%
                      </div>
                      {(curIv || trade.iv_entry || 0) > 60 && (
                        <div style={{
                          marginTop: 8, padding: '6px 10px',
                          borderRadius: 6,
                          background: 'var(--amber-bg, #fffbe6)',
                          border: '1px solid var(--amber-border, #f0d898)',
                          fontSize: 10, color: 'var(--amber, #92600a)',
                          display: 'flex', alignItems: 'flex-start', gap: 6,
                        }}>
                          <span style={{ fontWeight: 700, flexShrink: 0 }}>⚠ High IV ({(curIv || trade.iv_entry || 0).toFixed(0)}%)</span>
                          <span>— these strikes look wide because the market expects {trade.ticker} to move a lot. Check your broker&apos;s option chain and pick a strike with a real bid before using these suggestions.</span>
                        </div>
                      )}
                    </div>
                    <div style={{ display:'grid', gridTemplateColumns:'repeat(4, 1fr)', gap:8 }}>
                      {scenarios.map((s, si) => {
                        const isDebit = s.netCredit != null && s.netCredit < 0;
                        return (
                          <div key={si} style={{
                            border: s.isRecommended ? '2px solid var(--blue)' : isDebit ? '1px solid var(--red-border)' : '1px solid var(--border)',
                            borderRadius:8, padding:'9px 10px',
                            background: s.isRecommended ? 'var(--blue-bg)' : isDebit ? 'var(--red-bg)' : 'var(--surface)',
                            fontSize:11,
                          }}>
                            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:5 }}>
                              <span style={{ width:18, height:18, borderRadius:'50%', flexShrink:0, background:s.isRecommended?'var(--blue)':sevColor(sev), color:'#fff', fontSize:9, fontWeight:800, display:'flex', alignItems:'center', justifyContent:'center' }}>{si+1}</span>
                              <div>
                                <div style={{ fontWeight:700, fontSize:11 }}>{s.label}</div>
                                {s.isRecommended && <div style={{ fontSize:8, fontWeight:700, color:'var(--blue)', textTransform:'uppercase' }}>\u2605 Recommended</div>}
                              </div>
                            </div>
                            {!s.isClose && (<>
                              {s.newExpiry && (
                                <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                                  <span style={{ color:'var(--text-muted)', fontSize:10 }}>New expiry</span>
                                  <span style={{ fontFamily:'var(--font-mono)', fontSize:10, fontWeight:600, color:'var(--text-primary)' }}>{s.newExpiry}</span>
                                </div>
                              )}
                              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                                <span style={{ color:'var(--text-muted)', fontSize:10 }}>Net credit</span>
                                <span style={{ ...monoS, fontWeight:700, fontSize:10, color:isDebit?'var(--red)':'var(--green)' }}>
                                  {s.netCredit!=null?(s.netCredit>=0?'+':'')+'$'+s.netCredit.toFixed(2):'—'}
                                </span>
                              </div>
                              <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                                <span style={{ color:'var(--text-muted)', fontSize:10 }}>New premium</span>
                                <span style={{ ...monoS, fontSize:10 }}>{s.newPremium!=null?'$'+s.newPremium.toFixed(2):'—'}</span>
                              </div>
                            </>)}
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:5 }}>
                              <span style={{ color:'var(--text-muted)', fontSize:10 }}>Combined P&L</span>
                              <span style={{ ...monoS, fontWeight:700, fontSize:10, color:(s.combinedPnl||0)>=0?'var(--green)':'var(--red)' }}>{fmtPnl(s.combinedPnl)}</span>
                            </div>
                            {isDebit && <div style={{ fontSize:9, color:'var(--red)', fontWeight:700, marginBottom:3 }}>\u26a0 Net debit \u2014 golden rule violated</div>}
                            <div style={{ fontSize:10, color:'var(--text-secondary)', lineHeight:1.4, marginBottom:5 }}>{s.rationale}</div>
                            {!s.isClose && s.newBreakeven && (
                              <div style={{ fontSize:9, color:'var(--text-muted)', marginBottom:4 }}>
                                Breakeven: ${s.newBreakeven?.toFixed(2)} \u00b7 \u0394 {s.newDelta}
                              </div>
                            )}
                            <button onClick={() => {
                              if (s.isClose) {
                                // Close position — open CloseTrade modal via parent
                                if (onCloseTradeprop) onCloseTradeprop(trade);
                                else if (onGoToTradeLog) onGoToTradeLog();
                              } else {
                                // Roll — navigate to TradeLog and open Roll Modal
                                onRoll(trade);
                              }
                            }} style={{ width:'100%', padding:'3px 0', fontSize:9, fontFamily:'var(--font-mono)', fontWeight:600, background:s.isClose?'var(--surface2)':s.isRecommended?'var(--blue)':'var(--surface2)', color:s.isClose?'var(--text-secondary)':s.isRecommended?'#fff':'var(--text-secondary)', border:'none', borderRadius:4, cursor:'pointer' }}>
                              {s.isClose ? 'Close position →' : 'Execute this roll →'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* ── BPS / BCS: Spread close card + guidance ──────────── */}
                {isExp && isBPS_BCS && (
                  <div style={{ padding:'14px 16px', background:sevBg(sev)+'28', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:8 }}>
                      Management options for <span style={{ fontFamily:'var(--font-mono)', color:sevColor(sev) }}>{trade.ticker}</span> {strat}
                    </div>
                    {spreadClose ? (
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:12 }}>
                        <div style={{ border:'1px solid var(--border)', borderRadius:8, padding:'10px 12px', background:'var(--surface)' }}>
                          <div style={{ fontWeight:700, fontSize:12, marginBottom:6 }}>Close entire spread</div>
                          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:2 }}>
                            <span style={{ color:'var(--text-muted)', fontSize:11 }}>Buy back short leg</span>
                            <span style={{ ...monoS, fontSize:11 }}>${spreadClose.shortCost.toFixed(2)}</span>
                          </div>
                          <div style={{ display:'flex', justifyContent:'space-between', marginBottom:4 }}>
                            <span style={{ color:'var(--text-muted)', fontSize:11 }}>Sell long leg</span>
                            <span style={{ ...monoS, fontSize:11 }}>${spreadClose.longProcd.toFixed(2)}</span>
                          </div>
                          <div style={{ display:'flex', justifyContent:'space-between', borderTop:'1px solid var(--border)', paddingTop:4 }}>
                            <span style={{ fontWeight:700, fontSize:11 }}>P&L if closed now</span>
                            <span style={{ ...monoS, fontWeight:700, fontSize:12, color:spreadClose.closePnl>=0?'var(--green)':'var(--red)' }}>{fmtPnl(spreadClose.closePnl)}</span>
                          </div>
                          <div style={{ fontSize:9, color:'var(--amber)', marginTop:4 }}>est. \u2014 BS approximation</div>
                        </div>
                        <div style={{ border:'1px solid var(--blue-border)', borderRadius:8, padding:'10px 12px', background:'var(--blue-bg)', fontSize:11 }}>
                          <div style={{ fontWeight:700, fontSize:12, color:'var(--blue)', marginBottom:6 }}>Roll spread out?</div>
                          <div style={{ color:'var(--text-secondary)', lineHeight:1.5 }}>
                            Rolling a credit spread means closing both legs and reopening at a later expiry. Only roll if you can collect a net credit. Use the Roll button in Trade Log to pre-fill the form.
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div style={{ fontSize:12, color:'var(--text-muted)', marginBottom:10 }}>
                        Fetch Yahoo or MarketData.app prices to see estimated close cost.
                      </div>
                    )}
                    <div style={{ fontSize:11, color:'var(--text-secondary)', lineHeight:1.6, background:'var(--bg-hover)', borderRadius:6, padding:'8px 10px' }}>
                      <strong>Rule:</strong> At 50%+ profit on a credit spread, close it — the remaining risk outweighs the remaining reward. Rolling a credit spread is only worth it if the roll collects a net credit AND moves strikes further OTM.
                    </div>
                  </div>
                )}

                {/* ── Guidance-only: Long options, debit spreads ────────── */}
                {isExp && isGuidance && guidance && (
                  <div style={{ padding:'14px 16px', background:sevBg(sev)+'28', borderBottom:'1px solid var(--border)' }}>
                    <div style={{ fontSize:12, fontWeight:700, color:'var(--text-primary)', marginBottom:6 }}>{guidance.title}</div>
                    <div style={{ fontSize:11.5, color:'var(--text-secondary)', lineHeight:1.6 }}>{guidance.body}</div>
                    {guidance.action === 'profit' && (
                      <div style={{ marginTop:8, fontSize:11, color:'var(--green)', fontWeight:600 }}>
                        \u2713 Consider closing to lock in gains
                      </div>
                    )}
                    {guidance.action === 'close' && (
                      <div style={{ marginTop:8, fontSize:11, color:'var(--red)', fontWeight:600 }}>
                        \u26a0 Consider cutting the loss — time is working against you
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
