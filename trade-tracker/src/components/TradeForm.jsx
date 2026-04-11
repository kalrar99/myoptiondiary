// src/components/TradeForm.jsx  — v2 with full trader-grade validation
//
// ═══════════════════════════════════════════════════════════════════════════
// VALIDATION RULES (options trader analysis):
//
// DATE RULES
//   D1. Entry date is required and must not be in the future
//   D2. Expiration is required for all strategies
//   D3. Expiration must be after entry date (you can't enter after it expires)
//   D4. Expiration must be in the future for open trades
//   D5. Exit/close date is required when status = closed
//   D6. Exit date must be ≤ expiration (can't exit after it expires — except assignment edge case)
//   D7. Exit date must be ≥ entry date
//
// PRICE RULES
//   P1. Entry price is required and must be > 0 (you always pay/receive premium)
//   P2. Exit price required when status = closed
//   P3. Option price (entry or exit) must be < underlying stock price (sanity cap)
//   P4. Exit price must be ≥ 0 (an option can expire at $0 but never negative)
//   P5. For credit strategies: entry price should typically be > exit price (you want decay)
//       — warn if exit > entry × 3 (losing more than 3× the credit is unusual)
//   P6. For debit strategies: exit price can be higher or lower than entry
//   P7. Contracts must be ≥ 1
//
// STRIKE RULES
//   S1. Covered Call: sell strike required; must be > 0
//   S2. Cash-Secured Put: buy strike required; must be > 0
//   S3. Spreads (BPS/BCS/IC/IB/BCS/BPS): both buy AND sell strikes required
//   S4. Bull Put Spread: sell strike must be > buy strike (sell the higher put)
//   S5. Bear Call Spread: buy strike must be > sell strike (buy the higher call)
//   S6. Bull Call Spread: sell strike must be > buy strike (sell the higher call)
//   S7. Bear Put Spread: buy strike must be > sell strike (buy the higher put)
//   S8. Iron Condor / Iron Butterfly: both strikes required (put side buy/sell)
//   S9. Long Call / Long Put: buy strike required only
//   S10. For CC: sell strike must be ≥ stock price (otherwise deep ITM CC is suspect)
//        — warn if strike_sell < avg_cost of linked lot (selling below cost basis locks in a loss)
//
// LOT RULES
//   L1. Covered Call: should link to an open stock lot of the same ticker
//       — warn (not block) if no lot is linked (naked call would be a different product)
//   L2. Cash-Secured Put: lot_id should be null for new CSP (lot created on assignment)
//   L3. Pure spreads (BPS/BCS/IC/IB): lot_id must be null
//   L4. Long Call / Long Put: lot_id should be null
//
// GREEKS RULES
//   G1. Delta for short strategies (CC/CSP/short spreads) must be negative (−)
//   G2. Delta for long strategies (LC/LP) must be positive (+)
//   G3. Delta magnitude must be between 0 and 1 (|delta| ≤ 1.0)
//   G4. Gamma must be > 0
//   G5. Theta for premium-selling strategies must be negative (time decay helps seller)
//   G6. Vega must be > 0
//   G7. IV must be between 1% and 500%
//
// P&L RULES
//   R1. P&L field only makes sense when status = closed; warn if filled for open trade
//   R2. Compute expected P&L from prices and warn if manual entry differs by > $5
// ═══════════════════════════════════════════════════════════════════════════

import React, { useState, useEffect, useMemo } from 'react';
import ExpiryDatePicker from './ExpiryDatePicker';
import { expiryAhead, bsmPrice, bsmDelta, bsmTheta, DEFAULT_RISK_FREE_RATE } from '../utils/tradingCalendar';

const STRATEGIES = [
  'Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread',
  'Iron Condor','Iron Butterfly','Long Call','Long Put',
  'Bull Call Spread','Bear Put Spread','Long Straddle','Long Strangle',
  'Calendar Spread','Diagonal Spread',
];

const CREDIT_STRATS  = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly']);
const SPREAD_STRATS  = new Set(['Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread','Bear Put Spread']);
const NO_LOT_STRATS  = new Set(['Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread','Bear Put Spread','Long Call','Long Put','Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread']);
const LONG_STRATS    = new Set(['Long Call','Long Put','Long Straddle','Long Strangle','Bull Call Spread','Bear Put Spread','Calendar Spread','Diagonal Spread']);

function today() { const d=new Date(),yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; }

