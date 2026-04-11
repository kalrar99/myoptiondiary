// src/api/demoEngine.js  — DEMO ENGINE (fully isolated from live data)
//
// ═══════════════════════════════════════════════════════════════════════════
// ARCHITECTURE: This file is the ONLY source of demo data.
// It has zero imports from the live data layer.
// App.jsx must NEVER call any backend API when isMock === true.
// Live data lives in the backend SQLite database (trade-tracker-backend.js).
// Demo data lives entirely in this module — in memory, computed at runtime.
// ═══════════════════════════════════════════════════════════════════════════
//
// DYNAMIC DATE DESIGN:
// Every date is computed relative to TODAY at module load time.
// A client who installs 6 months later gets expiry dates, DTE values, alerts,
// and P&L curves that are all coherent with their installation date.
// No hardcoded YYYY-MM-DD dates anywhere in this file.
//
// PORTFOLIO DESIGN — realistic wheel trader, ~8 months of history:
//   Wheel stocks (own shares, write CCs): AAPL, TSLA, ABBV, VRTX
//   CSP candidates (want to own):        PLTR, CRDO
//   Index income spreads:                SPY, QQQ
//   Speculative directional (small):     NFLX, IREN, AXSM
//   Event/vol plays:                     CRSP, INOD
//   Completed wheel cycle:               NVDA (assigned → ran CCs → called away)
//
// SPOT PRICES (verified March 22, 2026 — sources: Robinhood, Investing.com):
//   AAPL ~$248  IV ~26%  |  TSLA ~$372  IV ~55%  |  ABBV ~$208  IV ~22%
//   VRTX ~$458  IV ~28%  |  PLTR ~$152  IV ~52%  |  CRDO ~$103  IV ~48%
//   SPY  ~$653  IV ~14%  |  QQQ  ~$584  IV ~17%  |  NFLX ~$93   IV ~32%  (post 10:1 split)
//   IREN ~$41   IV ~75%  |  AXSM ~$165  IV ~48%  |  CRSP ~$46   IV ~62%
//   NVDA ~$175  IV ~42%  |  INOD ~$22   IV ~85%
// NOTE: NVDA split 10:1 Jun 2024. NFLX split, now trading ~$93 (post-split). All NFLX strikes updated to post-split levels.
// IREN has transformed from $14 Bitcoin miner to $41 AI cloud company.
// PLTR and CRDO both ran massively (AI/semiconductor tailwinds).
// ═══════════════════════════════════════════════════════════════════════════

import { nearestExpiryFriday, lastExpiryFriday } from '../utils/tradingCalendar';

const toISO = d => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };
const ago         = n => { const d = new Date(); d.setDate(d.getDate() - n); return toISO(d); };
const expiryAhead = n => { const d = new Date(); d.setDate(d.getDate() + n); return nearestExpiryFriday(d); };
const expiryAgo   = n => { const d = new Date(); d.setDate(d.getDate() - n); return lastExpiryFriday(d); };

// ── Reference spot prices ─────────────────────────────────────────────────
// Update these when market prices shift significantly (e.g. after a split or
// major re-rating). All strikes are computed as percentages of these spots so
// updating a single number here cascades through the entire demo portfolio.
// Last verified: April 2026
const SPOT = {
  AAPL:  248,  TSLA:  372,  ABBV:  208,  VRTX:  458,
  PLTR:  152,  CRDO:  103,  SPY:   653,  QQQ:   584,
  NFLX:   93,  IREN:   41,  AXSM:  165,  CRSP:   46,
  NVDA:  175,  INOD:   22,
};

// Snap a computed strike to the nearest realistic options increment
// $0.50 for stocks < $50, $1 for $50-$100, $2.50 for $100-$200, $5 for $200+
function snapStrike(price, spot) {
  const inc = spot < 50 ? 0.5 : spot < 100 ? 1 : spot < 200 ? 2.5 : 5;
  return Math.round(Math.round(price / inc) * inc * 100) / 100;
}

// Compute strike as OTM % from spot, snapped to nearest increment
// otm > 1.0 = above spot (CC strikes), otm < 1.0 = below spot (CSP/put strikes)
const K = (ticker, otm) => snapStrike(SPOT[ticker] * otm, SPOT[ticker]);

// ── Pre-computed strikes ───────────────────────────────────────────────────
// Defined once so every trade that references the same strike uses the same value.
// This ensures IC wing pairs, calendar legs, and lot avg_cost all stay consistent.
const SK = {
  // AAPL
  AAPL_csp:      K('AAPL', 0.927),   // CSP assigned ~8% below spot
  AAPL_cc1:      K('AAPL', 1.028),   // CC cycle 1 ~3% OTM
  AAPL_cc2:      K('AAPL', 1.048),   // CC cycle 2 ~5% OTM
  AAPL_cc_op1:   K('AAPL', 1.028),   // CC open lot1
  AAPL_cc_op2:   K('AAPL', 1.028),   // CC open lot2
  AAPL_ic_ps:    K('AAPL', 0.867),   // IC put sell
  AAPL_ic_pb:    K('AAPL', 0.827),   // IC put buy
  AAPL_ic_cs:    K('AAPL', 1.048),   // IC call sell
  AAPL_ic_cb:    K('AAPL', 1.089),   // IC call buy
  // TSLA
  TSLA_csp:      K('TSLA', 0.914),   // CSP assigned
  TSLA_cc1:      K('TSLA', 1.048),   // CC closed
  TSLA_bps_s:    K('TSLA', 0.968),   // bear put spread sell
  TSLA_bps_b:    K('TSLA', 0.995),   // bear put spread buy
  TSLA_cc_op:    K('TSLA', 1.062),   // CC open
  // NVDA — fully rebased to $175 spot
  NVDA_csp:      K('NVDA', 0.914),   // CSP assigned
  NVDA_cc1:      K('NVDA', 1.043),   // CC cycle 1
  NVDA_cc2:      K('NVDA', 1.057),   // CC cycle 2
  NVDA_cc3:      K('NVDA', 1.086),   // CC cycle 3
  NVDA_cc4:      K('NVDA', 1.114),   // CC called away
  NVDA_bcs_s:    K('NVDA', 1.057),   // BCS sell
  NVDA_bcs_b:    K('NVDA', 1.086),   // BCS buy
  NVDA_csp_cl:   K('NVDA', 0.900),   // CSP closed early
  NVDA_ib_body:  K('NVDA', 1.000),   // IB body ATM
  NVDA_ib_pw:    K('NVDA', 0.943),   // IB put wing
  NVDA_ib_cw:    K('NVDA', 1.057),   // IB call wing
  // ABBV
  ABBV_csp:      K('ABBV', 0.913),   // CSP assigned
  ABBV_cc1:      K('ABBV', 1.034),   // CC closed
  ABBV_ic_ps:    K('ABBV', 0.938),   // IC put sell
  ABBV_ic_pb:    K('ABBV', 0.889),   // IC put buy
  ABBV_ic_cs:    K('ABBV', 1.058),   // IC call sell
  ABBV_ic_cb:    K('ABBV', 1.106),   // IC call buy
  ABBV_cc_op:    K('ABBV', 1.034),   // CC open
  ABBV_cal1:     K('ABBV', 0.962),   // calendar short leg 1
  ABBV_cal2:     K('ABBV', 0.986),   // calendar short leg 2 (rolled)
  ABBV_cal3:     K('ABBV', 0.962),   // calendar short leg 3 (adj)
  // VRTX
  VRTX_csp:      K('VRTX', 0.961),   // CSP assigned
  VRTX_cc1:      K('VRTX', 1.026),   // CC closed
  VRTX_cc_op:    K('VRTX', 1.026),   // CC open
  // PLTR
  PLTR_csp_cl:   K('PLTR', 0.938),   // CSP closed early
  PLTR_bcs_s:    K('PLTR', 0.970),   // BCS sell
  PLTR_bcs_b:    K('PLTR', 1.003),   // BCS buy
  PLTR_csp_op:   K('PLTR', 0.954),   // CSP open
  // CRDO
  CRDO_bcs_s:    K('CRDO', 0.971),   // BCS sell
  CRDO_bcs_b:    K('CRDO', 0.995),   // BCS buy
  CRDO_csp_op:   K('CRDO', 0.947),   // CSP open
  // SPY — closed ICs (entries were when SPY was ~15% lower)
  SPY_ic1_ps:    K('SPY',  0.827),   SPY_ic1_pb: K('SPY', 0.812),
  SPY_ic1_cs:    K('SPY',  0.904),   SPY_ic1_cb: K('SPY', 0.919),
  SPY_ic2_ps:    K('SPY',  0.835),   SPY_ic2_pb: K('SPY', 0.820),
  SPY_ic2_cs:    K('SPY',  0.896),   SPY_ic2_cb: K('SPY', 0.911),
  SPY_bps_b:     K('SPY',  0.827),   SPY_bps_s:  K('SPY', 0.842),
  // SPY open IC — near money
  SPY_op_ps:     K('SPY',  0.972),   SPY_op_pb:  K('SPY', 0.957),
  SPY_op_cs:     K('SPY',  1.026),   SPY_op_cb:  K('SPY', 1.041),
  SPY_bps_op_b:  K('SPY',  0.949),   SPY_bps_op_s: K('SPY', 0.965),
  // QQQ
  QQQ_ic1_ps:    K('QQQ',  0.801),   QQQ_ic1_pb: K('QQQ', 0.784),
  QQQ_ic1_cs:    K('QQQ',  0.846),   QQQ_ic1_cb: K('QQQ', 0.863),
  QQQ_bps_b:     K('QQQ',  0.788),   QQQ_bps_s:  K('QQQ', 0.801),
  QQQ_op_ps:     K('QQQ',  0.976),   QQQ_op_pb:  K('QQQ', 0.959),
  QQQ_op_cs:     K('QQQ',  1.024),   QQQ_op_cb:  K('QQQ', 1.041),
  QQQ_bcs_s:     K('QQQ',  1.036),   QQQ_bcs_b:  K('QQQ', 1.045),
  // NFLX (post-split $93)
  NFLX_lp:       K('NFLX', 1.022),   // Long Put near ATM
  NFLX_lc:       K('NFLX', 1.075),   // Long Call OTM
  NFLX_cal_atm:  K('NFLX', 1.022),   // Calendar ATM
  NFLX_cal_roll: K('NFLX', 0.968),   // Calendar rolled short
  // AXSM
  AXSM_bps_b:    K('AXSM', 0.909),   AXSM_bps_s: K('AXSM', 0.848),
  AXSM_lc_exp:   K('AXSM', 0.970),   // Long Call expired
  AXSM_bcs_b:    K('AXSM', 1.000),   AXSM_bcs_s: K('AXSM', 1.061),
  // CRSP — straddles at ATM
  CRSP_str_cl:   K('CRSP', 1.000),   // straddle closed
  CRSP_str_op:   K('CRSP', 1.000),   // straddle open
  // IREN
  IREN_lc_old:   K('IREN', 0.951),   // old near-money LC
  IREN_lc_op:    K('IREN', 1.220),   // OTM speculative LC
  // INOD
  INOD_str_b:    K('INOD', 0.500),   // strangle buy leg
  INOD_str_s:    K('INOD', 0.591),   // strangle sell leg
  INOD_diag_s:   K('INOD', 1.136),   // diagonal short
  INOD_diag_l:   K('INOD', 1.227),   // diagonal long
};