// ── Validation engine ──────────────────────────────────────────────────────
function validate(form, lots, isBrokerConnected = false, currentPrices = {}, trades = [], initial = null, historicalMode = false) {
  const errors   = {};  // field → error string (blocks submit)
  const warnings = {};  // field → warning string (shows but allows submit)

  const strategy  = form.strategy;
  const status    = form.status;
  const isOpen    = status === 'open';
  const isClosed  = status === 'closed';
  const isCredit  = CREDIT_STRATS.has(strategy);
  const isSpread  = SPREAD_STRATS.has(strategy);
  const noLot     = NO_LOT_STRATS.has(strategy);
  const isLong    = LONG_STRATS.has(strategy);
  const isCC      = strategy === 'Covered Call';
  const isCSP     = strategy === 'Cash-Secured Put';

  const entryDate  = form.entry_date;
  const expiry     = form.expiration;
  const exitDate   = form.exit_date;
  const entryPrice = parseFloat(form.entry_price);
  const exitPrice  = parseFloat(form.exit_price);
  const strikeBuy  = parseFloat(form.strike_buy);
  const strikeSell = parseFloat(form.strike_sell);
  const contracts  = parseInt(form.contracts);
  const lotId      = form.lot_id ? parseInt(form.lot_id) : null;
  const td         = today();
  // Spot price — used for ITM/premium sanity checks
  const ticker     = form.ticker?.trim().toUpperCase() || '';
  const spot       = parseFloat(currentPrices[ticker]?.stock) || 0;

  // ── Ticker ──
  if (!ticker)                                       errors.ticker      = 'Ticker is required.';
  if (!entryDate)                                  errors.entry_date  = 'Entry date is required.';
  else if (entryDate > td)                         errors.entry_date  = 'Entry date cannot be in the future.';

  if (!expiry)                                     errors.expiration  = 'Expiration date is required.';
  // Calendar/Diagonal: back month expiry required and must be after front month
  if (['Calendar Spread','Diagonal Spread'].includes(strategy)) {
    if (!form.expiration_back)                     errors.expiration_back = 'Back month expiry is required for Calendar/Diagonal spreads.';
    else if (form.expiration_back <= (expiry || '')) errors.expiration_back = 'Back month expiry must be after the front month expiry.';
    if (!historicalMode && isOpen && expiry && expiry < td) errors.expiration = 'Front month (short leg) expiry is in the past. This trade is already expired — change status to Closed or correct the date.';
    // option_type (call/put) is required — determines direction, alerts, and price fetching
    if (!form.option_type || !['call','put'].includes(form.option_type))
      errors.option_type = 'Select whether this is a call or put calendar/diagonal.';
  }
  else {
    if (entryDate && expiry <= entryDate)          errors.expiration  = 'Expiration must be after entry date.';
    if (!historicalMode && isOpen && expiry < td) errors.expiration = 'An open trade cannot have a past expiration. Either close the trade or correct the date.';
  }

  if (isClosed) {
    if (!exitDate)                                 errors.exit_date   = 'Exit/close date is required for closed trades.';
    else {
      if (entryDate && exitDate < entryDate)       errors.exit_date   = 'Exit date cannot be before entry date.';
      if (expiry && exitDate > expiry)             errors.exit_date   = 'Exit date cannot be after expiration. (Use the Assigned or Called Away buttons for assignment events.)';
    }
  }

  // ── Price rules ──
  // IC: entry_price computed from put_credit+call_credit in submit() — not a form field
  // IC/IB: computed from put_credit+call_credit. Cal/Diagonal: computed from cal_long_cost−cal_short_credit. Both excluded here.
  if (strategy !== 'Iron Condor' && strategy !== 'Iron Butterfly' &&
      strategy !== 'Calendar Spread' && strategy !== 'Diagonal Spread' &&
      (!form.entry_price || isNaN(entryPrice) || entryPrice <= 0))
                                                   errors.entry_price = 'Entry price is required and must be greater than $0.';
  if (isClosed) {
    if (form.exit_price === '' || form.exit_price == null || isNaN(exitPrice))
                                                   errors.exit_price  = 'Exit/buyback price is required for closed trades.';
    else if (exitPrice < 0)                        errors.exit_price  = 'Exit price cannot be negative.';
    else if (isCredit && exitPrice > entryPrice * 3 && entryPrice > 0)
                                                   warnings.exit_price = `Exit price ($${exitPrice}) is more than 3× the credit ($${entryPrice}). Verify — this is an unusually large loss.`;
  }
  if (isNaN(contracts) || contracts < 1)           errors.contracts   = 'Contracts must be at least 1.';

  // ── Strike rules ──
  if (isCC && (!form.strike_sell || isNaN(strikeSell) || strikeSell <= 0))
                                                   errors.strike_sell = 'Covered Calls require a sell strike price.';
  if (isCSP && (!form.strike_buy || isNaN(strikeBuy) || strikeBuy <= 0))
                                                   errors.strike_buy  = 'Cash-Secured Puts require a buy (put) strike price.';

  if (isSpread && strategy !== 'Iron Condor' && strategy !== 'Iron Butterfly') {
    if (!form.strike_buy  || isNaN(strikeBuy)  || strikeBuy  <= 0) errors.strike_buy  = 'Both strikes are required for spread strategies.';
    if (!form.strike_sell || isNaN(strikeSell) || strikeSell <= 0) errors.strike_sell = 'Both strikes are required for spread strategies.';

    if (!errors.strike_buy && !errors.strike_sell) {
      if (strategy === 'Bull Put Spread' && strikeSell <= strikeBuy)
        errors.strike_sell = 'Bull Put Spread: sell strike must be higher than buy strike (e.g. sell $470P / buy $460P).';
      if (strategy === 'Bear Call Spread' && strikeBuy <= strikeSell)
        errors.strike_buy  = 'Bear Call Spread: buy strike must be higher than sell strike (e.g. sell $230C / buy $235C).';
      if (strategy === 'Bull Call Spread' && strikeSell <= strikeBuy)
        errors.strike_sell = 'Bull Call Spread: sell strike must be higher than buy strike (e.g. buy $200C / sell $210C).';
      if (strategy === 'Bear Put Spread' && strikeBuy <= strikeSell)
        errors.strike_buy  = 'Bear Put Spread: buy strike must be higher than sell strike (e.g. buy $200P / sell $190P).';
    }
    // Items 35+36: Net Debit vs spread width checks (Bull Call Spread + Bear Put Spread)
    if ((strategy === 'Bull Call Spread' || strategy === 'Bear Put Spread') &&
        !isNaN(strikeBuy) && !isNaN(strikeSell) && entryPrice > 0) {
      const spreadWidth = strategy === 'Bull Call Spread'
        ? strikeSell - strikeBuy
        : strikeBuy  - strikeSell;
      if (spreadWidth > 0) {
        // Item 35: hard stop — debit cannot equal or exceed spread width
        if (entryPrice >= spreadWidth)
          errors.entry_price = `Net debit ($${entryPrice.toFixed(2)}) exceeds the spread width ($${spreadWidth.toFixed(2)}) — this is not possible. Check your strikes or debit amount.`;
        // Item 36: amber warning — debit more than 50% of spread width
        else if (entryPrice > spreadWidth * 0.5)
          warnings.entry_price = `Net debit is more than half the spread width.`;
      }
    }
  }

  // ── Calendar Spread validation ────────────────────────────────
  if (strategy === 'Calendar Spread') {
    // Validate individual leg prices (two-field model)
    const calLong  = parseFloat(form.cal_long_cost)    || 0;
    const calShort = parseFloat(form.cal_short_credit) || 0;
    if (!form.cal_long_cost   || calLong  <= 0) errors.cal_long_cost   = 'Enter the back month (long leg) premium you paid.';
    if (!form.cal_short_credit|| calShort <= 0) errors.cal_short_credit = 'Enter the front month (short leg) premium you received.';
    if (!errors.cal_long_cost && !errors.cal_short_credit) {
      if (calLong <= calShort)
        errors.cal_long_cost = `Long leg ($${calLong.toFixed(2)}) must cost more than short leg ($${calShort.toFixed(2)}) — the net debit must be positive.`;
      else if (calLong > 50)
        warnings.cal_long_cost = `Back month cost of $${calLong.toFixed(2)} seems very high — check this is the per-share premium, not the total dollar amount.`;
    }
    // Strike required — both legs trade the same strike
    if (!form.strike_sell || isNaN(strikeSell) || strikeSell <= 0)
      errors.strike_sell = 'Calendar Spread requires a strike price (both legs trade at this strike).';
    // Spot sanity: strike should be within ~10% of spot (calendars need near-ATM to maximise vega edge)
    if (!errors.strike_sell && spot > 0) {
      const pctFromSpot = Math.abs(strikeSell - spot) / spot * 100;
      if (pctFromSpot > 15)
        warnings.strike_sell = `Strike $${strikeSell} is ${pctFromSpot.toFixed(0)}% away from spot ($${spot.toFixed(2)}). Calendar spreads work best near-ATM where vega is highest — far OTM strikes have minimal time-value edge.`;
    }
    // entry_price computed from cal_long_cost - cal_short_credit — validated via those fields above
    // Contracts advisory — large size increases assignment risk on the short leg
    if (!isNaN(contracts) && contracts >= 5)
      warnings.contracts = `${contracts} contracts is a large calendar position. Each short front-month leg carries assignment risk if the stock moves sharply. Consider sizing down.`;
    // Warn if front month has very little time left at entry
    if (expiry && entryDate) {
      const daysToFront = Math.ceil((new Date(expiry + 'T12:00:00') - new Date(entryDate + 'T12:00:00')) / 86400000);
      if (daysToFront > 0 && daysToFront < 7)
        warnings.expiration = `Front month expires in ${daysToFront} day${daysToFront===1?'':'s'} — very little theta to collect. Consider a front month with 2–4 weeks remaining.`;
    }
  }

  // ── Diagonal Spread validation ──────────────────────────────
  if (strategy === 'Diagonal Spread') {
    // Validate individual leg prices (two-field model)
    const diagLong  = parseFloat(form.cal_long_cost)    || 0;
    const diagShort = parseFloat(form.cal_short_credit) || 0;
    if (!form.cal_long_cost   || diagLong  <= 0) errors.cal_long_cost   = 'Enter the back month (long leg) premium you paid.';
    if (!form.cal_short_credit|| diagShort <= 0) errors.cal_short_credit = 'Enter the front month (short leg) premium you received.';
    if (!errors.cal_long_cost && !errors.cal_short_credit && diagLong <= diagShort)
      warnings.cal_long_cost = `Long leg ($${diagLong.toFixed(2)}) ≤ short leg ($${diagShort.toFixed(2)}) — this is a net credit diagonal, which is unusual. Verify the values are correct.`;
    // Both strikes required
    if (!form.strike_sell || isNaN(strikeSell) || strikeSell <= 0)
      errors.strike_sell = 'Diagonal Spread requires a short leg strike (the front-month strike you sold).';
    if (!form.strike_buy  || isNaN(strikeBuy)  || strikeBuy  <= 0)
      errors.strike_buy  = 'Diagonal Spread requires a long leg strike (the back-month strike you bought).';
    // Same-strike warning — that is a Calendar, not a Diagonal
    if (!errors.strike_sell && !errors.strike_buy && strikeSell === strikeBuy)
      warnings.strike_buy = 'Both strikes are the same — that is a Calendar Spread, not a Diagonal. Use Calendar Spread for same-strike time spreads, or enter different strikes for a true diagonal.';
    // Strike relationship: short leg must always be BELOW the long leg (both calls and puts)
    // Call diagonal: sell lower call, buy higher call (e.g. sell $105C, buy $110C)
    // Put diagonal:  sell lower put, buy higher put (e.g. sell $95P, buy $100P)
    if (!errors.strike_sell && !errors.strike_buy && strikeSell !== strikeBuy && strikeSell > strikeBuy)
      errors.strike_sell = `Short leg strike ($${strikeSell}) must be lower than the long leg strike ($${strikeBuy}). For both call and put diagonals, the short front-month leg is always the lower strike.`;
    // Debit convention: diagonal is always entered as a net debit
    // entry_price computed from cal_long_cost - cal_short_credit — validated via those fields above
    // Spot sanity on the short (near) strike: should be OTM
    if (!errors.strike_sell && spot > 0) {
      // Infer direction from note text or just check if short strike is deeply ITM
      const shortOtmPct = (strikeSell - spot) / spot * 100; // positive = OTM call, negative = ITM call (or OTM put if inverted)
      if (Math.abs(shortOtmPct) > 25)
        warnings.strike_sell = `Short leg strike $${strikeSell} is ${Math.abs(shortOtmPct).toFixed(0)}% from spot ($${spot.toFixed(2)}). Diagonal short legs are typically 5–15% OTM to balance premium income with assignment safety.`;
    }
  }

  // ── Iron Condor / Iron Butterfly wing validation ─────────────
  if (strategy === 'Iron Condor' || strategy === 'Iron Butterfly') {
    const pss = parseFloat(form.put_strike_sell);
    const psb = parseFloat(form.put_strike_buy);
    const css = parseFloat(form.call_strike_sell);
    const csb = parseFloat(form.call_strike_buy);
    const pc  = parseFloat(form.put_credit);
    const cc  = parseFloat(form.call_credit);

    // All 4 strike fields required
    if (!form.put_strike_sell  || isNaN(pss) || pss <= 0)
      errors.put_strike_sell  = 'Put sell strike is required.';
    if (!form.put_strike_buy   || isNaN(psb) || psb <= 0)
      errors.put_strike_buy   = 'Put buy strike is required.';
    if (!form.call_strike_sell || isNaN(css) || css <= 0)
      errors.call_strike_sell = 'Call sell strike is required.';
    if (!form.call_strike_buy  || isNaN(csb) || csb <= 0)
      errors.call_strike_buy  = 'Call buy strike is required.';

    // Wing direction: put sell > put buy (sell higher put, buy lower put)
    if (!errors.put_strike_sell && !errors.put_strike_buy && pss <= psb)
      errors.put_strike_sell = 'Put sell strike must be ABOVE put buy strike (e.g. sell $630P / buy $620P).';

    // Wing direction: call sell < call buy (sell lower call, buy higher call)
    if (!errors.call_strike_sell && !errors.call_strike_buy && css >= csb)
      errors.call_strike_sell = 'Call sell strike must be BELOW call buy strike (e.g. sell $670C / buy $680C).';

    if (form.strategy === 'Iron Butterfly') {
      // IB: put_strike_sell MUST equal call_strike_sell (both are the ATM body).
      // Run independently — do NOT gate on errors.call_strike_sell being empty.
      // This is the PRIMARY IB structural rule and must always show, even if the
      // call direction is also wrong, so the trader gets the correct IB guidance.
      if (!errors.put_strike_sell && !isNaN(pss) && !isNaN(css) && pss !== css)
        errors.call_strike_sell = `Iron Butterfly: both short strikes must be the SAME ATM strike (the body). Put sell = ${pss} but Call sell = ${css}. Set "Sell Call Strike" to ${pss} too, then place the call wing buy above it.`;
    } else {
      // IC: Wings must not overlap: call sell > put sell
      if (!errors.put_strike_sell && !errors.call_strike_sell && css <= pss)
        errors.call_strike_sell = 'Call sell strike must be ABOVE put sell strike — wings overlap!';
    }

    // Credits must be positive
    if (!form.put_credit  || isNaN(pc) || pc <= 0)
      errors.put_credit  = 'Put wing credit is required ($ per share).';
    if (!form.call_credit || isNaN(cc) || cc <= 0)
      errors.call_credit = 'Call wing credit is required ($ per share).';
  }

  // ── OCC strike increment validation (CC and CSP) ──────────────────────────
  // Strikes must align to standard OCC increments: <$5=$0.50, <$25=$1, <$200=$2.50, $200+=$5
  if ((isCC || isCSP) && spot > 0) {
    const checkStrike = isCC ? strikeSell : strikeBuy;
    const checkField  = isCC ? 'strike_sell' : 'strike_buy';
    if (!isNaN(checkStrike) && checkStrike > 0) {
      const incr = spot < 5 ? 0.5 : spot < 25 ? 1 : spot < 200 ? 2.5 : 5;
      const remainder = Math.abs(Math.round(checkStrike / incr) * incr - checkStrike);
      if (remainder > 0.001) {
        warnings[checkField] = warnings[checkField] ||
          `$${checkStrike} may not be a valid strike — OCC increments for a $${spot.toFixed(0)} stock are $${incr}. Nearest valid strikes: $${(Math.floor(checkStrike/incr)*incr).toFixed(incr<1?1:0)} or $${(Math.ceil(checkStrike/incr)*incr).toFixed(incr<1?1:0)}.`;
      }
    }
  }

  // ── CC sell-below-cost-basis warning — uses NET cost (after premium reductions) ──
  if (isCC && lotId && !isNaN(strikeSell)) {
    const lot = lots.find(l => l.id === lotId);
    if (lot) {
      const lotTrades    = (trades || []).filter(t => t.lot_id === lot.id);
      const premium      = lotTrades.filter(t => CREDIT_STRATS.has(t.strategy)).reduce((sum, t) => {
        const ep = t.entry_price || 0, xp = t.exit_price || 0;
        const isClosed = t.status === 'closed';
        const isAssign = isClosed && t.strategy === 'Cash-Secured Put' &&
          (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
           (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
        return sum + (ep - (isClosed ? (isAssign ? 0 : xp) : 0)) * (t.contracts || 1) * 100;
      }, 0);
      const netCost      = parseFloat(lot.avg_cost) - (premium / (lot.shares || 1));
      const rawCost      = parseFloat(lot.avg_cost);
      if (strikeSell < netCost) {
        warnings.strike_sell = `Strike $${strikeSell} is below your net cost basis of $${netCost.toFixed(2)}/sh (purchase $${rawCost.toFixed(2)} minus $${(premium/(lot.shares||1)).toFixed(2)}/sh premium). If called away you will realise a net loss on this position.`;
      } else if (strikeSell < rawCost) {
        warnings.strike_sell = `Strike $${strikeSell} is below your purchase price of $${rawCost.toFixed(2)}, but above your net cost of $${netCost.toFixed(2)}/sh after premiums. Still profitable overall if called away. ✓`;
      }
    }
  }

  // ── Lot rules ──
  if (noLot && lotId)
    warnings.lot_id = `${strategy} is a pure options strategy. Linking a stock lot is unusual — only do this if you're tracking a specific hedge.`;
  if (isCC && !lotId)
    errors.lot_id = 'A Covered Call must be linked to a stock lot — you need 100 shares per contract to cover the obligation. Without shares this is a naked call, which carries unlimited upside risk and is not supported in this app. Select the correct lot above.';
  // FIX #12: Ticker/lot mismatch — catch AAPL lot linked to a TSLA trade
  if (lotId && form.ticker) {
    const selectedLot = lots.find(l => l.id === parseInt(lotId));
    if (selectedLot && selectedLot.ticker && selectedLot.ticker.toUpperCase() !== form.ticker.toUpperCase()) {
      errors.lot_id = `Ticker mismatch: the selected lot is ${selectedLot.ticker} but this trade is for ${form.ticker.toUpperCase()}. Select a matching lot or None.`;
    }
  }

  // ── Greeks rules (soft warnings only) ──
  const delta = parseFloat(form.delta);
  if (form.delta && !isNaN(delta)) {
    if (Math.abs(delta) > 1)                       warnings.delta = 'Delta magnitude must be between 0 and 1.';
    else if (isCredit && delta > 0)                warnings.delta = 'Short/credit strategies typically have negative delta.';
    else if (strategy === 'Long Call' && delta < 0) warnings.delta = 'Long Call delta should be positive.';
    else if (strategy === 'Long Put'  && delta > 0) warnings.delta = 'Long Put delta should be negative.';
  }
  const iv = parseFloat(form.iv_entry);
  if (form.iv_entry && !isNaN(iv) && (iv < 1 || iv > 500))
    warnings.iv_entry = 'IV should be between 1% and 500%.';
  // IV is optional — entering it enables Black-Scholes estimation for Theo P&L
  // when no option price is available. Without it, Theo P&L uses Opt $ directly
  // (Yahoo or manual) and shows '—' only when neither is available.
  // Broker-connected clients: IV is auto-filled, field is disabled.
  if (isOpen && !isBrokerConnected && !form.iv_entry)
    warnings.iv_entry = 'Optional: enter IV % to enable Black-Scholes estimation when no option price is available.';

  // ── P&L consistency ──
  if (form.pnl && isOpen)
    warnings.pnl = 'P&L is typically recorded when a trade is closed. Is this trade still open?';

  if (isClosed && !errors.entry_price && !errors.exit_price && entryPrice > 0 && !isNaN(exitPrice)) {
    const expectedPnl = isLong
      ? (exitPrice - entryPrice) * contracts * 100
      : (entryPrice - exitPrice) * contracts * 100;
    const manualPnl = parseFloat(form.pnl);
    if (form.pnl && !isNaN(manualPnl) && Math.abs(manualPnl - expectedPnl) > 5) {
      warnings.pnl = `Calculated P&L is $${expectedPnl.toFixed(0)} — your entry is $${manualPnl.toFixed(0)}. Difference: $${Math.abs(manualPnl - expectedPnl).toFixed(0)}. Verify or leave blank to auto-calculate.`;
    }
  }


  // ── FIX 4: Premium sanity vs spot ────────────────────────────────────────
  if (spot > 0 && entryPrice > 0 && !errors.entry_price) {
    if (isCC && entryPrice > spot * 0.5)
      warnings.entry_price = `Premium $${entryPrice} seems very high for a $${spot} stock — option premiums are typically under 10–15% of spot. Verify.`;
    if (isCSP && !isNaN(strikeBuy) && entryPrice >= strikeBuy)
      warnings.entry_price = `Premium $${entryPrice} equals or exceeds the put strike $${strikeBuy} — this is not possible for a CSP. Verify entry price.`;
  }

  // ── FIX 5: ITM warning on CC/CSP strike vs spot ──────────────────────────
  if (spot > 0 && isOpen) {
    if (isCC && !isNaN(strikeSell) && strikeSell < spot && !errors.strike_sell)
      warnings.strike_sell = `Strike $${strikeSell} is below the current spot $${spot.toFixed(2)} — this CC is ITM. Shares will very likely be called away at expiry.`;
    if (isCSP && !isNaN(strikeBuy) && strikeBuy > spot && !errors.strike_buy)
      warnings.strike_buy = `Strike $${strikeBuy} is above the current spot $${spot.toFixed(2)} — this CSP is ITM. Assignment is very likely at expiry.`;
  }

  // ── FIX 7: Contracts exceed lot share count ──────────────────────────────
  if (isCC && lotId && !isNaN(contracts) && contracts >= 1) {
    const lot = lots.find(l => l.id === lotId);
    if (lot && contracts * 100 > lot.shares) {
      const uncovered = contracts * 100 - lot.shares;
      warnings.contracts = `${contracts} contract${contracts > 1 ? 's' : ''} covers ${contracts * 100} shares but this lot only has ${lot.shares}. ${uncovered} share${uncovered > 1 ? 's' : ''} would be uncovered (naked call).`;
    }
  }

  // ── FIX 9: Duplicate open trade detection ────────────────────────────────
  if (isOpen && !initial && trades && trades.length > 0 && ticker && expiry) {
    const dupStrike = isCC ? String(form.strike_sell) : isCSP ? String(form.strike_buy) : null;
    if (dupStrike) {
      const dup = trades.find(t =>
        t.status === 'open' &&
        t.strategy === strategy &&
        t.ticker === ticker &&
        t.expiration === expiry &&
        (isCC  ? String(t.strike_sell) === dupStrike :
         isCSP ? String(t.strike_buy)  === dupStrike : false)
      );
      if (dup)
        warnings.expiration = `An open ${strategy} on ${ticker} at $${dupStrike} expiring ${expiry} already exists (id ${dup.id}). Is this a duplicate?`;
    }
  }

  // ── FIX 10: Closing CSP/CC at strike — should use Assigned/Called Away ───
  if (isClosed && !errors.exit_price && !isNaN(exitPrice)) {
    if (isCSP && !isNaN(strikeBuy) && Math.abs(exitPrice - strikeBuy) < 0.01)
      warnings.exit_price = `Exit price $${exitPrice} equals your put strike — this looks like an assignment. Use the Assigned button instead to correctly create a stock lot and track your wheel.`;
    if (isCC && !isNaN(strikeSell) && Math.abs(exitPrice - strikeSell) < 0.01)
      warnings.exit_price = `Exit price $${exitPrice} equals your call strike — this looks like a called-away event. Use the Called Away button instead to correctly close the stock lot.`;
  }

  return { errors, warnings };
}

// ── Field error/warning display components ────────────────────────────────
function FieldError({ msg })   { return msg ? <div style={{ color: 'var(--red,#c0392b)', fontSize: 11, marginTop: 3, fontWeight: 500 }}>⛔ {msg}</div> : null; }
function FieldWarn({ msg })    { return msg ? <div style={{ color: 'var(--amber,#b7730a)', fontSize: 11, marginTop: 3 }}>⚠ {msg}</div> : null; }

// ── Main component ────────────────────────────────────────────────────────
export default function TradeForm({ initial, prefill, lots, trades = [], onSave, onClose, isBrokerConnected = false, currentPrices = {}, isMock = false, historicalMode = false, onFetchSpot }) {
  const todayStr = today();
  const [form, setForm] = useState({
    ticker: '', strategy: 'Cash-Secured Put', status: 'open',
    entry_date: todayStr, exit_date: '', expiration: '', expiration_back: '',
    entry_price: '', exit_price: '', contracts: 1,
    strike_buy: '', strike_sell: '',
    option_type: 'call',  // 'call' | 'put' — required for Calendar/Diagonal
    cal_short_credit: '', // Calendar/Diagonal: front month premium received (form-only — not stored separately)
    cal_long_cost: '',    // Calendar/Diagonal: back month premium paid (form-only — net debit stored as entry_price)
    // IC-specific fields (put wing + call wing entered separately)
    put_strike_sell: '', put_strike_buy: '', put_credit: '',
    call_strike_sell: '', call_strike_buy: '', call_credit: '',
    delta: '', gamma: '', theta: '', vega: '', iv_entry: '',
    notes: '',
    // Greeks auto-expanded for broker users
    _showGreeks: isBrokerConnected,
    ...(prefill || {}),   // pre-seed for new trade (Write CC etc) — no id, no edit mode
    ...(initial || {}),   // edit mode — overrides prefill if both somehow set
    // Normalise after spread: pnl null/NaN → '', lot_id always string
    pnl: (initial?.pnl != null && !isNaN(initial?.pnl)) ? String(initial.pnl) : '',
    lot_id: (initial?.lot_id ?? prefill?.lot_id) != null ? String(initial?.lot_id ?? prefill?.lot_id) : '',
  });

  const [submitted, setSubmitted] = useState(false);
  // Manual spot/IV override — used when Yahoo has no price for the ticker yet
  const [manualSpot, setManualSpot] = useState('');
  const [manualIv,   setManualIv]   = useState('');
  const [isPrefilled, setIsPrefilled] = useState(false); // true when rec card filled premium
  const [fetchingSpot, setFetchingSpot] = useState(false);
  const [fetchSpotFailed, setFetchSpotFailed] = useState(false);
  const [estPremium,  setEstPremium]  = useState(false); // true when entry_price was auto-filled from BSM rec
  const [appliedRec,   setAppliedRec]  = useState(null);  // { strike, expiry } of last applied card
  // When ticker changes, clear manual overrides so stale values don't carry over
  useEffect(() => { setManualSpot(''); setManualIv(''); set('iv_entry', ''); set('delta', ''); set('theta', ''); setFetchSpotFailed(false); }, [form.ticker]);

  // Auto-fetch Yahoo spot price when ticker is entered (non-broker, CC/CSP only)
  useEffect(() => {
    const ticker = form.ticker?.trim().toUpperCase();
    if (!ticker || ticker.length < 1 || isBrokerConnected || isMock || !onFetchSpot) return;
    if (!(isCC || isCSP)) return;
    // Always re-fetch on ticker entry — never trust stale currentPrices for recommendations.
    // fetchStockPrice has a 5-min cache so this won't hammer Yahoo on every keystroke.
    const timer = setTimeout(() => {
      setFetchingSpot(true);
      setFetchSpotFailed(false);
      onFetchSpot(ticker)
        .then((price) => {
          // onFetchSpot resolves with the fetched price — check return value,
          // NOT currentPrices (stale closure would always read the old state)
          if (!price) setFetchSpotFailed(true);
        })
        .catch(() => setFetchSpotFailed(true))
        .finally(() => setFetchingSpot(false));
    }, 800);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.ticker]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const isSpread = SPREAD_STRATS.has(form.strategy);
  const isCC     = form.strategy === 'Covered Call';
  const isCSP    = form.strategy === 'Cash-Secured Put';
  const spot     = parseFloat(currentPrices[form.ticker?.trim().toUpperCase() || '']?.stock) || 0;
  const isIC     = form.strategy === 'Iron Condor' || form.strategy === 'Iron Butterfly';
  const isClosed = form.status === 'closed';
  const isLong     = LONG_STRATS.has(form.strategy);
  const isCalDiag  = form.strategy === 'Calendar Spread' || form.strategy === 'Diagonal Spread';
  // Computed net debit for Cal/Diagonal — long leg cost minus short leg credit (form-only fields)
  const calLongCost    = parseFloat(form.cal_long_cost)    || 0;
  const calShortCredit = parseFloat(form.cal_short_credit) || 0;
  const calNetDebit    = (calLongCost > 0 || calShortCredit > 0)
    ? Math.round((calLongCost - calShortCredit) * 100) / 100 : null;

  // ── Chain conflict warning ────────────────────────────
  // Warn when the trader logs a strategy that could be an IC/Cal adjustment
  // Warning fires ONLY for IC/IB and Calendar — not for BCS/BPS/Diagonal which are independent strategies.
  const IC_TRIGGER_STRATS  = new Set(['Iron Condor', 'Iron Butterfly']);
  const CAL_TRIGGER_STRATS = new Set(['Calendar Spread']);
  const chainWarning = (() => {
    if (!form.ticker || !form.strategy || form.status === 'closed') return null;
    const ticker = form.ticker.trim().toUpperCase();
    if (!ticker) return null;
    // Check for open IC/IB chains on this ticker — collect ALL, not just first
    if (IC_TRIGGER_STRATS.has(form.strategy)) {
      const seen = new Set();
      const openICs = (trades || []).filter(t =>
        t.ticker === ticker &&
        t.status === 'open' &&
        t.condor_chain_id != null &&
        !seen.has(t.condor_chain_id) &&
        seen.add(t.condor_chain_id)
      ).map(t => {
        // Get both legs for this chain to show strikes
        const legs = (trades || []).filter(lt => lt.condor_chain_id === t.condor_chain_id);
        const putLeg  = legs.find(l => l.condor_leg === 'put');
        const callLeg = legs.find(l => l.condor_leg === 'call');
        const totalCredit = legs.reduce((s, l) => s + (parseFloat(l.entry_price) || 0), 0);
        const expiry = t.expiration || '';
        const opened = t.entry_date || '';
        return { chainId: t.condor_chain_id, putLeg, callLeg, totalCredit, expiry, opened };
      });
      if (openICs.length > 0) return { type: 'ic', chains: openICs };
    }
    // Check for open Calendar chains on this ticker — collect ALL
    if (CAL_TRIGGER_STRATS.has(form.strategy)) {
      const seen = new Set();
      const openCals = (trades || []).filter(t =>
        t.ticker === ticker &&
        t.status === 'open' &&
        t.cal_chain_id != null &&
        !seen.has(t.cal_chain_id) &&
        seen.add(t.cal_chain_id)
      ).map(t => {
        const legs = (trades || []).filter(lt => lt.cal_chain_id === t.cal_chain_id);
        const shortLeg = legs.find(l => l.cal_leg === 'short' && l.status === 'open');
        const expiry = shortLeg?.expiration || t.expiration || '';
        const opened = t.entry_date || '';
        const strike = t.strike_sell || shortLeg?.strike_sell || '';
        return { chainId: t.cal_chain_id, strike, expiry, opened };
      });
      if (openCals.length > 0) return { type: 'cal', chains: openCals };
    }
    return null;
  })();

  // Auto-compute P&L when price fields are complete
  const computedPnl = (() => {
    if (form.status !== 'closed') return null;
    const ep = parseFloat(form.entry_price);
    const xp = parseFloat(form.exit_price);
    const c  = parseInt(form.contracts);
    if (!ep || isNaN(ep) || isNaN(xp) || isNaN(c) || c < 1) return null;
    return isLong ? (xp - ep) * c * 100 : (ep - xp) * c * 100;
  })();

  // Auto-fill P&L when it's blank and prices are complete
  useEffect(() => {
    if (computedPnl !== null && form.pnl === '' && form.status === 'closed') {
      set('pnl', String(Math.round(computedPnl)));
    }
  }, [form.entry_price, form.exit_price, form.contracts, form.status]);

  // ── CC / CSP Entry Recommendations ─────────────────────────────────────
  // Returns { state, spot, iv, spotSource, ivSource, cards }
  //   state: 'cards'    — recommendations ready (broker OR experienced non-broker user)
  //          'firsttime' — no broker + no prior CC/CSP trades → clean form + subscribe note
  //          'manual'    — experienced non-broker user, no live price yet → manual input strip
  //          'hidden'    — not applicable (wrong strategy, editing existing, no ticker)
  //
  // "First time" definition: non-broker AND no prior Covered Call or Cash-Secured Put
  // trade exists anywhere in their diary (any ticker, open or closed).
  // Rationale: if they have even one CC/CSP they understand the concept.
  // Broker users always get recommendations regardless — they have live data and know greeks.
  const ccRecommendations = useMemo(() => {
    const hidden = { state: 'hidden', spot: 0, iv: 0, cards: null };
    if (!(isCC || isCSP)) return hidden;
    if (form.status === 'closed') return hidden;
    if (initial?.expiration) return hidden;

    const ticker = form.ticker?.trim().toUpperCase();
    if (!ticker) return hidden;

    // First-time detection: non-broker user with no prior CC or CSP trades
    if (!isBrokerConnected) {
      const hasPriorCCOrCSP = (trades || []).some(t =>
        t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put'
      );
      if (!hasPriorCCOrCSP) return { state: 'firsttime', spot: 0, iv: 0, cards: null };
    }

    // Spot: live (Yahoo/broker) → manual entry → lot avg_cost (stale — last resort)
    let spot = parseFloat(currentPrices[ticker]?.stock) || 0;
    let spotSource = 'live';
    if (!spot && manualSpot) { spot = parseFloat(manualSpot) || 0; spotSource = 'manual'; }
    if (!spot) {
      const linkedLot = form.lot_id ? lots.find(l => String(l.id) === String(form.lot_id)) : null;
      if (linkedLot) { spot = parseFloat(linkedLot.avg_cost) || 0; spotSource = 'lot'; }
    }
    if (!spot || spot <= 0) return { state: 'manual', spot: 0, iv: 0, cards: null };

    // IV: trader manual override → live (Yahoo ATM chain / broker) → NO silent default
    // If trader has explicitly typed a value in iv_entry, always use that — never silently
    // ignore it in favour of the live fetch. The live IV is the DEFAULT, not the authority.
    let iv = 0;
    let ivSource = 'live';
    const manualIvEntry = parseFloat(form.iv_entry) || 0;
    if (manualIvEntry > 0) {
      iv = manualIvEntry; ivSource = 'manual';
    } else {
      iv = parseFloat(currentPrices[ticker]?.iv) || 0;
      ivSource = iv > 0 ? 'live' : 'default';
    }

    // Persona 1 rule: NEVER show cards with a silent 28% default IV.
    // If spot came from stale lot avg_cost AND we have no real IV AND trader hasn't typed IV,
    // we have two unknowns — the cards would be unreliable garbage.
    // Force state:'manual' so trader must confirm both spot and IV before cards appear.
    if (!iv && spotSource === 'lot') return { state: 'manual', spot: 0, iv: 0, cards: null };

    // If we have a real spot but no IV, use 28% default but mark clearly — trader can override.
    // This is acceptable when spot is live (Yahoo fetched today) — the error is bounded.
    if (!iv) { iv = 28; ivSource = 'default'; }
    iv = iv / 100;

    const r = DEFAULT_RISK_FREE_RATE;
    const isCall = isCC;

    // OCC standard strike increments: $0.50 for <$5, $1 for $5-$25, $2.50 for $25-$200, $5 for $200+
    // Without a live chain we don't know if a stock lists $2.50 or $5 increments.
    // New IPOs and lower-volume names only list $5 strikes even in the $25-$200 range.
    // Using $5 for anything above $50 is always safe — $5 is a subset of $2.50 so
    // every suggestion will exist on any real chain.
    const strikeIncr = spot < 5 ? 0.5 : spot < 25 ? 1 : spot < 50 ? 2.5 : 5;
    const roundToIncr = v => Math.round(v / strikeIncr) * strikeIncr;

    function strikeForDelta(targetDelta, dte) {
      const T = dte / 365;
      // CC (call): OTM strikes are ABOVE spot -> search spot to spot*4.0
      // CSP (put): OTM strikes are BELOW spot -> search spot*0.15 to spot
      // Wide range needed: high-IV stocks (recent IPOs, volatile names) can have
      // 0.20-delta strikes >50% OTM. Old spot*1.8 cap caused binary search to
      // converge at the boundary, returning unrealistic strikes not on any chain.
      let lo = isCall ? spot        : spot * 0.15;
      let hi = isCall ? spot * 4.0  : spot;
      for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        const d = Math.abs(bsmDelta(spot, mid, T, iv, isCall, r));
        if (d > targetDelta) { isCall ? (lo = mid) : (hi = mid); }
        else                 { isCall ? (hi = mid) : (lo = mid); }
      }
      const raw = roundToIncr((lo + hi) / 2);
      // Sanity cap: if BSM wants a strike >60% OTM the stock probably has extreme IV
      // and the chain won't have those strikes. Fallback to a fixed OTM% instead.
      // CC cap: 45% OTM. CSP floor: 30% OTM (rough practical exchange limits).
      if (isCall && raw > spot * 1.6) {
        const pct = targetDelta < 0.25 ? 0.18 : targetDelta < 0.32 ? 0.12 : 0.08;
        return roundToIncr(spot * (1 + pct));
      }
      if (!isCall && raw < spot * 0.55) {
        const pct = targetDelta < 0.25 ? 0.18 : targetDelta < 0.32 ? 0.12 : 0.08;
        return roundToIncr(spot * (1 - pct));
      }
      return raw;
    }

    const configs = [
      { label: 'Conservative', sublabel: '30 DTE · ~0.20Δ · lower assignment risk',  dte: 30, targetDelta: 0.20, color: '#1a5fa8', bg: '#eef4ff', border: '#b3cef0' },
      { label: 'Standard',     sublabel: '45 DTE · ~0.27Δ · optimal theta decay zone',   dte: 45, targetDelta: 0.27, color: '#1a7a4a', bg: '#edf7f2', border: '#a8d5bc' },
      { label: 'Aggressive',   sublabel: '30 DTE · ~0.35Δ · more premium, more risk', dte: 30, targetDelta: 0.35, color: '#7c3aed', bg: '#f3f0ff', border: '#c4b5fd' },
    ];

    const cards = configs.map(cfg => {
      const T      = cfg.dte / 365;
      const strike = strikeForDelta(cfg.targetDelta, cfg.dte);
      const price  = Math.max(0.01, bsmPrice(spot, strike, T, iv, isCall, r));
      const delta  = bsmDelta(spot, strike, T, iv, isCall, r);
      const theta  = bsmTheta(spot, strike, T, iv, isCall, r);
      const expiry = expiryAhead(cfg.dte);
      const pctOtm = isCall
        ? ((strike - spot) / spot * 100).toFixed(1)
        : ((spot - strike) / spot * 100).toFixed(1);
      const totalPremium = Math.round(price * (parseInt(form.contracts) || 1) * 100);
      return { ...cfg, strike, price: parseFloat(price.toFixed(2)),
               delta: parseFloat(delta.toFixed(3)), theta: parseFloat(theta.toFixed(3)),
               expiry, pctOtm, totalPremium };
    });

    return { state: 'cards', spot, iv: iv * 100, spotSource, ivSource, cards };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCC, isCSP, form.ticker, form.lot_id, form.status, form.contracts,
      initial, currentPrices, lots, manualSpot, form.iv_entry, trades, isBrokerConnected]);

  function applyRecommendation(rec) {
    setIsPrefilled(true);
    set('expiration',  rec.expiry);
    if (isCC) {
      set('strike_sell', String(rec.strike));  // CC: sell side only
      set('strike_buy',  '');                  // clear buy side — CC is single-leg
    } else {
      set('strike_buy',  String(rec.strike));  // CSP: buy side only
      set('strike_sell', '');                  // clear sell side — CSP is single-leg
    }
    set('entry_price', String(rec.price));
    set('delta',       String(rec.delta));
    set('theta',       String(rec.theta));
    // Store the IV used to price this card so Roll Modal has it at roll time.
    // Only save iv_entry when it's a real value (live from Yahoo/broker or manually entered).
    // If ivSource='default' (28% placeholder), leave iv_entry blank — saving a fake 28% would
    // mislead the Roll Modal and Theo P&L into thinking the trader verified this IV.
    if (ccRecommendations.iv && ccRecommendations.ivSource !== 'default') {
      set('iv_entry', String(parseFloat(ccRecommendations.iv).toFixed(1)));
    }
    set('_showGreeks', true);
    setEstPremium(true);
    setAppliedRec({ strike: String(rec.strike), expiry: rec.expiry });
  }

  const { errors, warnings } = validate(form, lots, isBrokerConnected, currentPrices, trades, initial, historicalMode);
  const hasErrors = Object.keys(errors).length > 0;

  async function submit(e) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors) return;

    const iv = (() => {
      const raw = parseFloat(form.iv_entry);
      if (isNaN(raw) || !form.iv_entry) return null;
      if (raw > 0 && raw < 1.0) return Math.round(raw * 100 * 10) / 10; // decimal → pct
      if (raw > 500) return null;
      return raw;
    })();

    // For IC: build two leg objects instead of single strike fields
    const icLegs = isIC ? {
      put:  {
        strike_sell: form.put_strike_sell  ? parseFloat(form.put_strike_sell)  : null,
        strike_buy:  form.put_strike_buy   ? parseFloat(form.put_strike_buy)   : null,
        entry_price: form.put_credit       ? parseFloat(form.put_credit)       : null,
      },
      call: {
        strike_sell: form.call_strike_sell ? parseFloat(form.call_strike_sell) : null,
        strike_buy:  form.call_strike_buy  ? parseFloat(form.call_strike_buy)  : null,
        entry_price: form.call_credit      ? parseFloat(form.call_credit)      : null,
      },
    } : null;

    const data = {
      ...form,
      ticker:      form.ticker.toUpperCase(),
      lot_id:      form.lot_id      ? parseInt(form.lot_id)        : null,
      contracts:   form.contracts   ? parseInt(form.contracts)      : 1,
      entry_price: isIC
        ? (icLegs.put.entry_price || 0) + (icLegs.call.entry_price || 0)
        : isCalDiag
          ? Math.round(((parseFloat(form.cal_long_cost)||0) - (parseFloat(form.cal_short_credit)||0)) * 100) / 100 || null
          : form.entry_price ? parseFloat(form.entry_price) : null,
      exit_price:  form.exit_price !== '' ? parseFloat(form.exit_price) : null,
      strike_buy:  form.strike_buy  ? parseFloat(form.strike_buy)   : null,
      strike_sell: form.strike_sell ? parseFloat(form.strike_sell)  : null,
      option_type: ['Calendar Spread','Diagonal Spread'].includes(form.strategy) ? (form.option_type || 'call') : null,
      ...(isIC ? { _icLegs: icLegs } : {}),
      delta:  form.delta  ? parseFloat(form.delta)  : null,
      gamma:  form.gamma  ? parseFloat(form.gamma)  : null,
      theta:  form.theta  ? parseFloat(form.theta)  : null,
      vega:   form.vega   ? parseFloat(form.vega)   : null,
      iv_entry: iv,
      pnl: (form.pnl !== '' && form.pnl != null) ? parseFloat(form.pnl) : (computedPnl !== null ? Math.round(computedPnl) : null),
    };
    onSave(data);
  }

    const showErrors = submitted;

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h3>{initial ? 'Edit Trade' :
            form.strategy === 'Covered Call'    ? 'Write Covered Call' :
            form.strategy === 'Cash-Secured Put' ? 'Sell Cash-Secured Put' :
            form.strategy === 'Iron Condor'      ? 'Open Iron Condor' :
            form.strategy === 'Iron Butterfly'   ? 'Open Iron Butterfly' :
            form.strategy === 'Bull Put Spread'  ? 'Open Bull Put Spread' :
            form.strategy === 'Bear Call Spread' ? 'Open Bear Call Spread' :
            form.strategy === 'Bull Call Spread' ? 'Open Bull Call Spread' :
            form.strategy === 'Bear Put Spread'  ? 'Open Bear Put Spread' :
            form.strategy === 'Long Call'         ? 'Buy Call Option' :
            form.strategy === 'Long Put'          ? 'Buy Put Option' :
            form.strategy === 'Long Straddle'     ? 'Open Long Straddle' :
            form.strategy === 'Long Strangle'     ? 'Open Long Strangle' :
            form.strategy === 'Calendar Spread'   ? 'Open Calendar Spread' :
            form.strategy === 'Diagonal Spread'   ? 'Open Diagonal Spread' :
            'Log Trade'
          }</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={submit} noValidate>
          <div className="modal-body">
          {/* ── Trade Details ── */}
          <div className="modal-section-title">Trade Details</div>
          <div className="form-grid-3">
            <div className="form-group">
              <label className="form-label">Ticker *</label>
              <input value={form.ticker} onChange={e => set('ticker', e.target.value.toUpperCase())}
                style={{ textTransform:'uppercase', borderColor: showErrors && errors.ticker ? 'var(--red,#c0392b)' : '' }} />
              {showErrors && <FieldError msg={errors.ticker} />}
            </div>
            <div className="form-group">
              <label className="form-label">Strategy *</label>
              <select value={form.strategy} onChange={e => set('strategy', e.target.value)}>
                {STRATEGIES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Contracts *
                <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>(multiple of 100)</span>
              </label>
              <input type="number" min="1" step="1" value={form.contracts}
                onChange={e => set('contracts', e.target.value)}
                style={{ borderColor: showErrors && errors.contracts ? 'var(--red,#c0392b)' : '' }} />
              {showErrors && <FieldError msg={errors.contracts} />}
              <FieldWarn msg={warnings.contracts} />
            </div>
          </div>

          {/* ── Chain conflict warning ── */}
          {chainWarning && (
            <div style={{
              margin: '4px 0 10px', padding: '10px 14px',
              background: 'var(--amber-bg)', border: '1px solid var(--amber-border)',
              borderRadius: 8, fontSize: 13,
            }}>
              <div style={{ fontWeight: 700, color: 'var(--amber)', marginBottom: 6 }}>
                ⚠ {chainWarning.chains.length > 1 ? chainWarning.chains.length + ' open ' : 'Open '}
                {chainWarning.type === 'ic' ? 'IC/IB' : 'Calendar'} chain{chainWarning.chains.length > 1 ? 's' : ''} on {form.ticker?.trim().toUpperCase()} — did you mean to adjust one?
              </div>
              {chainWarning.chains.map((ch, ci) => (
                <div key={ch.chainId} style={{
                  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8,
                  padding: '6px 8px', marginBottom: 6,
                  background: 'var(--surface, #fff)', borderRadius: 6,
                  border: '1px solid var(--amber-border)',
                  fontSize: 11,
                }}>
                  <span style={{ fontWeight: 700, color: 'var(--amber)', minWidth: 70 }}>Chain #{Math.abs(ch.chainId)}</span>
                  {chainWarning.type === 'ic' && ch.putLeg && (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      Put ${ch.putLeg.strike_sell}/${ch.putLeg.strike_buy}
                    </span>
                  )}
                  {chainWarning.type === 'ic' && ch.callLeg && (
                    <span style={{ color: 'var(--text-secondary)' }}>
                      · Call ${ch.callLeg.strike_sell}/${ch.callLeg.strike_buy}
                    </span>
                  )}
                  {chainWarning.type === 'cal' && ch.strike && (
                    <span style={{ color: 'var(--text-secondary)' }}>Strike ${ch.strike}</span>
                  )}
                  {ch.expiry && (
                    <span style={{ color: 'var(--text-secondary)' }}>· exp {ch.expiry}</span>
                  )}
                  {chainWarning.type === 'ic' && ch.totalCredit > 0 && (
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      · ${ch.totalCredit.toFixed(2)}/sh credit
                    </span>
                  )}
                  {ch.opened && (
                    <span style={{ color: 'var(--text-muted)' }}>· opened {ch.opened}</span>
                  )}
                  <button type="button"
                    onClick={onClose}
                    style={{ marginLeft: 'auto', padding: '2px 10px', fontSize: 11, fontWeight: 600,
                      background: 'var(--amber)', color: '#fff', border: 'none',
                      borderRadius: 5, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    Adjust this chain →
                  </button>
                </div>
              ))}
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontStyle: 'italic', marginTop: 4 }}>
                None of the above — continue below to log a new {chainWarning.type === 'ic' ? 'IC/IB' : 'Calendar'} trade.
              </div>
            </div>
          )}
          {/* Status row — edit mode only */}
          {initial && (
          <div className="form-grid-2" style={{ marginBottom: 4 }}>
            <div className="form-group">
              <label className="form-label">Status</label>
              <select value={form.status} onChange={e => set('status', e.target.value)}>
                <option value="open">Open</option>
                <option value="closed">Closed</option>
              </select>
            </div>
          </div>
          )}

          {/* ── Lot + Entry Date on ONE row for CC/CSP ── */}
          {(isCC) ? (
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">
                {isCC ? 'Linked Stock Lot *' : 'Linked Stock Lot'}
                <span style={{ color: isCC ? 'var(--amber,#b7730a)' : 'var(--text-muted)', fontSize: 10, marginLeft: 4 }}>
                  {isCC  ? 'required — 100 shares per contract' :
                   'optional — links premium to lot if assigned'}
                </span>
              </label>
              <select value={form.lot_id} onChange={e => set('lot_id', e.target.value)}
                style={{ borderColor: showErrors && warnings.lot_id ? 'var(--amber,#b7730a)' : '' }}>
                <option value="">None</option>
                {lots.filter(l => {
                  if (String(l.id) === form.lot_id) return true;
                  if (l.close_date) return false;
                  if (isCC) {
                    const ticker = form.ticker?.trim().toUpperCase();
                    if (ticker && l.ticker?.toUpperCase() !== ticker) return false;
                    const coveredShares = (trades || [])
                      .filter(t => t.lot_id === l.id && t.status === 'open' && t.strategy === 'Covered Call')
                      .reduce((s, t) => s + (t.contracts || 1) * 100, 0);
                    return coveredShares < (l.shares || 0);
                  }
                  return true;
                }).map(l => {
                  if (isCC) {
                    const coveredShares = (trades || [])
                      .filter(t => t.lot_id === l.id && t.status === 'open' && t.strategy === 'Covered Call')
                      .reduce((s, t) => s + (t.contracts || 1) * 100, 0);
                    const available = (l.shares || 0) - coveredShares;
                    return (
                      <option key={l.id} value={l.id}>
                        Lot #{l.id} · {l.ticker} — {available}/{l.shares}sh @ ${parseFloat(l.avg_cost).toFixed(2)}
                        {coveredShares > 0 ? ` (${coveredShares}sh covered)` : ''}
                      </option>
                    );
                  }
                  return <option key={l.id} value={l.id}>{l.ticker} — {l.shares}sh @ ${parseFloat(l.avg_cost).toFixed(2)}</option>;
                })}
              </select>
              {showErrors && <FieldError msg={errors.lot_id} />}
              {showErrors && <FieldWarn msg={warnings.lot_id} />}
            </div>
            {/* Entry Date — same row as Lot for CC/CSP */}
            <div className="form-group">
              <label className="form-label">Entry Date *</label>
              <input type="date" value={form.entry_date || ''} onChange={e => set('entry_date', e.target.value)}
                max={today()}
                style={{ borderColor: showErrors && errors.entry_date ? 'var(--red,#c0392b)' : '' }} />
              {showErrors && <FieldError msg={errors.entry_date} />}
            </div>
          </div>
          ) : null}

          {/* ── Dates section ── */}
          <div className="modal-section-title">Dates</div>
          <div className="form-grid-3">
            {/* Entry Date for non-CC/CSP strategies (CC/CSP already have it above) */}
            {!(isCC) && (
            <div className="form-group">
              <label className="form-label">Entry Date *</label>
              <input type="date" value={form.entry_date || ''} onChange={e => set('entry_date', e.target.value)}
                max={today()}
                style={{ borderColor: showErrors && errors.entry_date ? 'var(--red,#c0392b)' : '' }} />
              {showErrors && <FieldError msg={errors.entry_date} />}
            </div>
            )}
            {/* For CC/CSP expiry is shown in the Expiry Date and Pricing section above */}
            {!(isCC || isCSP) && (
            <div className="form-group">
              <label className="form-label">
                {['Calendar Spread','Diagonal Spread'].includes(form.strategy) ? 'Front Month Expiry (short leg) *' : 'Expiration *'}
              </label>
              <ExpiryDatePicker
                value={form.expiration || ''}
                onChange={v => set('expiration', v)}
                min={form.entry_date || undefined}
                hasError={!!(showErrors && errors.expiration)}
              />
              {showErrors && <FieldError msg={errors.expiration} />}
              <FieldWarn msg={warnings.expiration} />
            </div>
            )}
            {['Calendar Spread','Diagonal Spread'].includes(form.strategy) && (
              <div className="form-group">
                <label className="form-label">Back Month Expiry (long leg) *</label>
                <ExpiryDatePicker
                  value={form.expiration_back || ''}
                  onChange={v => set('expiration_back', v)}
                  min={form.expiration || form.entry_date || undefined}
                  hasError={!!(showErrors && errors.expiration_back)}
                />
                {showErrors && <FieldError msg={errors.expiration_back} />}
                <div style={{ fontSize:10,color:'var(--text-muted)',marginTop:2 }}>Must be after front month — typically 4–8 weeks further out</div>
              </div>
            )}
            {isClosed && (
            <div className="form-group">
              <label className="form-label">Exit / Close Date *</label>
              <input type="date" value={form.exit_date || ''} onChange={e => set('exit_date', e.target.value)}
                min={form.entry_date || undefined}
                max={form.expiration || undefined}
                style={{ borderColor: showErrors && errors.exit_date ? 'var(--red,#c0392b)' : '' }} />
              {showErrors && <FieldError msg={errors.exit_date} />}
            </div>
            )}
          </div>

          {/* ── CC / CSP Entry Recommendations — 3 states ── */}
          {ccRecommendations.state !== 'hidden' && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8,
                display: 'flex', alignItems: 'center', gap: 6 }}>
                {ccRecommendations.state === 'firsttime' ? 'Getting started' : 'Suggested strikes'}
                {ccRecommendations.state === 'cards' && (<>
                  <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, fontSize: 11, color: 'var(--text-muted)' }}>
                    — BSM · click any card to pre-fill
                  </span>

                </>)}
              </div>

              {/* ── State: firsttime — non-broker, no prior CC/CSP → clean form + subscribe note ── */}
              {ccRecommendations.state === 'firsttime' && (
                <div style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-md)', padding: '11px 14px',
                  display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <span style={{ fontSize: 16, lineHeight: 1, marginTop: 1 }}>💡</span>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    Enter your strike price and premium directly from your broker&apos;s option chain.
                    <span style={{ display: 'block', marginTop: 5, color: 'var(--text-muted)', fontSize: 11 }}>
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>✦ myappdata subscribers</span>
                      {' '}get automatic strike suggestions based on your risk tolerance — Conservative, Standard, or Aggressive — with live premiums pre-filled.
                    </span>
                  </div>
                </div>
              )}

              {/* ── State: manual — experienced non-broker, no live price yet → input strip ── */}
              {ccRecommendations.state === 'manual' && (
                <div style={{ background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)',
                  borderRadius: 'var(--radius-md)', padding: '12px 14px' }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--amber,#92600a)', marginBottom: 10,
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ color: fetchSpotFailed ? 'var(--red,#c0392b)' : 'var(--amber,#92600a)' }}>
                      {fetchingSpot
                        ? `Fetching ${form.ticker?.toUpperCase()} price from Yahoo…`
                        : fetchSpotFailed
                          ? `Yahoo couldn't fetch ${form.ticker?.toUpperCase()} — enter spot price manually or retry`
                          : 'No live quote — enter spot price or fetch from Yahoo'}
                    </span>
                    {!fetchingSpot && onFetchSpot && form.ticker?.trim().length > 0 && (
                      <button type="button"
                        onClick={() => {
                          const tk = form.ticker.trim().toUpperCase();
                          setFetchingSpot(true);
                          setFetchSpotFailed(false);
                          onFetchSpot(tk)
                            .then((price) => { if (!price) setFetchSpotFailed(true); })
                            .catch(() => setFetchSpotFailed(true))
                            .finally(() => setFetchingSpot(false));
                        }}
                        style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px',
                          background: 'var(--accent)', color: '#fff', border: 'none',
                          borderRadius: 'var(--radius-sm)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
                        ⟳ Fetch price
                      </button>
                    )}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 8, alignItems: 'flex-end' }}>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        {form.ticker?.toUpperCase() || 'Stock'} spot price *
                      </div>
                      <input type="number" step="0.01" min="0.01"
                        value={manualSpot}
                        onChange={e => setManualSpot(e.target.value)}
                        placeholder="e.g. 248.50"
                        style={{ width: '100%', padding: '7px 9px', fontSize: 13,
                          border: '1px solid var(--amber-border,#f0d898)',
                          borderRadius: 'var(--radius-md)', background: 'var(--bg-card)',
                          fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>
                        IV % <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>(optional — default 28%)</span>
                      </div>
                      <input type="number" step="0.1" min="1" max="500"
                        value={manualIv}
                        onChange={e => { setManualIv(e.target.value); set('iv_entry', e.target.value); }}
                        placeholder="e.g. 32"
                        style={{ width: '100%', padding: '7px 9px', fontSize: 13,
                          border: ccRecommendations.ivSource === 'default' && !form.iv_entry ? '1.5px solid var(--amber-border,#f0d898)' : '1px solid var(--amber-border,#f0d898)',
                          borderRadius: 'var(--radius-md)',
                          background: ccRecommendations.ivSource === 'default' && !form.iv_entry ? 'var(--amber-bg,#fffbe6)' : 'var(--bg-card)',
                          fontFamily: 'var(--font-mono)' }}
                      />
                    </div>
                    <button type="button"
                      onClick={() => { setManualSpot(v => v || ''); setManualIv(v => v || ''); }}
                      disabled={!manualSpot || parseFloat(manualSpot) <= 0}
                      style={{ padding: '7px 14px', fontSize: 12, fontWeight: 600,
                        background: !manualSpot ? 'var(--border)' : 'var(--accent)',
                        color: !manualSpot ? 'var(--text-muted)' : '#fff',
                        border: 'none', borderRadius: 'var(--radius-md)', cursor: !manualSpot ? 'not-allowed' : 'pointer',
                        whiteSpace: 'nowrap' }}>
                      Calculate ▸
                    </button>
                  </div>
                  <div style={{ marginTop: 10, padding: '8px 10px',
                    background: 'var(--bg-hover)', borderRadius: 'var(--radius-sm)',
                    fontSize: 11, color: 'var(--text-secondary)',
                    display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>ℹ</span>
                    <span>
                      Yahoo Finance is tried automatically when you enter a ticker.
                      If unavailable, enter the spot price manually above.
                      Connect a broker for real-time IV and option chain data.
                    </span>
                  </div>
                </div>
              )}

              {/* ── State: cards — recommendations ready ── */}
              {ccRecommendations.state === 'cards' && (<>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                  {ccRecommendations.cards.map((rec, i) => {
                    const isApplied = form.expiration === rec.expiry &&
                      (String(form.strike_sell) === String(rec.strike) ||
                       String(form.strike_buy)  === String(rec.strike));
                    return (
                      <div key={i}
                        onClick={() => applyRecommendation(rec)}
                        style={{
                          border: `2px solid ${isApplied ? rec.color : rec.border}`,
                          borderRadius: 'var(--radius-md)',
                          background: isApplied ? rec.border : rec.bg,
                          padding: '14px 14px',
                          cursor: 'pointer',
                          transition: 'border-color 0.12s, background 0.12s, box-shadow 0.12s',
                          boxShadow: isApplied ? `0 0 0 3px ${rec.border}` : '0 1px 4px rgba(0,0,0,0.06)',
                        }}
                        title={`Click to pre-fill: ${rec.expiry} · $${rec.strike} · $${rec.price}`}
                      >
                        <div style={{ fontWeight: 700, fontSize: 12, color: rec.color, marginBottom: 2 }}>
                          {rec.label}
                          {isApplied && <span style={{ marginLeft: 5, fontSize: 10, background: rec.color,
                            color: '#fff', borderRadius: 3, padding: '1px 4px' }}>Applied</span>}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 7 }}>
                          {rec.sublabel}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 8px', fontSize: 11 }}>
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Strike</span><br/>
                            <span style={{ fontWeight: 700, color: rec.color, fontFamily: 'var(--font-mono)' }}>
                              ${rec.strike}
                            </span>
                            <span style={{ fontSize: 10, marginLeft: 3,
                              color: parseFloat(rec.pctOtm) > 25 ? 'var(--red,#c0392b)'
                                   : parseFloat(rec.pctOtm) > 15 ? 'var(--amber,#92600a)'
                                   : 'var(--text-muted)',
                              fontWeight: parseFloat(rec.pctOtm) > 15 ? 700 : 400,
                            }}>
                              {rec.pctOtm}% OTM
                            </span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Premium</span><br/>
                            <span style={{ fontWeight: 700, color: 'var(--green)', fontFamily: 'var(--font-mono)' }}>
                              ${rec.price}
                            </span>
                            <span style={{ fontSize: 10, color: 'var(--text-muted)', marginLeft: 3 }}>
                              ${rec.totalPremium} total
                            </span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Expiry</span><br/>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{rec.expiry}</span>
                          </div>
                          <div>
                            <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>Δ / Θ</span><br/>
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                              {rec.delta.toFixed(2)} / {rec.theta.toFixed(2)}
                            </span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {ccRecommendations.iv > 60 && (
                  <div style={{
                    margin: '8px 0 0', padding: '7px 10px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--amber-bg, #fffbe6)',
                    border: '1px solid var(--amber-border, #f0d898)',
                    fontSize: 11, color: 'var(--amber, #92600a)',
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                  }}>
                    <span style={{ fontWeight: 700, flexShrink: 0 }}>⚠ High IV ({ccRecommendations.iv.toFixed(0)}%)</span>
                    <span>— these strikes look wide because the market expects {form.ticker} to move a lot. Check your broker&apos;s option chain and pick a strike with a real bid before using these suggestions.</span>
                  </div>
                )}
                <div style={{
                  marginTop: 8,
                  padding: '7px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: ccRecommendations.ivSource === 'live'
                    ? 'var(--bg-secondary, #f7f7f5)'
                    : form.iv_entry
                      ? 'var(--bg-secondary, #f7f7f5)'
                      : 'var(--amber-bg, #fffbe6)',
                  border: ccRecommendations.ivSource === 'live'
                    ? '1px solid var(--border)'
                    : form.iv_entry
                      ? '1px solid var(--border)'
                      : '1px solid var(--amber-border, #f0d898)',
                  display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '4px 8px',
                }}>
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    ⓘ BSM using{' '}
                    {ccRecommendations.spotSource === 'live' && `live spot $${ccRecommendations.spot}`}
                    {ccRecommendations.spotSource === 'manual' && `your spot $${ccRecommendations.spot}`}
                    {ccRecommendations.spotSource === 'lot' && `lot avg cost $${ccRecommendations.spot} as proxy`}
                    {' · '}
                    {ccRecommendations.ivSource === 'live' && <strong style={{ color: 'var(--green)' }}>{`live IV ${ccRecommendations.iv.toFixed(0)}%`}</strong>}
                    {ccRecommendations.ivSource === 'manual' && <strong style={{ color: 'var(--accent)' }}>{`your IV ${ccRecommendations.iv.toFixed(0)}%`}</strong>}
                    {ccRecommendations.ivSource === 'default' && <strong style={{ color: 'var(--amber, #92600a)' }}>IV 28% (default — strikes are rough estimates only)</strong>}
                  </span>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ fontSize: 11, fontWeight: 600,
                        color: ccRecommendations.ivSource === 'default' ? 'var(--amber, #92600a)' : 'var(--text-muted)' }}>
                        {ccRecommendations.ivSource === 'default'
                          ? '· enter actual IV for accurate strikes:'
                          : '· override IV:'}
                      </span>
                      <input
                        type="text" inputMode="decimal"
                        value={form.iv_entry || ''}
                        onChange={e => {
                          const v = e.target.value;
                          if (v === '' || /^\d*\.?\d*$/.test(v)) {
                            set('iv_entry', v);
                            if (v) set('_showGreeks', true);
                          }
                        }}
                        onBlur={e => {
                          const n = parseFloat(e.target.value);
                          if (isNaN(n) || n <= 0) set('iv_entry', '');
                        }}
                        placeholder={ccRecommendations.ivSource === 'live'
                          ? String(Math.round(ccRecommendations.iv))
                          : 'e.g. 32'}
                        style={{
                          width: 66, padding: '3px 7px', fontSize: 12,
                          border: ccRecommendations.ivSource === 'default' && !form.iv_entry
                            ? '1.5px solid var(--amber-border, #f0d898)'
                            : '1.5px solid var(--border)',
                          borderRadius: 'var(--radius-sm)',
                          background: 'var(--bg-card)',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-primary)',
                          fontWeight: 600,
                        }}
                      />
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 600 }}>%</span>
                      {form.iv_entry && (
                        <button type="button" onClick={() => set('iv_entry', '')}
                          title={ccRecommendations.ivSource === 'live' ? 'Clear override — revert to live IV' : 'Clear — revert to 28% default'}
                          style={{ fontSize: 12, lineHeight: 1, padding: '1px 5px',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-sm)',
                            background: 'transparent',
                            color: 'var(--text-muted)',
                            cursor: 'pointer' }}>
                          ✕
                        </button>
                      )}
                    </span>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>· override any field after applying</span>
                </div>
              </>)}
            </div>
          )}

          {/* ── Option Type toggle — shown ABOVE section title for Cal/Diagonal ── */}
          {(form.strategy === 'Calendar Spread' || form.strategy === 'Diagonal Spread') && (
            <div className="form-group" style={{ marginBottom: 12 }}>
              <label className="form-label">Option Type *
                <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>call or put calendar — affects direction, alerts and pricing</span>
              </label>
              <div style={{ display:'flex', gap:8, marginTop:4 }}>
                {['call','put'].map(ot => (
                  <button key={ot} type="button"
                    onClick={() => set('option_type', ot)}
                    className={`btn btn-sm ${form.option_type===ot ? 'btn-primary' : 'btn-outline'}`}
                    style={{ flex:1, textTransform:'capitalize', fontWeight:700 }}>
                    {ot === 'call' ? '📈 Calls' : '📉 Puts'}
                  </button>
                ))}
              </div>
              {showErrors && <FieldError msg={errors.option_type} />}
              {form.option_type && (
                <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:4 }}>
                  {form.option_type === 'call'
                    ? 'Call calendar — neutral to slightly bullish. Profits when stock stays near the strike. Hurt by a sharp drop.'
                    : 'Put calendar — neutral to slightly bearish. Profits when stock stays near the strike. Hurt by a sharp rally.'}
                </div>
              )}
            </div>
          )}

          {/* ── Pricing — title changes for CC/CSP and Cal/Diagonal ── */}
          <div className="modal-section-title">
            {(isCC || isCSP) ? 'Expiry Date and Pricing' : isCalDiag ? 'Strikes and Prices' : 'Pricing'}
          </div>
          <div className="form-grid-3">
            {/* For CC/CSP: show Expiry here (moved from Dates section) alongside Strike and Premium */}
            {(isCC || isCSP) && (
            <div className="form-group">
              <label className="form-label">Expiration *</label>
              <ExpiryDatePicker
                value={form.expiration || ''}
                onChange={v => set('expiration', v)}
                min={form.entry_date || undefined}
                hasError={!!(showErrors && errors.expiration)}
              />
              {showErrors && <FieldError msg={errors.expiration} />}
              <FieldWarn msg={warnings.expiration} />
            </div>
            )}
            {/* entry_price field — hidden for IC/IB (computed from put_credit + call_credit automatically) */}
            {/* Calendar/Diagonal: strikes first, then two-field pricing model */}
            {!isIC && isCalDiag && (
              <>
                {/* ── (a) STRIKES — first ── */}
                {/* Calendar — single strike (both legs same strike) */}
                {form.strategy === 'Calendar Spread' && (() => {
                  const ot = form.option_type === 'put' ? 'P' : 'C';
                  return (
                    <div className="form-group">
                      <label className="form-label">Strike *
                        <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>both legs — short front month, long back month</span>
                      </label>
                      <input type="number" step="0.5" value={form.strike_sell || ''}
                        onChange={e => set('strike_sell', e.target.value)}
                        style={{ borderColor: showErrors && errors.strike_sell ? 'var(--red,#c0392b)'
                          : warnings.strike_sell ? 'var(--amber)' : '' }} />
                      {showErrors && <FieldError msg={errors.strike_sell} />}
                      {warnings.strike_sell && <FieldWarn msg={warnings.strike_sell} />}
                      {form.strike_sell && (
                        <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3 }}>
                          Sell ${form.strike_sell}{ot} front month · Buy ${form.strike_sell}{ot} back month
                          {spot > 0 && !isNaN(parseFloat(form.strike_sell)) && (
                            <span style={{ marginLeft:6, color: Math.abs(parseFloat(form.strike_sell)-spot)/spot > 0.15 ? 'var(--amber)' : 'var(--green)' }}>
                              · {(Math.abs(parseFloat(form.strike_sell)-spot)/spot*100).toFixed(1)}% from spot
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
                {/* Diagonal — two different strikes side by side */}
                {form.strategy === 'Diagonal Spread' && (() => {
                  const ot = form.option_type === 'put' ? 'P' : 'C';
                  return (
                    <>
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, gridColumn:'span 3' }}>
                        <div className="form-group" style={{ margin:0 }}>
                          <label className="form-label">Short Leg Strike *</label>
                          <input type="number" step="0.5" value={form.strike_sell || ''}
                            onChange={e => set('strike_sell', e.target.value)}
                            style={{ borderColor: showErrors && errors.strike_sell ? 'var(--red,#c0392b)'
                              : warnings.strike_sell ? 'var(--amber)' : '' }} />
                          <div style={{ color:'var(--text-muted)', fontSize:10, marginTop:3 }}>
                            front month {ot === 'C' ? 'call' : 'put'} sold · typically 5–15% OTM
                          </div>
                          {showErrors && <FieldError msg={errors.strike_sell} />}
                          {warnings.strike_sell && <FieldWarn msg={warnings.strike_sell} />}
                        </div>
                        <div className="form-group" style={{ margin:0 }}>
                          <label className="form-label">Long Leg Strike *</label>
                          <input type="number" step="0.5" value={form.strike_buy || ''}
                            onChange={e => set('strike_buy', e.target.value)}
                            style={{ borderColor: showErrors && errors.strike_buy ? 'var(--red,#c0392b)'
                              : warnings.strike_buy ? 'var(--amber)' : '' }} />
                          <div style={{ color:'var(--text-muted)', fontSize:10, marginTop:3 }}>
                            back month {ot === 'C' ? 'call' : 'put'} bought · same or further OTM than short
                          </div>
                          {showErrors && <FieldError msg={errors.strike_buy} />}
                          {warnings.strike_buy && <FieldWarn msg={warnings.strike_buy} />}
                        </div>
                      </div>
                      {form.strike_sell && form.strike_buy && (
                        <div style={{ fontSize:10, marginTop:3, gridColumn:'span 3',
                          color: parseFloat(form.strike_sell) === parseFloat(form.strike_buy) ? 'var(--amber)' : 'var(--text-muted)' }}>
                          {parseFloat(form.strike_sell) === parseFloat(form.strike_buy)
                            ? `⚠ Same strike on both legs — that is a Calendar Spread. Change strategy or use different strikes.`
                            : <>Sell ${form.strike_sell}{ot} front · Buy ${form.strike_buy}{ot} back &nbsp;·&nbsp;
                              {parseFloat(form.strike_buy) > parseFloat(form.strike_sell)
                                ? <span style={{ color:'var(--green)' }}>bullish diagonal (long strike higher)</span>
                                : <span style={{ color:'var(--red)' }}>bearish diagonal (long strike lower)</span>}
                              {spot > 0 && !isNaN(parseFloat(form.strike_sell)) && (
                                <span style={{ marginLeft:6, color:'var(--text-muted)' }}>
                                  · short {(Math.abs(parseFloat(form.strike_sell)-spot)/spot*100).toFixed(1)}% from spot
                                </span>
                              )}
                            </>
                          }
                        </div>
                      )}
                    </>
                  );
                })()}

                {/* ── (b) PRICING — Front Month Credit · Back Month Cost · Net Debit ── */}
                {/* Field 1: Short leg (front month) credit */}
                <div className="form-group">
                  <label className="form-label">Front Month Credit *
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>premium received from the short leg — per share</span>
                  </label>
                  <input type="number" step="0.01" min="0.01"
                    value={form.cal_short_credit || ''}
                    onChange={e => set('cal_short_credit', e.target.value)}
                    placeholder="e.g. 2.50"
                    style={{ borderColor: showErrors && errors.cal_short_credit ? 'var(--red,#c0392b)' : '' }} />
                  {showErrors && <FieldError msg={errors.cal_short_credit} />}
                </div>
                {/* Field 2: Long leg (back month) cost */}
                <div className="form-group">
                  <label className="form-label">Back Month Cost *
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>premium paid for the long leg — per share</span>
                  </label>
                  <input type="number" step="0.01" min="0.01"
                    value={form.cal_long_cost || ''}
                    onChange={e => set('cal_long_cost', e.target.value)}
                    placeholder="e.g. 4.20"
                    style={{ borderColor: showErrors && (errors.cal_long_cost || warnings.cal_long_cost) ? (errors.cal_long_cost ? 'var(--red,#c0392b)' : 'var(--amber,#b7730a)') : '' }} />
                  {showErrors && <FieldError msg={errors.cal_long_cost} />}
                  {showErrors && <FieldWarn msg={warnings.cal_long_cost} />}
                </div>
                {/* Field 3: Net Debit — computed, read-only, greyed */}
                <div className="form-group">
                  <label className="form-label" style={{ color:'var(--text-muted)' }}>Net Debit
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>back month cost minus front month credit — calculated</span>
                  </label>
                  <input type="number" step="0.01"
                    value={calNetDebit != null ? calNetDebit : ''}
                    readOnly
                    placeholder="—"
                    style={{ background:'var(--bg-hover)', color:'var(--text-muted)', cursor:'not-allowed', borderColor: calNetDebit != null && calNetDebit <= 0 ? 'var(--red,#c0392b)' : 'var(--border)' }} />
                  {calNetDebit != null && calNetDebit > 0 && (
                    <div style={{ fontSize:10, color:'var(--green)', marginTop:3 }}>
                      ${(calNetDebit * 100).toFixed(2)}/contract · Total: ${(calNetDebit * (parseInt(form.contracts)||1) * 100).toLocaleString()} for {form.contracts||1} contract{parseInt(form.contracts)>1?'s':''} <span style={{color:'var(--text-muted)'}}>({calNetDebit.toFixed(2)}/sh)</span>
                    </div>
                  )}
                  {calNetDebit != null && calNetDebit <= 0 && (
                    <div style={{ fontSize:10, color:'var(--red)', marginTop:3 }}>
                      {form.strategy === 'Diagonal Spread'
                        ? `Net credit of $${Math.abs(calNetDebit).toFixed(2)} — this is a credit diagonal. Unusual — verify the values.`
                        : `Back month ($${calLongCost.toFixed(2)}) must be greater than front month ($${calShortCredit.toFixed(2)}) for a calendar spread.`}
                    </div>
                  )}
                </div>
              </>
            )}
            {!isIC && !isCalDiag && (
            <div className="form-group">
              <label className="form-label">
                {isCC  ? 'Premium Collected *' :
                 isCSP ? 'Premium Collected *' :
                 form.strategy === 'Long Call'      ? 'Premium Paid *' :
                 form.strategy === 'Long Put'       ? 'Premium Paid *' :
                 form.strategy === 'Long Straddle'  ? 'Total Debit Paid *' :
                 form.strategy === 'Long Strangle'  ? 'Total Debit Paid *' :
                 form.strategy === 'Bull Call Spread'  ? 'Net Debit Paid *' :
                 form.strategy === 'Bear Put Spread'   ? 'Net Debit Paid *' :
                 'Net Credit Received *'}
                <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>
                  {isCC || isCSP ? 'per share' :
                   (form.strategy === 'Long Straddle' || form.strategy === 'Long Strangle')
                     ? 'combined cost of both legs · per share' :
                   (form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread')
                     ? 'long leg cost minus short leg credit · per share' :
                   'per share'}
                </span>
              </label>
              <input type="number" step="0.01" min="0.01" value={form.entry_price || ''}
                onChange={e => { set('entry_price', e.target.value); setEstPremium(false); setIsPrefilled(false); }}
                style={{
                  borderColor: estPremium ? 'var(--amber,#b7730a)' : showErrors && errors.entry_price ? 'var(--red,#c0392b)' : '',
                  paddingRight: estPremium ? 42 : undefined,
                  backgroundImage: estPremium ? 'none' : undefined,
                }} />
              {estPremium && (
                <div style={{ fontSize: 10, color: 'var(--amber,#92600a)', marginTop: 3,
                  display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)',
                    borderRadius: 3, padding: '1px 5px', fontWeight: 700, fontSize: 10 }}>est.</span>
                  BSM estimate — enter your actual fill price
                </div>
              )}
              {isPrefilled && !estPremium && (
                <div style={{ fontSize: 10, color: 'var(--amber,#92600a)', marginTop: 3,
                  display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)',
                    borderRadius: 3, padding: '1px 5px', fontWeight: 700, fontSize: 10 }}>⚡</span>
                  Pre-filled from recommendation — confirm your actual fill price
                </div>
              )}
              {appliedRec && !estPremium && (() => {
                const strikeChanged = (isCC  && form.strike_sell && String(form.strike_sell) !== appliedRec.strike) ||
                                      (isCSP && form.strike_buy  && String(form.strike_buy)  !== appliedRec.strike);
                return strikeChanged ? (
                  <div style={{ fontSize: 10, color: 'var(--amber,#92600a)', marginTop: 3,
                    display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ background: 'var(--amber-bg,#fffbe6)', border: '1px solid var(--amber-border,#f0d898)',
                      borderRadius: 3, padding: '1px 5px', fontWeight: 700, fontSize: 10 }}>⚠</span>
                    Strike changed from card — premium was priced at ${appliedRec.strike}. Update premium for the new strike.
                  </div>
                ) : null;
              })()}
              {showErrors && <FieldError msg={errors.entry_price} />}
              <FieldWarn msg={warnings.entry_price} />
            </div>
            )} {/* end !isIC */}
            {/* CC — Call Strike inline with Expiry + Premium on same row */}
            {isCC && (
              <div className="form-group">
                <label className="form-label">Call Strike *
                  <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>the strike you sold</span>
                </label>
                <input type="number" step="0.5" value={form.strike_sell || ''}
                  onChange={e => { set('strike_sell', e.target.value); setAppliedRec(null); }}
                  style={{ borderColor: showErrors && (errors.strike_sell || warnings.strike_sell) ? (errors.strike_sell ? 'var(--red,#c0392b)' : 'var(--amber,#b7730a)') : '' }} />
                {showErrors && <FieldError msg={errors.strike_sell} />}
                {showErrors && <FieldWarn msg={warnings.strike_sell} />}
              </div>
            )}
          </div>
          {/* ── Live cash confirmation — appears as soon as price + contracts filled ── */}
          {form.entry_price && form.contracts && parseFloat(form.entry_price) > 0 && parseInt(form.contracts) >= 1 && (
            <div style={{ fontSize:12, fontWeight:600, padding:'7px 12px', borderRadius:6, marginBottom:8,
              background: (form.strategy==='Bull Call Spread'||form.strategy==='Bear Put Spread'||
                           form.strategy==='Calendar Spread'||form.strategy==='Diagonal Spread'||
                           form.strategy==='Long Straddle'||form.strategy==='Long Strangle'||
                           form.strategy==='Long Call'||form.strategy==='Long Put')
                ? 'var(--amber-bg,#fff8e1)' : 'var(--green-bg,#e8f5e9)',
              border: (form.strategy==='Bull Call Spread'||form.strategy==='Bear Put Spread'||
                       form.strategy==='Calendar Spread'||form.strategy==='Diagonal Spread'||
                       form.strategy==='Long Straddle'||form.strategy==='Long Strangle'||
                       form.strategy==='Long Call'||form.strategy==='Long Put')
                ? '1px solid var(--amber-border,#ffe082)' : '1px solid var(--green-border,#a5d6a7)',
              color: (form.strategy==='Bull Call Spread'||form.strategy==='Bear Put Spread'||
                      form.strategy==='Calendar Spread'||form.strategy==='Diagonal Spread'||
                      form.strategy==='Long Straddle'||form.strategy==='Long Strangle'||
                      form.strategy==='Long Call'||form.strategy==='Long Put')
                ? 'var(--amber,#b7730a)' : 'var(--green,#1a7a4a)',
            }}>
              {(isCC || isCSP || form.strategy==='Bull Put Spread' || form.strategy==='Bear Call Spread') && <>
                💰 Premium collected: <strong>${(parseFloat(form.entry_price) * parseInt(form.contracts) * 100).toLocaleString()}</strong>
                <span style={{fontWeight:400, marginLeft:8, fontSize:11}}>
                  ${form.entry_price} × {form.contracts} contract{parseInt(form.contracts)>1?'s':''} × 100 shares
                </span>
              </>}
              {(form.strategy==='Long Call'||form.strategy==='Long Put') && <>
                💸 Total cost: <strong>${(parseFloat(form.entry_price) * parseInt(form.contracts) * 100).toLocaleString()}</strong>
                <span style={{fontWeight:400, marginLeft:8, fontSize:11}}>max loss if expires worthless</span>
              </>}
              {(form.strategy==='Long Straddle'||form.strategy==='Long Strangle') && <>
                💸 Total debit: <strong>${(parseFloat(form.entry_price) * parseInt(form.contracts) * 100).toLocaleString()}</strong>
                <span style={{fontWeight:400, marginLeft:8, fontSize:11}}>both legs combined — breakeven requires a move larger than this</span>
              </>}
              {(form.strategy==='Bull Call Spread'||form.strategy==='Bear Put Spread') && <>
                💸 Net debit: <strong>${(parseFloat(form.entry_price) * parseInt(form.contracts) * 100).toLocaleString()}</strong>
                <span style={{fontWeight:400, marginLeft:8, fontSize:11}}>max loss on the trade</span>
              </>}
              {(form.strategy==='Calendar Spread'||form.strategy==='Diagonal Spread') && calNetDebit != null && calNetDebit > 0 && <>
                💸 Net debit: <strong>${(calNetDebit * parseInt(form.contracts) * 100).toLocaleString()}</strong>
                <span style={{fontWeight:400, marginLeft:8, fontSize:11}}>(${calNetDebit.toFixed(2)} × {form.contracts || 1} contract{parseInt(form.contracts)>1?'s':''} × 100 shares)</span>
              </>}
            </div>
          )}
          {/* Buy back / close price — only shown when editing a closed trade */}
          {isClosed && (
          <div className="form-group">
            <label className="form-label">
              {isCC || isCSP ? 'Buy Back Price *' :
               isLong ? 'Sale Price *' :
               (form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread' ||
                form.strategy === 'Calendar Spread'  || form.strategy === 'Diagonal Spread')
                 ? 'Close Debit *' : 'Buy Back / Close Price *'}
              <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>per share</span>
            </label>
            <input type="number" step="0.01" min="0" value={form.exit_price !== undefined ? form.exit_price : ''}
              onChange={e => set('exit_price', e.target.value)}
              style={{ borderColor: showErrors && errors.exit_price ? 'var(--red,#c0392b)' : '' }} />
            {showErrors && <FieldError msg={errors.exit_price} />}
            {showErrors && <FieldWarn msg={warnings.exit_price} />}
          </div>
          )}

          {/* ── Strikes ── */}
          {isIC ? (
            /* Iron Condor: two-wing entry panel */
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 }}>
                {form.strategy === 'Iron Butterfly'
                  ? 'Iron Butterfly — Sell ATM Put & Call (body), Buy OTM Wings'
                  : 'Iron Condor — Enter Put Wing & Call Wing Separately'}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, background: 'var(--blue-bg)', border: '1px solid var(--blue-border)', borderRadius: 8, padding: 12, marginBottom: 8 }}>
                {/* PUT WING */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>📉 Put Wing (Bull Put Spread)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Sell Put Strike *</label>
                      <input type="number" step="0.5" value={form.put_strike_sell || ''}
                        onChange={e => set('put_strike_sell', e.target.value)}
                        style={{ borderColor: showErrors && !form.put_strike_sell ? 'var(--red,#c0392b)' : '' }} />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Buy Put Strike *</label>
                      <input type="number" step="0.5" value={form.put_strike_buy || ''}
                        onChange={e => set('put_strike_buy', e.target.value)}
                        style={{ borderColor: showErrors && !form.put_strike_buy ? 'var(--red,#c0392b)' : '' }} />
                    </div>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Put Wing Credit * ($ per share)</label>
                    <input type="number" step="0.01" value={form.put_credit || ''}
                      onChange={e => set('put_credit', e.target.value)}
                      style={{ borderColor: showErrors && !form.put_credit ? 'var(--red,#c0392b)' : '' }} />
                  </div>
                  {form.put_strike_sell && form.put_strike_buy && parseFloat(form.put_strike_sell) > parseFloat(form.put_strike_buy) && (
                    <div style={{ fontSize: 10, color: 'var(--green)', marginTop: 4 }}>
                      Sell ${form.put_strike_sell}P / Buy ${form.put_strike_buy}P — width ${(parseFloat(form.put_strike_sell) - parseFloat(form.put_strike_buy)).toFixed(0)}
                    </div>
                  )}
                  {showErrors && form.put_strike_sell && form.put_strike_buy && parseFloat(form.put_strike_sell) <= parseFloat(form.put_strike_buy) && (
                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>⚠ Sell put must be ABOVE buy put</div>
                  )}
                </div>
                {/* CALL WING */}
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--red)', marginBottom: 6 }}>📈 Call Wing (Bear Call Spread)</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Sell Call Strike *</label>
                      <input type="number" step="0.5" value={form.call_strike_sell || ''}
                        onChange={e => set('call_strike_sell', e.target.value)}
                        style={{ borderColor:
                          form.strategy === 'Iron Butterfly' && form.put_strike_sell && form.call_strike_sell &&
                          parseFloat(form.call_strike_sell) !== parseFloat(form.put_strike_sell)
                            ? 'var(--red,#c0392b)'
                            : showErrors && !form.call_strike_sell ? 'var(--red,#c0392b)' : '' }} />
                      {/* IB hard error — below the input, red, not above it as a soft amber hint */}
                      {form.strategy === 'Iron Butterfly' && form.put_strike_sell && form.call_strike_sell &&
                       parseFloat(form.call_strike_sell) !== parseFloat(form.put_strike_sell) && (
                        <div style={{ fontSize: 11, color: 'var(--red,#c0392b)', marginTop: 4, fontWeight: 600 }}>
                          ✕ Must equal {form.put_strike_sell} (ATM body) — both short strikes must be identical for an Iron Butterfly.
                        </div>
                      )}
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>Buy Call Strike *</label>
                      <input type="number" step="0.5" value={form.call_strike_buy || ''}
                        onChange={e => set('call_strike_buy', e.target.value)}
                        style={{ borderColor: showErrors && !form.call_strike_buy ? 'var(--red,#c0392b)' : '' }} />
                    </div>
                  </div>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label className="form-label" style={{ fontSize: 11 }}>Call Wing Credit * ($ per share)</label>
                    <input type="number" step="0.01" value={form.call_credit || ''}
                      onChange={e => set('call_credit', e.target.value)}
                      style={{ borderColor: showErrors && !form.call_credit ? 'var(--red,#c0392b)' : '' }} />
                  </div>
                  {form.call_strike_sell && form.call_strike_buy && parseFloat(form.call_strike_sell) < parseFloat(form.call_strike_buy) && (
                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>
                      Sell ${form.call_strike_sell}C / Buy ${form.call_strike_buy}C — width ${(parseFloat(form.call_strike_buy) - parseFloat(form.call_strike_sell)).toFixed(0)}
                    </div>
                  )}
                  {showErrors && form.call_strike_sell && form.call_strike_buy && parseFloat(form.call_strike_sell) >= parseFloat(form.call_strike_buy) && (
                    <div style={{ fontSize: 10, color: 'var(--red)', marginTop: 4 }}>⚠ Sell call must be BELOW buy call</div>
                  )}
                </div>
              </div>
              {/* IC profit zone summary */}
              {form.put_strike_sell && form.call_strike_sell && form.put_credit && form.call_credit && (
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', background: 'var(--green-bg)', border: '1px solid var(--green-border)', borderRadius: 6, padding: '6px 10px' }}>
                  {form.strategy === 'Iron Butterfly' ? (() => {
                    const _ibCredit = parseFloat(form.put_credit||0) + parseFloat(form.call_credit||0);
                    const _ibBody   = parseFloat(form.put_strike_sell||0);
                    const _beLow    = (_ibBody - _ibCredit).toFixed(2);
                    const _beHigh   = (_ibBody + _ibCredit).toFixed(2);
                    return (<><strong>IB body:</strong> ${form.put_strike_sell} (ATM short) &nbsp;·&nbsp;
                    <strong>Break-even:</strong> ${_beLow} – ${_beHigh} &nbsp;·&nbsp;
                    <strong>Total credit:</strong> ${_ibCredit.toFixed(2)}/share
                    &nbsp;= ${Math.round(_ibCredit * (parseInt(form.contracts)||1) * 100)} total</>);
                  })() : (
                    <><strong>Profit zone:</strong> ${form.put_strike_sell} – ${form.call_strike_sell} &nbsp;·&nbsp;
                    <strong>Total credit:</strong> ${(parseFloat(form.put_credit||0) + parseFloat(form.call_credit||0)).toFixed(2)}/share
                    &nbsp;= ${Math.round((parseFloat(form.put_credit||0) + parseFloat(form.call_credit||0)) * (parseInt(form.contracts)||1) * 100)} total</>
                  )}
                </div>
              )}
            </div>
          ) : (
          <div className="form-grid-3">
            {/* CC Call Strike now in Expiry+Premium row above */}
            {/* CSP — one field: the put strike you sold */}
            {isCSP && (
              <div className="form-group">
                <label className="form-label">Put Strike *
                  <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>the strike you sold</span>
                </label>
                <input type="number" step="0.5" value={form.strike_buy || ''}
                  onChange={e => { set('strike_buy', e.target.value); setAppliedRec(null); }}
                  style={{ borderColor: showErrors && errors.strike_buy ? 'var(--red,#c0392b)'
                    : warnings.strike_buy ? 'var(--amber,#b7730a)' : '' }} />
                {showErrors && <FieldError msg={errors.strike_buy} />}
                <FieldWarn msg={warnings.strike_buy} />
              </div>
            )}
            {/* Long Call / Long Put — one field: the strike you bought */}
            {(form.strategy === 'Long Call' || form.strategy === 'Long Put') && (
              <div className="form-group">
                <label className="form-label">
                  {form.strategy === 'Long Call' ? 'Call Strike *' : 'Put Strike *'}
                  <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>the strike you bought</span>
                </label>
                <input type="number" step="0.5" value={form.strike_buy || ''}
                  onChange={e => set('strike_buy', e.target.value)}
                  style={{ borderColor: showErrors && errors.strike_buy ? 'var(--red,#c0392b)' : '' }} />
                {showErrors && <FieldError msg={errors.strike_buy} />}
              </div>
            )}
            {/* Straddle / Strangle — put + call strikes + live breakeven */}
            {(form.strategy === 'Long Straddle' || form.strategy === 'Long Strangle') && (
              <>
                <div className="form-group">
                  <label className="form-label">Put Strike *
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>
                      {form.strategy === 'Long Straddle' ? 'ATM — same as call strike' : 'OTM put leg — below current price'}
                    </span>
                  </label>
                  <input type="number" step="0.5" value={form.strike_buy || ''}
                    onChange={e => set('strike_buy', e.target.value)}
                    style={{ borderColor: showErrors && errors.strike_buy ? 'var(--red,#c0392b)' : '' }} />
                  {showErrors && <FieldError msg={errors.strike_buy} />}
                </div>
                <div className="form-group">
                  <label className="form-label">Call Strike *
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>
                      {form.strategy === 'Long Straddle' ? 'ATM — same as put strike' : 'OTM call leg — above current price'}
                    </span>
                  </label>
                  <input type="number" step="0.5" value={form.strike_sell || ''}
                    onChange={e => set('strike_sell', e.target.value)}
                    style={{ borderColor: showErrors && errors.strike_sell ? 'var(--red,#c0392b)' : '' }} />
                  {showErrors && <FieldError msg={errors.strike_sell} />}
                </div>
                {form.strike_buy && form.strike_sell && form.entry_price && (
                  <div style={{ fontSize:10, color:'var(--text-muted)', marginTop:3, gridColumn:'span 2',
                    background:'var(--bg-hover)', borderRadius:4, padding:'5px 8px' }}>
                    Breakeven: below <strong>${(parseFloat(form.strike_buy) - parseFloat(form.entry_price)).toFixed(2)}</strong>
                    {' '}or above <strong>${(parseFloat(form.strike_sell) + parseFloat(form.entry_price)).toFixed(2)}</strong>
                    {' '}· Profit zone width: ${(parseFloat(form.strike_sell) - parseFloat(form.strike_buy)).toFixed(0)} spread
                  </div>
                )}
              </>
            )}
            {/* Credit/Debit Spreads: short leg + long leg (hedge) */}
            {isSpread && (
              <>
                <div className="form-group">
                  <label className="form-label">
                    {form.strategy === 'Bull Put Spread'  ? 'Sell Put Strike *' :
                     form.strategy === 'Bear Call Spread' ? 'Sell Call Strike *' :
                     form.strategy === 'Bull Call Spread' ? 'Buy Call Strike *' :
                     'Buy Put Strike *'}
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>
                      {(form.strategy === 'Bull Put Spread' || form.strategy === 'Bear Call Spread') ? 'Short leg' : 'Long leg'}
                    </span>
                  </label>
                  <input type="number" step="0.5"
                    value={(form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? (form.strike_buy || '') : (form.strike_sell || '')}
                    onChange={e => set((form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? 'strike_buy' : 'strike_sell', e.target.value)}
                    style={{ borderColor: showErrors && ((form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? errors.strike_buy : errors.strike_sell) ? 'var(--red,#c0392b)' : '' }} />
                  {showErrors && <FieldError msg={(form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? errors.strike_buy : errors.strike_sell} />}
                </div>
                <div className="form-group">
                  <label className="form-label">
                    {form.strategy === 'Bull Put Spread'  ? 'Buy Put Strike *' :
                     form.strategy === 'Bear Call Spread' ? 'Buy Call Strike *' :
                     form.strategy === 'Bull Call Spread' ? 'Sell Call Strike *' :
                     'Sell Put Strike *'}
                    <span style={{ color:'var(--text-muted)', fontSize:10, marginLeft:4 }}>
                      {(form.strategy === 'Bull Put Spread' || form.strategy === 'Bear Call Spread') ? 'Long leg' : 'Short leg'}
                    </span>
                  </label>
                  <input type="number" step="0.5"
                    value={(form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? (form.strike_sell || '') : (form.strike_buy || '')}
                    onChange={e => set((form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? 'strike_sell' : 'strike_buy', e.target.value)}
                    style={{ borderColor: showErrors && ((form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? errors.strike_sell : errors.strike_buy) ? 'var(--red,#c0392b)' : '' }} />
                  {showErrors && <FieldError msg={(form.strategy === 'Bull Call Spread' || form.strategy === 'Bear Put Spread') ? errors.strike_sell : errors.strike_buy} />}
                  {showErrors && <FieldWarn msg={warnings.strike_sell} />}
                </div>
              </>
            )}
            {/* P&L — only when closing a trade */}
            {isClosed && (
            <div className="form-group">
              <label className="form-label">Realised P&L
                {computedPnl !== null && <span style={{ color:'var(--green,#1a7a4a)', fontSize:10, marginLeft:4 }}>auto-calculated</span>}
              </label>
              <input type="number" step="0.01" value={form.pnl || ''}
                onChange={e => set('pnl', e.target.value)}
                placeholder={computedPnl !== null ? String(Math.round(computedPnl)) : ''}
                style={{ borderColor: showErrors && warnings.pnl ? 'var(--amber,#b7730a)' : '' }} />
              {showErrors && <FieldWarn msg={warnings.pnl} />}
            </div>
            )}
          </div>
          )}

          {/* Strike relationship hint + max profit/loss for spreads */}
          {isSpread && form.strike_buy && form.strike_sell && !errors.strike_buy && !errors.strike_sell && (
            <div style={{ fontSize:11, color:'var(--text-secondary)', marginTop:-4, marginBottom:8,
              padding:'6px 10px', background:'var(--bg-hover)', borderRadius:6 }}>
              {form.strategy === 'Bull Put Spread' && (
                <>Sell ${form.strike_sell}P / Buy ${form.strike_buy}P &nbsp;·&nbsp;
                Profit zone: stock stays <strong>above ${form.strike_sell}</strong> &nbsp;·&nbsp;
                {form.entry_price && `Max profit $${Math.round(parseFloat(form.entry_price)*(parseInt(form.contracts)||1)*100)} · Max loss $${Math.round((parseFloat(form.strike_sell)-parseFloat(form.strike_buy)-parseFloat(form.entry_price))*(parseInt(form.contracts)||1)*100)}`}
                </>
              )}
              {form.strategy === 'Bear Call Spread' && (
                <>Sell ${form.strike_sell}C / Buy ${form.strike_buy}C &nbsp;·&nbsp;
                Profit zone: stock stays <strong>below ${form.strike_sell}</strong> &nbsp;·&nbsp;
                {form.entry_price && `Max profit $${Math.round(parseFloat(form.entry_price)*(parseInt(form.contracts)||1)*100)} · Max loss $${Math.round((parseFloat(form.strike_buy)-parseFloat(form.strike_sell)-parseFloat(form.entry_price))*(parseInt(form.contracts)||1)*100)}`}
                </>
              )}
              {form.strategy === 'Bull Call Spread' && (
                <>Buy ${form.strike_buy}C / Sell ${form.strike_sell}C &nbsp;·&nbsp;
                Profit if stock rises <strong>above ${form.strike_sell}</strong> &nbsp;·&nbsp;
                {form.entry_price && `Max profit $${Math.round((parseFloat(form.strike_sell)-parseFloat(form.strike_buy)-parseFloat(form.entry_price))*(parseInt(form.contracts)||1)*100)} · Max loss $${Math.round(parseFloat(form.entry_price)*(parseInt(form.contracts)||1)*100)}`}
                </>
              )}
              {form.strategy === 'Bear Put Spread' && (
                <>Buy ${form.strike_buy}P / Sell ${form.strike_sell}P &nbsp;·&nbsp;
                Profit if stock falls <strong>below ${form.strike_buy}</strong> &nbsp;·&nbsp;
                {form.entry_price && `Max profit $${Math.round((parseFloat(form.strike_buy)-parseFloat(form.strike_sell)-parseFloat(form.entry_price))*(parseInt(form.contracts)||1)*100)} · Max loss $${Math.round(parseFloat(form.entry_price)*(parseInt(form.contracts)||1)*100)}`}
                </>
              )}
            </div>
          )}

          {/* ── Greeks ── always shown ── */}
          <div style={{ margin:'12px 0 4px' }}>
            <button type="button"
              onClick={() => set('_showGreeks', !form._showGreeks)}
              style={{ background:'none', border:'none', cursor:'pointer', fontSize:12, color:'var(--text-secondary)',
                fontWeight:600, padding:'4px 0', display:'flex', alignItems:'center', gap:6 }}>
              {form._showGreeks ? '▾' : '▸'}
              Greeks &amp; IV at Entry
              <span style={{ fontSize:11, fontWeight:400, marginLeft:4,
                color: isBrokerConnected ? 'var(--green)' : 'var(--text-muted)' }}>
                {isBrokerConnected
                  ? '✓ auto-filled from broker'
                  : '— IV enables the P&L curve · delta/theta from BSM if blank'}
              </span>
            </button>
          </div>
          {form._showGreeks && (
            <div style={{ background: isBrokerConnected ? 'var(--green-bg)' : 'var(--bg-hover)',
              border: `1px solid ${isBrokerConnected ? 'var(--green-border)' : 'var(--border)'}`,
              borderRadius: 'var(--radius-md)', padding: '10px 12px', marginBottom: 10 }}>
              {isBrokerConnected && (
                <div style={{ fontSize: 11, color: 'var(--green)', fontWeight: 600, marginBottom: 8 }}>
                  ✓ Delta, Theta, Vega, IV auto-filled from broker feed. Edit to override.
                </div>
              )}
              <div className="form-grid-3">
                {[
                  { key: 'delta',    label: 'Delta',  tip: 'Probability of expiring ITM. Short strategies: negative (e.g. −0.27). Long: positive. Short delta above 0.30 indicates increasing assignment probability.' },
                  { key: 'gamma',    label: 'Gamma',  tip: 'Rate of delta change per $1 move in the stock. Always positive. High gamma = delta changes quickly.' },
                  { key: 'theta',    label: 'Theta',  tip: 'Daily time decay in dollars per share. Negative number — e.g. −0.04 means the option loses $4/day per contract. Works in your favour as a CC/CSP seller.' },
                  { key: 'vega',     label: 'Vega',   tip: 'Price change per 1% rise in IV. Positive. Sellers of options have negative vega exposure — rising IV hurts.' },
                  { key: 'iv_entry', label: 'IV %',   tip: 'Implied Volatility as a percentage (e.g. 28 for 28%). Used to draw the P&L Curve and compute roll scenario prices. BSM fallback uses VIX × multiplier if blank.' },
                ].map(({ key, label, tip }) => (
                  <div key={key} className="form-group">
                    <label className="form-label" title={tip}>{label} ⓘ
                      {key === 'delta' && !isBrokerConnected && !form.delta && form.strike_sell && (
                        <span style={{ color:'var(--text-muted)', fontWeight:400, marginLeft:4, fontSize:10 }}>
                          target &lt;0.30
                        </span>
                      )}
                      {key === 'theta' && !isBrokerConnected && (
                        <span style={{ color:'var(--text-muted)', fontWeight:400, marginLeft:4, fontSize:10 }}>
                          per day
                        </span>
                      )}
                      {key === 'iv_entry' && isBrokerConnected && (
                        <span style={{ color:'var(--green)', fontWeight:400, marginLeft:4, fontSize:10 }}>
                          auto
                        </span>
                      )}
                    </label>
                    <input type="number"
                      step={key === 'iv_entry' ? '0.1' : key === 'delta' || key === 'gamma' ? '0.001' : '0.01'}
                      value={form[key] || ''}
                      onChange={e => set(key, e.target.value)}
                      disabled={key === 'iv_entry' && isBrokerConnected}
                      placeholder={
                        key === 'iv_entry'
                          ? (isBrokerConnected ? 'Auto from broker' : 'e.g. 28')
                          : key === 'delta' ? (isBrokerConnected ? '' : 'e.g. −0.27')
                          : key === 'theta' ? (isBrokerConnected ? '' : 'e.g. −0.04')
                          : ''
                      }
                      style={{
                        borderColor: showErrors && (errors[key] || warnings[key])
                          ? (errors[key] ? 'var(--red,#c0392b)' : 'var(--amber,#b7730a)')
                          : '',
                        background: key === 'iv_entry' && isBrokerConnected ? 'var(--bg-hover)' : '',
                        cursor: key === 'iv_entry' && isBrokerConnected ? 'not-allowed' : '',
                      }} />
                    {showErrors && <FieldWarn msg={errors[key] || warnings[key]} />}
                  </div>
                ))}
              </div>
              {form.iv_entry && parseFloat(form.iv_entry) > 0 && parseFloat(form.iv_entry) < 1.0 && (
                <div style={{ fontSize:11, color:'var(--amber,#b7730a)', marginTop:4 }}>
                  ⚠ Looks like a decimal — will be saved as {Math.round(parseFloat(form.iv_entry) * 100 * 10) / 10}%
                </div>
              )}
              {!isBrokerConnected && (
                <div style={{ fontSize:11, color:'var(--text-muted)', marginTop:6 }}>
                  💡 IV % drives the P&L Curve. Delta and Theta are recorded for your trade journal — target delta &lt; 0.30 for CC/CSP.
                </div>
              )}
            </div>
          )}

          {/* ── Notes ── */}
          <div className="modal-section-title">Notes</div>
          <div className="form-group">
            <textarea value={form.notes || ''} onChange={e => set('notes', e.target.value)}
              placeholder="Optional notes — e.g. reason for entry, market conditions..." />
          </div>

          </div>{/* end modal-body */}
          {/* ── Footer ── */}
          {showErrors && hasErrors && (
            <div style={{ background:'rgba(192,57,43,0.08)', border:'1px solid rgba(192,57,43,0.25)',
              borderRadius:6, padding:'8px 12px 8px 28px', margin:'0', fontSize:12, color:'var(--red,#c0392b)',
              flexShrink: 0 }}>
              ⛔ Please fix the errors above before saving.
            </div>
          )}
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{initial ? 'Save Changes' : 'Log Trade'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