// ═══════════════════════════════════════════════════════════════════════════
// DEMO LOTS
// ═══════════════════════════════════════════════════════════════════════════
export function getDemoLots() {
  return [
    // AAPL — core wheel position + added on pullback
    { id: 1, ticker: 'AAPL', shares: 200, avg_cost: SK.AAPL_csp, purchase_date: ago(130), close_date: null,    close_price: null,  notes: 'Core wheel position' },
    { id: 2, ticker: 'AAPL', shares: 100, avg_cost: SK.AAPL_csp, purchase_date: ago(65),  close_date: null,    close_price: null,  notes: 'Added on dip — lot 2' },
    // TSLA — assigned via CSP at $250; wrote CC immediately; effective cost basis reduced
    { id: 3, ticker: 'TSLA', shares: 100, avg_cost: SK.TSLA_csp, purchase_date: ago(80),  close_date: null,    close_price: null,  notes: 'Assigned via CSP at $250. Wheel premium to date: $3,030. Net cost/share: $219.70' },
    // ABBV — assigned via CSP at $175; steady pharma dividend payer
    { id: 4, ticker: 'ABBV', shares: 100, avg_cost: SK.ABBV_csp, purchase_date: ago(95),  close_date: null,    close_price: null,  notes: 'Assigned via CSP at $175. Wheel premium to date: $940. Net cost/share: $165.60' },
    // VRTX — assigned via CSP at $450; high-value biotech wheel
    { id: 5, ticker: 'VRTX', shares: 100, avg_cost: SK.VRTX_csp, purchase_date: ago(55),  close_date: null,    close_price: null,  notes: 'Assigned via CSP at $450. Wheel premium to date: $1,810. Net cost/share: $431.90' },
    // NVDA — completed full wheel cycle: bought, ran 4 CC cycles, called away at $960
    { id: 6, ticker: 'NVDA', shares: 100, avg_cost: SK.NVDA_csp, purchase_date: ago(160), close_date: ago(12), close_price: SK.NVDA_cc4, notes: 'Full wheel complete — avg_cost=$840 (strike). CSP premium $650 + CC premiums $2,860 = $3,510 total option income. Share gain: (960-840)x100=$12,000. Total return: $15,510' },

  ];
}

// ═══════════════════════════════════════════════════════════════════════════
// DEMO TRADES
// All P&L values verified by formula:
//   Credit (CC/CSP/BPS/BCS/IC/IB): (entry_price − exit_price) × contracts × 100
//   Debit  (Long Call/Put/BCS debit/BPS debit): (exit_price − entry_price) × contracts × 100
// ═══════════════════════════════════════════════════════════════════════════
export function getDemoTrades() {
  return [

    // ─────────────────────────────────────────────────────────────────
    // AAPL — wheel on 300 shares across 2 lots
    // ─────────────────────────────────────────────────────────────────

    // id=1  CLOSED — CC expired worthless (first cycle on lot 1)
    // Spot $221, strike $226 (2.3% OTM), 45→0 DTE, IV 26%
    // P&L: (4.20 − 0.05) × 2 × 100 = $830 ✓
    { id: 1, ticker: 'AAPL', lot_id: 1, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(130), exit_date: expiryAgo(85), expiration: expiryAgo(85),
      entry_price: 4.20, exit_price: 0.05, contracts: 2, strike_buy: null, strike_sell: SK.AAPL_cc1,
      delta: -0.28, gamma: 0.04, theta: -0.09, vega: 0.20, iv_entry: 26,
      pnl: 830, notes: 'Expired OTM — full $830 kept', roll_parent_id: null, roll_count: 0 },

    // id=2  CLOSED — CC closed early at 75% max profit (second cycle, lot 1)
    // Spot $222, strike $228, 38→12 DTE
    // P&L: (3.80 − 0.95) × 1 × 100 = $285 ✓
    { id: 2, ticker: 'AAPL', lot_id: 1, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(80), exit_date: ago(42), expiration: expiryAgo(38),
      entry_price: 3.80, exit_price: 0.95, contracts: 1, strike_buy: null, strike_sell: SK.AAPL_cc1,
      delta: -0.26, gamma: 0.03, theta: -0.10, vega: 0.19, iv_entry: 25,
      pnl: 285, notes: 'Closed at 75% of max profit', roll_parent_id: null, roll_count: 0 },

    // id=3  Iron Condor PUT LEG — AAPL (closed)
    // Put wing: sell $215P / buy $205P  credit=$1.20
    { id: 3, ticker: 'AAPL', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(60), exit_date: ago(18), expiration: expiryAgo(18),
      entry_price: 1.20, exit_price: 0.17, contracts: 2,
      strike_buy: SK.AAPL_ic_pb, strike_sell: SK.AAPL_ic_ps,
      delta: -0.10, gamma: 0.02, theta: -0.07, vega: 0.14, iv_entry: 24,
      pnl: 206, notes: 'AAPL stayed in range — closed at 85% max profit — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 103, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=103  Iron Condor CALL LEG — AAPL (closed)
    // Call wing: sell $233C / buy $243C  credit=1.20
    { id: 103, ticker: 'AAPL', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(60), exit_date: ago(18), expiration: expiryAgo(18),
      entry_price: 1.20, exit_price: 0.17, contracts: 2,
      strike_buy: SK.AAPL_ic_cb, strike_sell: SK.AAPL_ic_cs,
      delta: -0.10, gamma: 0.02, theta: -0.07, vega: 0.14, iv_entry: 24,
      pnl: 206, notes: 'AAPL stayed in range — closed at 85% max profit — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 103, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=4  OPEN — CC on lot 1 (200sh), current cycle
    // Spot $224, strike $230 (2.7% OTM), ~21 DTE, IV 26%
    // Premium: 4.60 × 2 × 100 = $920
    { id: 4, ticker: 'AAPL', lot_id: 1, strategy: 'Covered Call',
      status: 'open', entry_date: ago(24), exit_date: null, expiration: expiryAhead(21),
      entry_price: 4.60, exit_price: null, contracts: 2, strike_buy: null, strike_sell: SK.AAPL_cc_op1,
      delta: -0.28, gamma: 0.04, theta: -0.12, vega: 0.22, iv_entry: 26,
      pnl: null, notes: 'Current cycle — 2.8% OTM at $248 spot, targeting expiry', roll_parent_id: null, roll_count: 0 },

    // id=5  OPEN — CC on lot 2 (100sh)
    // Spot $224, strike $228 (1.8% OTM), ~28 DTE, IV 26%
    // Premium: 3.90 × 1 × 100 = $390
    { id: 5, ticker: 'AAPL', lot_id: 2, strategy: 'Covered Call',
      status: 'open', entry_date: ago(17), exit_date: null, expiration: expiryAhead(28),
      entry_price: 3.90, exit_price: null, contracts: 1, strike_buy: null, strike_sell: SK.AAPL_cc_op2,
      delta: -0.30, gamma: 0.04, theta: -0.11, vega: 0.21, iv_entry: 26,
      pnl: null, notes: '2.0% OTM at $248 spot — slight premium over lot 1 strike', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // TSLA — high-IV wheel, assigned from CSP
    // ─────────────────────────────────────────────────────────────────

    // id=6  CLOSED — CSP that resulted in assignment (created lot 3)
    // Spot $248, strike $250 (ATM), 30 DTE, IV 55%
    // Assigned: P&L = $0 at assignment (premium reduces cost basis to $243.50)
    { id: 6, ticker: 'TSLA', lot_id: 3, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(110), exit_date: expiryAgo(80), expiration: expiryAgo(80),
      entry_price: 6.50, exit_price: 6.50, contracts: 1, strike_buy: SK.TSLA_csp, strike_sell: null,
      delta: -0.48, gamma: 0.05, theta: -0.22, vega: 0.48, iv_entry: 55,
      pnl: 0, notes: `Assigned at $${SK.TSLA_csp} — 100sh acquired. Eff. cost basis reduced by premium`, roll_parent_id: null, roll_count: 0 },

    // id=7  CLOSED — CC on TSLA lot, closed early (took profits)
    // Spot $265, strike $275 (3.8% OTM), 38→15 DTE, IV 55%
    // P&L: (14.50 − 5.20) × 1 × 100 = $930 ✓
    { id: 7, ticker: 'TSLA', lot_id: 3, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(78), exit_date: ago(48), expiration: expiryAgo(44),
      entry_price: 14.50, exit_price: 5.20, contracts: 1, strike_buy: null, strike_sell: SK.TSLA_cc1,
      delta: -0.32, gamma: 0.04, theta: -0.18, vega: 0.45, iv_entry: 54,
      pnl: 930, notes: 'Closed at 64% max profit ahead of earnings', roll_parent_id: null, roll_count: 0 },

    // id=8  CLOSED — TSLA Bear Put Spread (hedge when stock ran up sharply)
    // P&L: (2.80 − 4.20) × 2 × 100 = −$280 ✓ (loss — stock kept rising)
    { id: 8, ticker: 'TSLA', lot_id: null, strategy: 'Bear Put Spread',
      status: 'closed', entry_date: ago(55), exit_date: ago(30), expiration: expiryAgo(28),
      entry_price: 4.20, exit_price: 2.80, contracts: 2, strike_buy: SK.TSLA_bps_b, strike_sell: SK.TSLA_bps_s,
      delta: -0.38, gamma: 0.05, theta: -0.14, vega: 0.40, iv_entry: 56,
      pnl: -280, notes: 'TSLA continued higher — closed hedge early at $2.80 (was $4.20 debit). Partial loss: −$280', roll_parent_id: null, roll_count: 0 },

    // id=9  OPEN — CC on TSLA lot (aggressive, high premium, near expiry — RED alert)
    // Spot $268, strike $285 (6.3% OTM), ~14 DTE, IV 55%
    // Premium: 15.00 × 1 × 100 = $1,500
    { id: 9, ticker: 'TSLA', lot_id: 3, strategy: 'Covered Call',
      status: 'open', entry_date: ago(28), exit_date: null, expiration: expiryAhead(14),
      entry_price: 14.50, exit_price: null, contracts: 1, strike_buy: null, strike_sell: SK.TSLA_cc_op,
      delta: -0.30, gamma: 0.04, theta: -0.28, vega: 0.52, iv_entry: 55,
      pnl: null, notes: '6.2% OTM at $372 spot — $1,450 premium. High IV on TSLA rewards aggressive strikes.', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // NVDA — completed full wheel cycle (closed lot)
    // ─────────────────────────────────────────────────────────────────

    // id=10  CLOSED — CSP (assigned, created lot 6)
    // Spot $795, strike $840 (ITM at assignment), 35 DTE, IV 50%
    { id: 10, ticker: 'NVDA', lot_id: 6, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(195), exit_date: expiryAgo(160), expiration: expiryAgo(160),
      entry_price: 6.50, exit_price: 6.50, contracts: 1, strike_buy: SK.NVDA_csp, strike_sell: null,
      delta: -0.42, gamma: 0.04, theta: -0.28, vega: 0.55, iv_entry: 50,
      pnl: 0, notes: 'Assigned at $840 (strike). avg_cost=$840. CSP premium $650 shown separately in wheel premium total', roll_parent_id: null, roll_count: 0 },

    // id=11  CLOSED — NVDA CC #1 expired worthless
    // P&L: (8.50 − 0.05) × 1 × 100 = $845 ✓
    { id: 11, ticker: 'NVDA', lot_id: 6, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(158), exit_date: expiryAgo(113), expiration: expiryAgo(113),
      entry_price: 8.50, exit_price: 0.05, contracts: 1, strike_buy: null, strike_sell: SK.NVDA_cc1,
      delta: -0.28, gamma: 0.03, theta: -0.20, vega: 0.50, iv_entry: 50,
      pnl: 845, notes: 'Cycle 1 — expired worthless', roll_parent_id: null, roll_count: 0 },

    // id=12  CLOSED — NVDA CC #2 closed early 80% profit
    // P&L: (9.00 − 1.80) × 1 × 100 = $720 ✓
    { id: 12, ticker: 'NVDA', lot_id: 6, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(110), exit_date: ago(75), expiration: expiryAgo(72),
      entry_price: 9.00, exit_price: 1.80, contracts: 1, strike_buy: null, strike_sell: SK.NVDA_cc2,
      delta: -0.26, gamma: 0.03, theta: -0.22, vega: 0.52, iv_entry: 50,
      pnl: 720, notes: 'Cycle 2 — closed at 80% max profit', roll_parent_id: null, roll_count: 0 },

    // id=13  CLOSED — NVDA CC #3 expired worthless
    // P&L: (7.50 − 0.05) × 1 × 100 = $745 ✓
    { id: 13, ticker: 'NVDA', lot_id: 6, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(72), exit_date: expiryAgo(32), expiration: expiryAgo(32),
      entry_price: 7.50, exit_price: 0.05, contracts: 1, strike_buy: null, strike_sell: SK.NVDA_cc3,
      delta: -0.24, gamma: 0.03, theta: -0.18, vega: 0.48, iv_entry: 49,
      pnl: 745, notes: 'Cycle 3 — expired worthless', roll_parent_id: null, roll_count: 0 },

    // id=14  CLOSED — NVDA CC #4 — called away at $960 (lot closed)
    // P&L for option: (5.50 − 5.50) = $0 (assigned at strike)
    // Share gain: (960 − 840) × 100 = $12,000 (captured in lot close_price)
    { id: 14, ticker: 'NVDA', lot_id: 6, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(30), exit_date: ago(12), expiration: expiryAgo(12),
      entry_price: 5.50, exit_price: SK.NVDA_cc4, contracts: 1, strike_buy: null, strike_sell: SK.NVDA_cc4,
      delta: -0.22, gamma: 0.02, theta: -0.14, vega: 0.44, iv_entry: 48,
      pnl: 0, notes: 'Called away at $960 — share gain (960-840)x100=$12,000 + $3,510 total option income = $15,510 total wheel return', roll_parent_id: null, roll_count: 0 },

    // id=15  CLOSED — NVDA BCS (extra income during range period)
    // P&L: (4.20 − 0.00) × 1 × 100 = $420 ✓
    { id: 15, ticker: 'NVDA', lot_id: null, strategy: 'Bear Call Spread',
      status: 'closed', entry_date: ago(140), exit_date: expiryAgo(95), expiration: expiryAgo(95),
      entry_price: 4.20, exit_price: 0.00, contracts: 1, strike_buy: SK.NVDA_bcs_b, strike_sell: SK.NVDA_bcs_s,
      delta: -0.22, gamma: 0.03, theta: -0.16, vega: 0.42, iv_entry: 50,
      pnl: 420, notes: 'NVDA BCS — expired worthless during consolidation', roll_parent_id: null, roll_count: 0 },

    // id=16  CLOSED — NVDA CSP closed at 50% profit (did not get assigned)
    // P&L: (6.80 − 3.40) × 1 × 100 = $340 ✓
    { id: 16, ticker: 'NVDA', lot_id: null, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(175), exit_date: ago(148), expiration: expiryAgo(145),
      entry_price: 6.80, exit_price: 3.40, contracts: 1, strike_buy: SK.NVDA_csp_cl, strike_sell: null,
      delta: -0.30, gamma: 0.04, theta: -0.24, vega: 0.52, iv_entry: 50,
      pnl: 340, notes: 'CSP closed at 50% — did not want assignment at that price', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // ABBV — pharma wheel, steady low-IV premium
    // ─────────────────────────────────────────────────────────────────

    // id=17  CLOSED — CSP that resulted in assignment (created lot 4)
    { id: 17, ticker: 'ABBV', lot_id: 4, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(125), exit_date: expiryAgo(95), expiration: expiryAgo(95),
      entry_price: 3.80, exit_price: 3.80, contracts: 1, strike_buy: SK.ABBV_csp, strike_sell: null,
      delta: -0.44, gamma: 0.05, theta: -0.12, vega: 0.28, iv_entry: 22,
      pnl: 0, notes: `Assigned at $${SK.ABBV_csp} — 100sh. Eff. cost basis reduced by premium`, roll_parent_id: null, roll_count: 0 },

    // id=18  CLOSED — CC on ABBV, closed early
    // P&L: (3.50 − 1.40) × 1 × 100 = $210 ✓
    { id: 18, ticker: 'ABBV', lot_id: 4, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(92), exit_date: ago(60), expiration: expiryAgo(55),
      entry_price: 3.50, exit_price: 1.40, contracts: 1, strike_buy: null, strike_sell: SK.ABBV_cc1,
      delta: -0.30, gamma: 0.04, theta: -0.10, vega: 0.25, iv_entry: 22,
      pnl: 210, notes: 'Closed at 60% max profit', roll_parent_id: null, roll_count: 0 },

    // id=19  Iron Condor PUT LEG — ABBV (closed)
    // Put wing: sell $178P / buy $170P  credit=$1.05
    { id: 19, ticker: 'ABBV', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(58), exit_date: ago(20), expiration: expiryAgo(18),
      entry_price: 1.05, exit_price: 0.12, contracts: 2,
      strike_buy: SK.ABBV_ic_pb, strike_sell: SK.ABBV_ic_ps,
      delta: -0.10, gamma: 0.02, theta: -0.06, vega: 0.18, iv_entry: 21,
      pnl: 186, notes: 'Expired near worthless — steady pharma range — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 119, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=119  Iron Condor CALL LEG — ABBV (closed)
    // Call wing: sell $192C / buy $200C  credit=1.05
    { id: 119, ticker: 'ABBV', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(58), exit_date: ago(20), expiration: expiryAgo(18),
      entry_price: 1.05, exit_price: 0.12, contracts: 2,
      strike_buy: SK.ABBV_ic_cb, strike_sell: SK.ABBV_ic_cs,
      delta: -0.10, gamma: 0.02, theta: -0.06, vega: 0.18, iv_entry: 21,
      pnl: 186, notes: 'Expired near worthless — steady pharma range — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 119, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },
    // id=20  OPEN — CC on ABBV lot
    // Premium: 3.20 × 1 × 100 = $320
    { id: 20, ticker: 'ABBV', lot_id: 4, strategy: 'Covered Call',
      status: 'open', entry_date: ago(18), exit_date: null, expiration: expiryAhead(28),
      entry_price: 3.50, exit_price: null, contracts: 1, strike_buy: null, strike_sell: SK.ABBV_cc_op,
      delta: -0.28, gamma: 0.04, theta: -0.10, vega: 0.24, iv_entry: 22,
      pnl: null, notes: '3.4% OTM at $208 spot — steady pharma income', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // ABBV CALENDAR SPREAD — Complete campaign with 2 adjustments (CLOSED)
    // Thesis: ABBV in tight range, IV low (22%), sell near/buy far
    // Entry Jan 13: Sell Mar21 $170C, Buy May16 $170C — net debit $2.40
    // Adj 1 Feb 15: Stock moved to $174 — roll short up $170→$175 (+$1.70 debit)
    // Adj 2 Mar 21: Mar21 $175C expired worthless — roll front to Apr17 $172C (−$1.40 credit)
    // Close Apr 14: Closed both legs — net +$0.05/share = +$5 P&L
    // Total campaign P&L: −$2.40 −$1.70 +$1.40 +$2.75 = +$0.05/sh = +$5 per contract
    // ─────────────────────────────────────────────────────────────────

    // Leg 1A: Original short — Mar21 $170C (closed at adj 1)
    { id: 21, ticker: 'ABBV', lot_id: null, strategy: 'Calendar Spread',
      status: 'closed', entry_date: ago(69), exit_date: ago(36), expiration: lastExpiryFriday(ago(36)),
      entry_price: 1.80, exit_price: 2.90, contracts: 1,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0,
      strike_buy: null, strike_sell: SK.ABBV_cal1,
      delta: -0.38, gamma: 0.02, theta: 0.06, vega: 0.12, iv_entry: 22,
      pnl: -110,
      notes: 'Original short leg — Mar21 $170C. Closed at adj 1 (stock moved to $174, tent off-centre). Loss on short = (1.80−2.90)×100 = −$110',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 21, cal_leg: 'short', cal_seq: 0 },

    // Leg 1B: Original long — May16 $170C (held through entire campaign)
    { id: 211, ticker: 'ABBV', lot_id: null, strategy: 'Calendar Spread',
      status: 'closed', entry_date: ago(69), exit_date: ago(9),
      expiration: lastExpiryFriday(ago(9)), expiration_back: lastExpiryFriday(ago(9)),
      entry_price: 4.20, exit_price: 3.10, contracts: 1,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0,
      strike_buy: SK.ABBV_cal1, strike_sell: null,
      delta: 0.46, gamma: 0.01, theta: -0.02, vega: 0.28, iv_entry: 19,
      pnl: -110,
      notes: 'Original long leg — May16 $170C (back month anchor). Sold at close Apr 14. P&L = (3.10−4.20)×100 = −$110',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 21, cal_leg: 'long', cal_seq: 0 },

    // Leg 2A: Adj 1 — New short after rolling up (Mar21 $175C → expired worthless)
    { id: 212, ticker: 'ABBV', lot_id: null, strategy: 'Calendar Spread',
      status: 'closed', entry_date: ago(36), exit_date: ago(18),
      expiration: lastExpiryFriday(ago(18)),
      entry_price: 1.20, exit_price: 0.05, contracts: 1,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0,
      strike_buy: null, strike_sell: SK.ABBV_cal2,
      delta: -0.22, gamma: 0.015, theta: 0.08, vega: 0.09, iv_entry: 21,
      pnl: 115,
      notes: 'Adj 1 short — Mar21 $175C. Rolled up from $170 (stock at $174). Expired near-worthless Mar 21. P&L = (1.20−0.05)×100 = +$115',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 21, cal_leg: 'short', cal_seq: 1 },

    // Leg 2B: Adj 2 — Rolled front month to Apr17 $172C (closed at take profit)
    { id: 213, ticker: 'ABBV', lot_id: null, strategy: 'Calendar Spread',
      status: 'closed', entry_date: ago(18), exit_date: ago(9),
      expiration: lastExpiryFriday(ago(9)),
      entry_price: 1.45, exit_price: 0.35, contracts: 1,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0,
      strike_buy: null, strike_sell: SK.ABBV_cal3,
      delta: -0.31, gamma: 0.02, theta: 0.09, vega: 0.08, iv_entry: 20,
      pnl: 110,
      notes: 'Adj 2 short — Apr17 $172C. Sold after Mar21 expiry, ABBV at $172. Closed at profit Apr 14. P&L = (1.45−0.35)×100 = +$110',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 21, cal_leg: 'short', cal_seq: 2 },

    // ─────────────────────────────────────────────────────────────────
    // NFLX CALENDAR SPREAD — Open, 1 adjustment made
    // Entry: Sell Mar21 $900C, Buy May16 $900C — net debit $8.50
    // NFLX dropped to $870 post-earnings. Rolled short down $900→$880.
    // Currently open, NFLX @ $875, monitoring for take-profit
    // ─────────────────────────────────────────────────────────────────

    // Leg 3A: Original short — NFLX $95C (closed at adj 1, post-split)
    { id: 214, ticker: 'NFLX', lot_id: null, strategy: 'Calendar Spread',
      status: 'closed', entry_date: ago(28), exit_date: ago(14),
      expiration: lastExpiryFriday(ago(14)),
      entry_price: 4.20, exit_price: 1.80, contracts: 1,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0,
      strike_buy: null, strike_sell: SK.NFLX_cal_atm,
      delta: -0.28, gamma: 0.01, theta: 0.07, vega: 0.18, iv_entry: 32,
      pnl: 240,
      notes: 'Original short — NFLX $95C. Closed after earnings drop (NFLX to $88). P&L = (4.20−1.80)×100 = +$240',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 214, cal_leg: 'short', cal_seq: 0 },

    // Leg 3B: Original long — NFLX back month $95C (still open — the back month anchor)
    // Post-split NFLX ~$93. Buy $95C back month = slight OTM anchor.
    // BS check: S=93, K=95, T=52d, IV=32% → ~$4.80 (filled at $4.60 ✓)
    { id: 215, ticker: 'NFLX', lot_id: null, strategy: 'Calendar Spread',
      status: 'open', entry_date: ago(28), exit_date: null,
      expiration: expiryAhead(51), expiration_back: expiryAhead(51),
      entry_price: 4.60, exit_price: null, contracts: 1,
      contracts_original: 1, contracts_open: 1, contracts_closed: 0, partial_close_pnl: 0,
      strike_buy: SK.NFLX_cal_atm, strike_sell: null,
      delta: 0.42, gamma: 0.008, theta: -0.015, vega: 0.45, iv_entry: 32,
      pnl: null,
      notes: 'Back month anchor — NFLX $95C ~52DTE. Post-split. Held through adjustment. Currently worth ~$4.80.',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 214, cal_leg: 'long', cal_seq: 0 },

    // Leg 3C: Adj 1 — Rolled short down to $90C (currently open, ~21 DTE)
    // Post-split NFLX ~$93. Sell $90C near month = slightly ITM, collecting rich theta.
    // BS check: S=93, K=90, T=21d, IV=32% → ~$4.20 (filled at $3.80 ✓)
    { id: 216, ticker: 'NFLX', lot_id: null, strategy: 'Calendar Spread',
      status: 'open', entry_date: ago(14), exit_date: null,
      expiration: expiryAhead(21),
      entry_price: 3.80, exit_price: null, contracts: 1,
      contracts_original: 1, contracts_open: 1, contracts_closed: 0, partial_close_pnl: 0,
      strike_buy: null, strike_sell: SK.NFLX_cal_roll,
      delta: -0.35, gamma: 0.015, theta: 0.11, vega: 0.14, iv_entry: 32,
      pnl: null,
      notes: 'Adj 1 short — NFLX $90C ~21DTE. Rolled down post-earnings (NFLX at $88). Re-centred tent. NFLX currently $93.',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 214, cal_leg: 'short', cal_seq: 1 },

    // ─────────────────────────────────────────────────────────────────
    // VRTX — high-value biotech wheel
    // ─────────────────────────────────────────────────────────────────

    // id=22  CLOSED — CSP that resulted in assignment (created lot 5)
    { id: 22, ticker: 'VRTX', lot_id: 5, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(90), exit_date: expiryAgo(55), expiration: expiryAgo(55),
      entry_price: 6.50, exit_price: 6.50, contracts: 1, strike_buy: SK.VRTX_csp, strike_sell: null,
      delta: -0.40, gamma: 0.04, theta: -0.18, vega: 0.38, iv_entry: 28,
      pnl: 0, notes: `Assigned at $${SK.VRTX_csp} — 100sh. Eff. cost basis reduced by premium`, roll_parent_id: null, roll_count: 0 },

    // id=23  CLOSED — VRTX CC closed at 50% max profit
    // P&L: (7.20 − 3.60) × 1 × 100 = $360 ✓
    { id: 23, ticker: 'VRTX', lot_id: 5, strategy: 'Covered Call',
      status: 'closed', entry_date: ago(53), exit_date: ago(28), expiration: expiryAgo(25),
      entry_price: 7.20, exit_price: 3.60, contracts: 1, strike_buy: null, strike_sell: SK.VRTX_cc1,
      delta: -0.30, gamma: 0.04, theta: -0.16, vega: 0.35, iv_entry: 28,
      pnl: 360, notes: 'Closed at 50% max profit — stock approaching strike', roll_parent_id: null, roll_count: 0 },

    // id=24  OPEN — CC on VRTX lot, ~21 DTE
    // Premium: 8.50 × 1 × 100 = $850
    { id: 24, ticker: 'VRTX', lot_id: 5, strategy: 'Covered Call',
      status: 'open', entry_date: ago(22), exit_date: null, expiration: expiryAhead(21),
      entry_price: 8.00, exit_price: null, contracts: 1, strike_buy: null, strike_sell: SK.VRTX_cc_op,
      delta: -0.28, gamma: 0.03, theta: -0.18, vega: 0.36, iv_entry: 28,
      pnl: null, notes: '2.6% OTM at $458 spot — $800 premium on biotech leader', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // PLTR — high-IV CSP candidate (want to own below $76)
    // ─────────────────────────────────────────────────────────────────

    // id=25  CLOSED — PLTR CSP closed at 50% profit (managed early)
    // P&L: (5.20 − 2.60) × 1 × 100 = $260 ✓
    { id: 25, ticker: 'PLTR', lot_id: null, strategy: 'Cash-Secured Put',
      status: 'closed', entry_date: ago(55), exit_date: ago(30), expiration: expiryAgo(28),
      entry_price: 5.20, exit_price: 2.60, contracts: 1, strike_buy: SK.PLTR_csp_cl, strike_sell: null,
      delta: -0.30, gamma: 0.04, theta: -0.22, vega: 0.52, iv_entry: 58,
      pnl: 260, notes: 'Managed at 50% — did not want assignment at $74 yet', roll_parent_id: null, roll_count: 0 },

    // id=26  CLOSED — PLTR BCS closed at profit (bearish hedge during spike)
    // P&L: (3.80 − 1.00) × 1 × 100 = $280 ✓
    { id: 26, ticker: 'PLTR', lot_id: null, strategy: 'Bear Call Spread',
      status: 'closed', entry_date: ago(42), exit_date: ago(15), expiration: expiryAgo(12),
      entry_price: 3.80, exit_price: 1.00, contracts: 1, strike_buy: SK.PLTR_bcs_b, strike_sell: SK.PLTR_bcs_s,
      delta: -0.28, gamma: 0.04, theta: -0.20, vega: 0.50, iv_entry: 58,
      pnl: 280, notes: 'PLTR faded from highs — BCS expired near worthless', roll_parent_id: null, roll_count: 0 },

    // id=27  OPEN — PLTR CSP, ~35 DTE, want to own if falls to $76
    // Premium: 4.80 × 1 × 100 = $480
    { id: 27, ticker: 'PLTR', lot_id: null, strategy: 'Cash-Secured Put',
      status: 'open', entry_date: ago(12), exit_date: null, expiration: expiryAhead(35),
      entry_price: 6.20, exit_price: null, contracts: 1, strike_buy: SK.PLTR_csp_op, strike_sell: null,
      delta: -0.34, gamma: 0.04, theta: -0.24, vega: 0.52, iv_entry: 52,
      pnl: null, notes: 'CSP — would own PLTR at $145 (4.6% below $152 spot). High AI/data premium.', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // CRDO — semiconductor, high-IV CSP + closed BCS
    // ─────────────────────────────────────────────────────────────────

    // id=28  CLOSED — CRDO BCS expired worthless
    // P&L: (3.20 − 0.00) × 1 × 100 = $320 ✓
    { id: 28, ticker: 'CRDO', lot_id: null, strategy: 'Bear Call Spread',
      status: 'closed', entry_date: ago(50), exit_date: expiryAgo(15), expiration: expiryAgo(15),
      entry_price: 3.20, exit_price: 0.00, contracts: 1, strike_buy: SK.CRDO_bcs_b, strike_sell: SK.CRDO_bcs_s,
      delta: -0.24, gamma: 0.04, theta: -0.20, vega: 0.48, iv_entry: 52,
      pnl: 320, notes: 'CRDO stayed below $74 — full premium kept', roll_parent_id: null, roll_count: 0 },

    // id=29  OPEN — CRDO CSP, ~28 DTE
    // Premium: 4.20 × 1 × 100 = $420
    { id: 29, ticker: 'CRDO', lot_id: null, strategy: 'Cash-Secured Put',
      status: 'open', entry_date: ago(15), exit_date: null, expiration: expiryAhead(28),
      entry_price: 2.70, exit_price: null, contracts: 1, strike_buy: SK.CRDO_csp_op, strike_sell: null,
      delta: -0.29, gamma: 0.04, theta: -0.22, vega: 0.48, iv_entry: 48,
      pnl: null, notes: 'CSP — would acquire CRDO at $97 (5.8% below $103 spot). Semiconductor tailwind thesis.', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // SPY — index income: IC, BPS hedge, CC history
    // ─────────────────────────────────────────────────────────────────

    // id=30  Iron Condor PUT LEG — SPY (closed)
    // Put wing: sell $540P / buy $530P  credit=$1.55
    { id: 30, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(65), exit_date: expiryAgo(20), expiration: expiryAgo(20),
      entry_price: 1.55, exit_price: 0.05, contracts: 2,
      strike_buy: 530, strike_sell: 540,
      delta: -0.12, gamma: 0.02, theta: -0.08, vega: 0.16, iv_entry: 14,
      pnl: 300, notes: 'SPY stayed in range — both wings expired worthless — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 130, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=130  Iron Condor CALL LEG — SPY (closed)
    // Call wing: sell $590C / buy $600C  credit=1.55
    { id: 130, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(65), exit_date: expiryAgo(20), expiration: expiryAgo(20),
      entry_price: 1.55, exit_price: 0.05, contracts: 2,
      strike_buy: 600, strike_sell: 590,
      delta: -0.12, gamma: 0.02, theta: -0.08, vega: 0.16, iv_entry: 14,
      pnl: 300, notes: 'SPY stayed in range — both wings expired worthless — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 130, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },
    // id=31  Iron Condor PUT LEG — SPY (closed)
    // Put wing: sell $545P / buy $535P  credit=$1.40
    { id: 31, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(40), exit_date: ago(12), expiration: expiryAgo(10),
      entry_price: 1.40, exit_price: 0.28, contracts: 2,
      strike_buy: 535, strike_sell: 545,
      delta: -0.11, gamma: 0.02, theta: -0.08, vega: 0.15, iv_entry: 14,
      pnl: 224, notes: 'Closed at 80% max profit — good theta decay — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 131, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=131  Iron Condor CALL LEG — SPY (closed)
    // Call wing: sell $585C / buy $595C  credit=1.40
    { id: 131, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(40), exit_date: ago(12), expiration: expiryAgo(10),
      entry_price: 1.40, exit_price: 0.28, contracts: 2,
      strike_buy: 595, strike_sell: 585,
      delta: -0.11, gamma: 0.02, theta: -0.08, vega: 0.15, iv_entry: 14,
      pnl: 224, notes: 'Closed at 80% max profit — good theta decay — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 131, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },
    // id=32  CLOSED — SPY BPS closed at 80% profit
    // P&L: (2.20 − 0.44) × 2 × 100 = $352 ✓
    { id: 32, ticker: 'SPY', lot_id: null, strategy: 'Bull Put Spread',
      status: 'closed', entry_date: ago(48), exit_date: ago(18), expiration: expiryAgo(15),
      entry_price: 2.20, exit_price: 0.44, contracts: 2, strike_buy: SK.SPY_bps_b, strike_sell: SK.SPY_bps_s,
      delta: -0.20, gamma: 0.03, theta: -0.09, vega: 0.18, iv_entry: 14,
      pnl: 352, notes: 'Closed at 80% max profit', roll_parent_id: null, roll_count: 0 },

    // id=33  Iron Condor PUT LEG — SPY (open)
    // Put wing: sell $630P / buy $620P  credit=$1.60
    { id: 33, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'open', entry_date: ago(8), exit_date: null, expiration: expiryAhead(45),
      entry_price: 1.60, exit_price: null, contracts: 2,
      strike_buy: SK.SPY_op_pb, strike_sell: SK.SPY_op_ps,
      delta: -0.11, gamma: 0.02, theta: -0.08, vega: 0.16, iv_entry: 14,
      pnl: null, notes: 'IC at $653 spot — put wing $625/$635, call wing $670/$680 — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 133, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0, },

    // id=133  Iron Condor CALL LEG — SPY (open)
    // Call wing: sell $670C / buy $680C  credit=1.60
    { id: 133, ticker: 'SPY', lot_id: null, strategy: 'Iron Condor',
      status: 'open', entry_date: ago(8), exit_date: null, expiration: expiryAhead(45),
      entry_price: 1.60, exit_price: null, contracts: 2,
      strike_buy: SK.SPY_op_cb, strike_sell: SK.SPY_op_cs,
      delta: -0.11, gamma: 0.02, theta: -0.08, vega: 0.16, iv_entry: 14,
      pnl: null, notes: 'IC at $653 spot — put wing $625/$635, call wing $670/$680 — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 133, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0, },
    // id=34  OPEN — SPY Bear Put Spread (portfolio hedge against correction)
    // Debit: 2.80 × 2 × 100 = $560
    { id: 34, ticker: 'SPY', lot_id: null, strategy: 'Bear Put Spread',
      status: 'open', entry_date: ago(10), exit_date: null, expiration: expiryAhead(28),
      entry_price: 2.80, exit_price: null, contracts: 2, strike_buy: SK.SPY_bps_op_b, strike_sell: SK.SPY_bps_op_s,
      delta: -0.32, gamma: 0.04, theta: -0.10, vega: 0.18, iv_entry: 14,
      pnl: null, notes: 'Portfolio hedge — BPS protects against pullback from $651 spot', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // QQQ — index income: IC, CC history, BCS
    // ─────────────────────────────────────────────────────────────────

    // id=35  Iron Condor PUT LEG — QQQ (closed)
    // Put wing: sell $468P / buy $458P  credit=$1.43
    { id: 35, ticker: 'QQQ', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(55), exit_date: ago(15), expiration: expiryAgo(12),
      entry_price: 1.43, exit_price: 0.15, contracts: 2,
      strike_buy: 458, strike_sell: 468,
      delta: -0.12, gamma: 0.02, theta: -0.09, vega: 0.17, iv_entry: 17,
      pnl: 256, notes: 'Closed at 89% max profit — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 135, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },

    // id=135  Iron Condor CALL LEG — QQQ (closed)
    // Call wing: sell $494C / buy $504C  credit=1.43
    { id: 135, ticker: 'QQQ', lot_id: null, strategy: 'Iron Condor',
      status: 'closed', entry_date: ago(55), exit_date: ago(15), expiration: expiryAgo(12),
      entry_price: 1.43, exit_price: 0.15, contracts: 2,
      strike_buy: 504, strike_sell: 494,
      delta: -0.12, gamma: 0.02, theta: -0.09, vega: 0.17, iv_entry: 17,
      pnl: 256, notes: 'Closed at 89% max profit — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 135, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 0, contracts_closed: 2, partial_close_pnl: 0, },
    // id=36  CLOSED — QQQ BPS closed at profit
    // P&L: (2.60 − 0.52) × 2 × 100 = $416 ✓
    { id: 36, ticker: 'QQQ', lot_id: null, strategy: 'Bull Put Spread',
      status: 'closed', entry_date: ago(42), exit_date: ago(14), expiration: expiryAgo(12),
      entry_price: 2.60, exit_price: 0.52, contracts: 2, strike_buy: SK.QQQ_bps_b, strike_sell: SK.QQQ_bps_s,
      delta: -0.22, gamma: 0.03, theta: -0.10, vega: 0.19, iv_entry: 17,
      pnl: 416, notes: 'QQQ held above spread — closed at 80% profit', roll_parent_id: null, roll_count: 0 },

    // id=37  Iron Condor PUT LEG — QQQ (open)
    // Put wing: sell $565P / buy $555P  credit=$1.48
    { id: 37, ticker: 'QQQ', lot_id: null, strategy: 'Iron Condor',
      status: 'open', entry_date: ago(10), exit_date: null, expiration: expiryAhead(37),
      entry_price: 1.48, exit_price: null, contracts: 2,
      strike_buy: SK.QQQ_op_pb, strike_sell: SK.QQQ_op_ps,
      delta: -0.12, gamma: 0.02, theta: -0.09, vega: 0.18, iv_entry: 17,
      pnl: null, notes: 'IC at $584 spot — put wing $560/$570, call wing $598/$608 — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 137, condor_leg: 'put', condor_seq: 0,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0, },

    // id=137  Iron Condor CALL LEG — QQQ (open)
    // Call wing: sell $598C / buy $608C  credit=1.48
    { id: 137, ticker: 'QQQ', lot_id: null, strategy: 'Iron Condor',
      status: 'open', entry_date: ago(10), exit_date: null, expiration: expiryAhead(37),
      entry_price: 1.48, exit_price: null, contracts: 2,
      strike_buy: SK.QQQ_op_cb, strike_sell: SK.QQQ_op_cs,
      delta: -0.12, gamma: 0.02, theta: -0.09, vega: 0.18, iv_entry: 17,
      pnl: null, notes: 'IC at $584 spot — put wing $560/$570, call wing $598/$608 — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 137, condor_leg: 'call', condor_seq: 0,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0, },
    // id=38  OPEN — QQQ Bear Call Spread (mild bearish hedge on tech)
    // Premium: 1.80 × 2 × 100 = $360
    { id: 38, ticker: 'QQQ', lot_id: null, strategy: 'Bear Call Spread',
      status: 'open', entry_date: ago(14), exit_date: null, expiration: expiryAhead(21),
      entry_price: 1.80, exit_price: null, contracts: 2, strike_buy: SK.QQQ_bcs_b, strike_sell: SK.QQQ_bcs_s,
      delta: -0.24, gamma: 0.03, theta: -0.10, vega: 0.18, iv_entry: 17,
      pnl: null, notes: 'Mild tech hedge — BCS sells QQQ rally above $605 (at $585 spot)', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // NFLX — directional play + protective put history
    // ─────────────────────────────────────────────────────────────────

    // id=39  CLOSED — NFLX Long Put (bearish before earnings, paid off)
    // P&L: (18.50 − 9.20) × 1 × 100 = $930 ✓
    // Stock ~$920 pre-earnings, $940 put slightly OTM (2.2%). Earnings miss → stock fell to $870 → put doubled.
    { id: 39, ticker: 'NFLX', lot_id: null, strategy: 'Long Put',
      status: 'closed', entry_date: ago(38), exit_date: ago(20), expiration: expiryAgo(18),
      entry_price: 9.20, exit_price: 18.50, contracts: 1, strike_buy: SK.NFLX_lp, strike_sell: null,
      delta: -0.38, gamma: 0.04, theta: -0.18, vega: 0.42, iv_entry: 32,
      pnl: 930, notes: 'NFLX sold off post-earnings (from ~$920 to ~$870) — $940 put went deep ITM, doubled in value', roll_parent_id: null, roll_count: 0 },

    // id=40  OPEN — NFLX Long Call (bullish, post-split)
    // Post-split NFLX ~$93. Buy $100C 45DTE = 7.5% OTM bullish play.
    // BS check: S=93, K=100, T=45d, IV=32% → ~$2.80 (filled at $2.60 ✓)
    // Debit: 2.60 × 1 × 100 = $260
    { id: 40, ticker: 'NFLX', lot_id: null, strategy: 'Long Call',
      status: 'open', entry_date: ago(8), exit_date: null, expiration: expiryAhead(45),
      entry_price: 2.60, exit_price: null, contracts: 1, strike_buy: SK.NFLX_lc, strike_sell: null,
      delta: 0.35, gamma: 0.04, theta: -0.08, vega: 0.18, iv_entry: 32,
      pnl: null, notes: 'Long Call — $100 strike, 7.5% OTM at $93 spot (post-split). Bullish earnings catalyst, debit $260.', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // AXSM — biotech speculative
    // ─────────────────────────────────────────────────────────────────

    // id=41  CLOSED — AXSM Bear Put Spread (loss — stock went up)
    // P&L: (2.80 − 4.20) × 2 × 100 = −$280 ✓
    { id: 41, ticker: 'AXSM', lot_id: null, strategy: 'Bear Put Spread',
      status: 'closed', entry_date: ago(42), exit_date: ago(18), expiration: expiryAgo(15),
      entry_price: 4.20, exit_price: 2.80, contracts: 2, strike_buy: SK.AXSM_bps_b, strike_sell: SK.AXSM_bps_s,
      delta: -0.40, gamma: 0.05, theta: -0.16, vega: 0.44, iv_entry: 48,
      pnl: -280, notes: 'AXSM rallied — puts lost value', roll_parent_id: null, roll_count: 0 },

    // id=42  CLOSED — AXSM Long Call loss (expired worthless)
    // P&L: (0.00 − 1.80) × 2 × 100 = −$360 ✓
    { id: 42, ticker: 'AXSM', lot_id: null, strategy: 'Long Call',
      status: 'closed', entry_date: ago(55), exit_date: expiryAgo(20), expiration: expiryAgo(20),
      entry_price: 1.80, exit_price: 0.00, contracts: 2, strike_buy: SK.AXSM_lc_exp, strike_sell: null,
      delta: 0.28, gamma: 0.04, theta: -0.12, vega: 0.40, iv_entry: 48,
      pnl: -360, notes: 'OTM call expired worthless — catalyst did not materialise', roll_parent_id: null, roll_count: 0 },

    // id=43  OPEN — AXSM Bull Call Spread (defined risk bullish)
    // Buy $165C / sell $175C — ATM/near-ATM vs $165 spot, better Yahoo coverage
    // Debit: 3.20 × 2 × 100 = $640
    // BS check: S=165, K=165, T=38d, IV=48% → ~$6.80 for ATM; spread ~$3.20 ✓
    { id: 43, ticker: 'AXSM', lot_id: null, strategy: 'Bull Call Spread',
      status: 'open', entry_date: ago(10), exit_date: null, expiration: expiryAhead(51),
      entry_price: 3.20, exit_price: null, contracts: 2, strike_buy: SK.AXSM_bcs_b, strike_sell: SK.AXSM_bcs_s,
      delta: 0.47, gamma: 0.05, theta: -0.14, vega: 0.46, iv_entry: 48,
      pnl: null, notes: 'Defined risk bullish — buy $165C / sell $175C. Max gain $640 if AXSM > $175 at expiry.', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // CRSP — binary event / FDA catalyst play
    // ─────────────────────────────────────────────────────────────────

    // id=44  CLOSED — CRSP Long Straddle (loss — no catalyst, IV crushed)
    // P&L: (6.80 − 14.20) × 1 × 100 = −$740 ✓ (debit: exit − entry)
    { id: 44, ticker: 'CRSP', lot_id: null, strategy: 'Long Straddle',
      status: 'closed', entry_date: ago(40), exit_date: ago(12), expiration: expiryAgo(10),
      entry_price: 14.20, exit_price: 6.80, contracts: 1, strike_buy: SK.CRSP_str_cl, strike_sell: SK.CRSP_str_cl,
      delta: 0.02, gamma: 0.06, theta: -0.28, vega: 0.62, iv_entry: 62,
      pnl: -740, notes: 'FDA delay announced — IV crushed, straddle lost value', roll_parent_id: null, roll_count: 0 },

    // id=45  OPEN — CRSP Long Straddle (new catalyst window)
    // Debit: 12.80 × 1 × 100 = $1,280
    { id: 45, ticker: 'CRSP', lot_id: null, strategy: 'Long Straddle',
      status: 'open', entry_date: ago(6), exit_date: null, expiration: expiryAhead(21),
      entry_price: 12.80, exit_price: null, contracts: 1, strike_buy: SK.CRSP_str_op, strike_sell: SK.CRSP_str_op,
      delta: 0.02, gamma: 0.06, theta: -0.30, vega: 0.64, iv_entry: 62,
      pnl: null, notes: 'New FDA window — long vol play, needs $12.80 move to profit', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // IREN — small-cap speculative, high IV
    // ─────────────────────────────────────────────────────────────────

    // id=46  CLOSED — IREN Long Call (loss — stock faded)
    // P&L: (0.35 − 1.80) × 2 × 100 = −$290 ✓
    { id: 46, ticker: 'IREN', lot_id: null, strategy: 'Long Call',
      status: 'closed', entry_date: ago(45), exit_date: ago(15), expiration: expiryAgo(12),
      entry_price: 1.80, exit_price: 0.35, contracts: 2, strike_buy: SK.IREN_lc_old, strike_sell: null,
      delta: 0.38, gamma: 0.08, theta: -0.12, vega: 0.30, iv_entry: 85,
      pnl: -290, notes: 'Spec call at old $14 IREN (Bitcoin miner era) — stock faded, closed before full loss', roll_parent_id: null, roll_count: 0 },

    // id=47  OPEN — IREN Long Call (new entry at AI cloud pivot, small size)
    // IREN transformed: Bitcoin miner at $14 → AI cloud at $41. New bullish call.
    // Debit: 1.40 × 2 × 100 = $280
    // BS check: S=41, K=50, T=35d, IV=85% → $1.59 (filled slightly below mid ✓)
    { id: 47, ticker: 'IREN', lot_id: null, strategy: 'Long Call',
      status: 'open', entry_date: ago(8), exit_date: null, expiration: expiryAhead(35),
      entry_price: 1.40, exit_price: null, contracts: 2, strike_buy: SK.IREN_lc_op, strike_sell: null,
      delta: 0.27, gamma: 0.06, theta: -0.10, vega: 0.28, iv_entry: 85,
      pnl: null, notes: 'AI cloud pivot play — $50 strike 22% OTM at $41 spot, defined risk $280', roll_parent_id: null, roll_count: 0 },

    // ─────────────────────────────────────────────────────────────────
    // INOD — small cap, diagonal spread (cheap debit, defined risk)
    // ─────────────────────────────────────────────────────────────────

    // id=48  CLOSED — INOD Long Strangle (loss — stock stayed flat)
    // P&L: (0.40 − 2.10) × 1 × 100 = −$170 ✓ (debit)
    { id: 48, ticker: 'INOD', lot_id: null, strategy: 'Long Strangle',
      status: 'closed', entry_date: ago(50), exit_date: ago(18), expiration: expiryAgo(15),
      entry_price: 2.10, exit_price: 0.40, contracts: 1, strike_buy: SK.INOD_str_b, strike_sell: SK.INOD_str_s,
      delta: 0.04, gamma: 0.06, theta: -0.08, vega: 0.22, iv_entry: 90,
      pnl: -170, notes: 'INOD stayed flat — strangle lost to theta decay', roll_parent_id: null, roll_count: 0 },

    // id=49  OPEN — INOD Diagonal Spread SHORT leg (sell near $25C ~21DTE)
    // Near: sell $25 call ~21DTE. OTM vs $22 spot. Net debit: $0.55/share (long costs more than short credit)
    // BS check: S=22, K=25, T=21d, IV=90% → ~$0.58 (filled slightly below mid ✓)
    // Stored as a 2-leg chain sharing cal_chain_id=49 (short + long legs, same as Calendar structure)
    { id: 49, ticker: 'INOD', lot_id: null, strategy: 'Diagonal Spread',
      status: 'open', entry_date: ago(7), exit_date: null, expiration: expiryAhead(21),
      expiration_back: null,
      entry_price: 0.58, exit_price: null, contracts: 2,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0,
      strike_sell: SK.INOD_diag_s, strike_buy: null,
      delta: -0.22, gamma: 0.05, theta: 0.08, vega: 0.18, iv_entry: 90,
      pnl: null, notes: 'Diagonal short — sell near $25C ~21DTE. OTM vs $22 spot.',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 49, cal_leg: 'short', cal_seq: 0 },

    // id=491 OPEN — INOD Diagonal Spread LONG leg (buy far $27C ~56DTE)
    // Far: buy $27 call ~56DTE. Different strike from short = diagonal (not pure calendar)
    // BS check: S=22, K=27, T=56d, IV=90% → ~$1.13 (net debit = $1.13 − $0.58 = $0.55/share ✓)
    { id: 491, ticker: 'INOD', lot_id: null, strategy: 'Diagonal Spread',
      status: 'open', entry_date: ago(7), exit_date: null, expiration: expiryAhead(56),
      expiration_back: expiryAhead(56),
      entry_price: 1.13, exit_price: null, contracts: 2,
      contracts_original: 2, contracts_open: 2, contracts_closed: 0, partial_close_pnl: 0,
      strike_buy: SK.INOD_diag_l, strike_sell: null,
      delta: 0.18, gamma: 0.03, theta: -0.04, vega: 0.28, iv_entry: 90,
      pnl: null, notes: 'Diagonal long — buy far $27C ~56DTE. Net debit: $1.13 − $0.58 = $0.55/share.',
      roll_parent_id: null, roll_count: 0,
      option_type: 'call', cal_chain_id: 49, cal_leg: 'long', cal_seq: 0 },

    // ─────────────────────────────────────────────────────────────────
    // Iron Butterfly — NVDA (past example, now closed)
    // ─────────────────────────────────────────────────────────────────

    // id=50  Iron Butterfly PUT LEG — NVDA (closed)
    // Put wing: sell $875P (body/ATM) / buy $840P (lower protection)  credit=$6.40
    { id: 50, ticker: 'NVDA', lot_id: null, strategy: 'Iron Butterfly',
      status: 'closed', entry_date: ago(48), exit_date: ago(20), expiration: expiryAgo(18),
      entry_price: 6.40, exit_price: 1.60, contracts: 1,
      strike_buy: SK.NVDA_ib_pw, strike_sell: SK.NVDA_ib_body,
      delta: -0.06, gamma: 0.02, theta: -0.18, vega: 0.38, iv_entry: 50,
      pnl: 480, notes: 'IB centered at $875 — closed at 75% max profit — PUT wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 150, condor_leg: 'put', condor_seq: 0,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0, },

    // id=150  Iron Butterfly CALL LEG — NVDA (closed)
    // Call wing: sell $875C / buy $910C  credit=6.40
    { id: 150, ticker: 'NVDA', lot_id: null, strategy: 'Iron Butterfly',
      status: 'closed', entry_date: ago(48), exit_date: ago(20), expiration: expiryAgo(18),
      entry_price: 6.40, exit_price: 1.60, contracts: 1,
      strike_buy: SK.NVDA_ib_cw, strike_sell: SK.NVDA_ib_body,
      delta: -0.06, gamma: 0.02, theta: -0.18, vega: 0.38, iv_entry: 50,
      pnl: 480, notes: 'IB centered at $875 — closed at 75% max profit — CALL wing',
      roll_parent_id: null, roll_count: 0,
      condor_chain_id: 150, condor_leg: 'call', condor_seq: 0,
      contracts_original: 1, contracts_open: 0, contracts_closed: 1, partial_close_pnl: 0, },


  ];
}

let _nextTradeId = -1;
let _nextLotId   = -1;

export const getNextDemoTradeId = () => _nextTradeId--;
export const getNextDemoLotId   = () => _nextLotId--;
