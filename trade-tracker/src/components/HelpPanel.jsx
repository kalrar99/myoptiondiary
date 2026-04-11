// src/components/HelpPanel.jsx
// In-app help guide — 28 articles across 6 categories
// Tone: expert practitioner voice. Educational depth. Informational not prescriptive.
// All demo examples verified against demoEngine.js figures.
import React, { useState, useMemo } from 'react';

// ── Shared style helpers ──────────────────────────────────
const tip = (text) => (
  <div style={{ background:'var(--blue-bg,#eef4ff)', border:'1px solid var(--blue-border,#b5d0f7)',
    borderRadius:8, padding:'10px 14px', margin:'12px 0', fontSize:12.5, lineHeight:1.65 }}>
    <span style={{ fontWeight:700, color:'var(--blue,#1a5fa8)' }}>💡 </span>{text}
  </div>
);
const warn = (text) => (
  <div style={{ background:'var(--amber-bg,#fffbe6)', border:'1px solid var(--amber-border,#f0d898)',
    borderRadius:8, padding:'10px 14px', margin:'12px 0', fontSize:12.5, lineHeight:1.65 }}>
    <span style={{ fontWeight:700, color:'var(--amber,#92600a)' }}>&#9888; </span>{text}
  </div>
);
const good = (text) => (
  <div style={{ background:'var(--green-bg,#edf7f2)', border:'1px solid var(--green-border,#a8d5bc)',
    borderRadius:8, padding:'10px 14px', margin:'12px 0', fontSize:12.5, lineHeight:1.65 }}>
    <span style={{ fontWeight:700, color:'var(--green,#1a7a4a)' }}>&#10003; </span>{text}
  </div>
);
const kv = (pairs) => (
  <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12.5, margin:'10px 0' }}>
    <tbody>
      {pairs.map(([k,v],i) => (
        <tr key={i} style={{ background: i%2===0 ? 'var(--bg-alt,#f7f7f5)' : 'transparent' }}>
          <td style={{ padding:'6px 10px', fontWeight:700, color:'var(--text-primary)', width:'36%',
            border:'1px solid var(--border,#e0e0e0)', verticalAlign:'top' }}>{k}</td>
          <td style={{ padding:'6px 10px', color:'var(--text-secondary)',
            border:'1px solid var(--border,#e0e0e0)', lineHeight:1.55 }}>{v}</td>
        </tr>
      ))}
    </tbody>
  </table>
);

// ── Wheel diagram SVG ─────────────────────────────────────
const WheelDiagram = () => (
  <svg viewBox="0 0 420 210" style={{ width:'100%', maxWidth:400, margin:'14px 0', display:'block' }}>
    <defs>
      <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L0,6 L8,3 z" fill="#555"/>
      </marker>
    </defs>
    <rect x="10" y="80" width="88" height="44" rx="8" fill="#edf7f2" stroke="#1a7a4a" strokeWidth="2"/>
    <text x="54" y="99" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a7a4a">Sell CSP</text>
    <text x="54" y="113" textAnchor="middle" fontSize="9" fill="#1a7a4a">30-45 DTE</text>
    <rect x="166" y="80" width="88" height="44" rx="8" fill="#fffbe6" stroke="#92600a" strokeWidth="2"/>
    <text x="210" y="99" textAnchor="middle" fontSize="11" fontWeight="700" fill="#92600a">Assigned</text>
    <text x="210" y="113" textAnchor="middle" fontSize="9" fill="#92600a">Buy shares</text>
    <rect x="322" y="80" width="88" height="44" rx="8" fill="#eef4ff" stroke="#1a5fa8" strokeWidth="2"/>
    <text x="366" y="99" textAnchor="middle" fontSize="11" fontWeight="700" fill="#1a5fa8">Sell CC</text>
    <text x="366" y="113" textAnchor="middle" fontSize="9" fill="#1a5fa8">30-45 DTE</text>
    <path d="M98 102 L166 102" stroke="#555" strokeWidth="1.5" markerEnd="url(#arr)"/>
    <path d="M254 102 L322 102" stroke="#555" strokeWidth="1.5" markerEnd="url(#arr)"/>
    <path d="M366 124 Q366 178 210 178 Q54 178 54 124" stroke="#1a5fa8" strokeWidth="1.5" fill="none" strokeDasharray="5 3" markerEnd="url(#arr)"/>
    <text x="210" y="196" textAnchor="middle" fontSize="9" fill="#1a5fa8">Called Away — restart or repeat</text>
    <path d="M54 80 L54 48 Q54 28 100 28" stroke="#92600a" strokeWidth="1.5" fill="none" strokeDasharray="5 3" markerEnd="url(#arr)"/>
    <text x="200" y="24" textAnchor="middle" fontSize="9" fill="#92600a">Expires OTM — keep premium, repeat</text>
  </svg>
);

// ==========================================================
// ARTICLES
// ==========================================================
const ARTICLES = [

  // ─────────────── GETTING STARTED ───────────────────────

  {
    id: 'overview', cat: 'Getting Started',
    title: 'Overview — What is MyOptionDiary?',
    keywords: ['overview','intro','start','what is','wheel','about'],
    content: (
      <div>
        <p>MyOptionDiary is a desktop journal built specifically for wheel-strategy traders. It tracks your complete options cycle as a single unified position — from selling a Cash-Secured Put, through assignment, through monthly Covered Calls, to getting called away — and makes the compounding effect visible at every stage.</p>
        <p>Every premium dollar collected reduces your effective cost per share. The app displays that reduction in real time so you always know exactly where each position stands.</p>
        <WheelDiagram />
        <p>Three main views, accessible from the left sidebar at all times:</p>
        {kv([
          ['Dashboard',      'Realised P&L, win rate, profit factor, streak, monthly bar chart, and the If-Closed-Today combined position value.'],
          ['Stock Positions', 'Every stock lot with progressive cost basis reduction, coverage status, and full wheel cycle return summaries.'],
          ['Trade Log',       'All 65 demo trades in a 16-column layout. Enter current prices to see theoretical P&L. The Alerts & Actionable Insights Monitor sits directly below.'],
        ])}
        {tip('Starting in Demo Mode is the most effective way to learn the app. Click "View Demo" on the Dashboard. The demo contains 65 mathematically verified trades covering all 14 supported strategies — every feature is live. The Explain button is available on every trade in both Demo and Live modes and walks through the mechanics in plain English with exact figures from your actual trade data.')}
      </div>
    ),
  },

  {
    id: 'first-trade', cat: 'Getting Started',
    title: 'Logging Your First Trade',
    keywords: ['add trade','log trade','new trade','entry','form','first','setup','lot'],
    content: (
      <div>
        <p>The foundation of the app is the stock lot. Before logging options trades, adding your share positions first enables cost basis tracking, the uncovered position alert, and the full wheel cycle return summary. Go to <strong>Stock Positions → Add Lot</strong> and enter ticker, shares, purchase price, and date.</p>
        <p>Then click <strong>+ Log Trade</strong> in the sidebar. The form covers five sections:</p>
        {kv([
          ['Trade Details', 'Ticker, strategy type, and the stock lot this trade is written against. Linking CCs and CSPs to a lot is what enables net cost basis reduction and the full wheel summary.'],
          ['Dates',         'Entry date, option expiry, and exit date. The expiry calendar shows only valid Fridays (or Thursday holiday fallbacks). A quick-jump strip shows the next 4 valid expiries as one-click pills.'],
          ['Pricing',       'Entry premium collected (credit) or paid (debit), buy-back price when closing, and contracts. For spreads, enter the net credit or debit across both legs as a single per-share figure.'],
          ['Greeks at Entry','Delta, Gamma, Theta, Vega, and IV. Optional but valuable — after 30–40 trades your personal entry-quality patterns emerge.'],
          ['Notes',         'Entry thesis, strike rationale, market context. A well-kept journal is one of the most effective tools for improving entry discipline over time.'],
        ])}
        {tip('Linking CCs and CSPs to a stock lot unlocks three things in one step: the net cost per share in Stock Positions, the uncovered position amber badge visible on every screen, and the full wheel cycle P&L summary when the lot eventually closes.')}
        <p><strong>Closing a trade:</strong> find it in the Trade Log and click the action button (Assigned, Called Away, Roll, Expired) — or edit the trade to add exit price and date. P&L calculates automatically.</p>
        <p><strong>Lot # in the CC dropdown:</strong> when multiple open lots exist for the same ticker at the same price — for example one assigned via CSP and one purchased outright — the dropdown shows Lot # alongside the ticker and price so the correct lot is always identifiable.</p>
      </div>
    ),
  },

  {
    id: 'demo-mode', cat: 'Getting Started',
    title: 'Demo Mode — Exploring the App',
    keywords: ['demo','sample','example','test','mock','explain','learn'],
    content: (
      <div>
        <p>Demo Mode loads 65 pre-built trades with dynamically calculated dates — expiry dates are always real Fridays relative to today, so DTE values look current. The demo covers all 14 supported strategies: wheel cycles on AAPL, TSLA, ABBV, VRTX, and NVDA (full assigned-CC-calledaway cycle), SPY/QQQ Iron Condors with chain adjustments, NFLX Calendar spreads, INOD Diagonal spreads, straddles, strangles, long calls and puts, and debit/credit spreads.</p>
        <p>Demo and Live data are completely separate databases — switching between them never affects your real trades.</p>
        <p>The <strong>Explain button</strong> (💡) is available on every trade in both Demo and Live modes. It opens a plain-English walkthrough: what was sold, what obligation was accepted, what happened, and what every dollar number means.</p>
        {kv([
          ['AAPL id=1',       'Perfect CC outcome — expired OTM, full $830 kept on 2 contracts. The ideal result when the wheel works as intended.'],
          ['TSLA id=6',       'CSP assignment — $250 strike, $6.50 premium. Effective cost $243.50. Phase 2 (Covered Calls) begins immediately after assignment.'],
          ['NVDA ids 10–14',  'Full wheel cycle — CSP assigned at $840, four CC cycles across $860/$880/$910/$960, called away at $960. Total return: $15,510 on one lot.'],
          ['SPY ids 30–33',   'IC chain with adjustment — put spread rolled during a rally. Running chain credit visible on the chain header row throughout.'],
          ['NFLX ids 214–216','Calendar chain — short leg closed after earnings drop, adjustment made, back-month anchor still open. Shows the full Adj Cal workflow.'],
        ])}
        {good('Working through the NVDA cycle (ids 10–14) from start to finish is the single most effective introduction to wheel mechanics in concrete dollar terms. By the end you will understand assignment, cost basis reduction, CC management, and Called Away — all from one connected position.')}
      </div>
    ),
  },

  // ─────────────── STRATEGIES ────────────────────────────

  {
    id: 'covered-call', cat: 'Strategies',
    title: 'Covered Call (CC)',
    keywords: ['covered call','cc','call','income','cost basis','called away','strike','collar'],
    content: (
      <div>
        <p>The Covered Call is the wheel's primary income engine. Selling a call against shares you already own collects premium immediately and reduces your effective cost per share with every successful cycle. If the stock stays below the strike at expiry, the option expires worthless and premium is kept in full. If the stock rises above the strike, shares are sold at that price.</p>
        <p><strong>Conditions experienced practitioners look for:</strong> IV above the stock's 6-month median. Stock flat or gently trending. Strike 1–2 standard deviations above current price. Delta 0.20–0.35. 30–45 DTE.</p>
        {warn('Most wheel traders treat net cost per share as a personal floor for the CC strike. Selling below it means a potential share loss if called away — the app shows a warning when a strike is entered below net cost.')}
        {kv([
          ['Expires OTM',       'Ideal outcome. Full premium kept. Sell the next CC cycle. Cost basis falls by the premium per share collected.'],
          ['Approaches strike', 'Rolling is the standard response — buy back the current call and sell a new one at a later expiry and possibly higher strike, ideally for a net credit.'],
          ['Called away',       'Click Called Away in the Trade Log. The CC closes, the linked lot closes at the strike price, and the full wheel cycle summary is calculated automatically.'],
        ])}
        {tip('Demo example — NVDA CC cycle: ids 11–13 generated $8.50 + $9.00 + $7.50 per share across three consecutive cycles, all expiring OTM or closed early. When NVDA reached $960, CC id=14 triggered Called Away, realising the share gain on top of $3,510 in total option income. The net cost basis had already fallen to below $840 before the first CC was written.')}
      </div>
    ),
  },

  {
    id: 'csp', cat: 'Strategies',
    title: 'Cash-Secured Put (CSP)',
    keywords: ['cash secured put','csp','put','assignment','assigned','entry','wheel entry'],
    content: (
      <div>
        <p>The Cash-Secured Put is the wheel's entry mechanism. Selling a put while holding sufficient cash to buy 100 shares per contract at the strike collects premium immediately. If the stock stays above the strike at expiry, the option expires worthless. If the stock falls to or below the strike, assignment delivers shares at an effective cost that is always lower than the stock price at entry — the premium discount is the built-in advantage.</p>
        <p><strong>Conditions experienced practitioners look for:</strong> A stock you would be comfortable holding through a drawdown at the strike price. Strike near technical support. IV elevated. Delta 0.25–0.35. 30–45 DTE.</p>
        {kv([
          ['Expires OTM',    'Full premium kept. No shares acquired. Sell another CSP next cycle.'],
          ['Assigned',       'Click Assigned in the Trade Log. The CSP closes and a stock lot is created at the strike price automatically — all collected premium is tracked against it from the start.'],
          ['Effective cost', 'Strike price minus all premium collected. This is always below the market price at entry — the structural advantage of the put-selling approach.'],
        ])}
        {tip('Demo example — TSLA CSP id=6: strike $250, premium $6.50, IV 55%. Effective cost on assignment: $250 − $6.50 = $243.50/share — $6.50 cheaper per share than buying outright at assignment, purely from the premium. The lot was then wheeled with Covered Calls, with total wheel premium reducing the cost basis to $219.70/share (lot notes).')}
        <p>Assignment is not a failure of the strategy — it is the mechanism working as designed. The question practitioners ask before entry is not "will I be assigned?" but "am I happy owning this stock at this price for this premium?"</p>
      </div>
    ),
  },

  {
    id: 'rolling', cat: 'Strategies',
    title: 'Rolling a Position',
    keywords: ['roll','rolling','extend','avoid assignment','net credit','r1','r2','r3','roll modal'],
    content: (
      <div>
        <p>Rolling means buying back a current option and simultaneously selling a new one at a different strike, expiry, or both. The purpose varies by situation: buying more time when a position is threatened, collecting additional premium at a higher strike as the stock rises, or repositioning a spread leg after a breach.</p>
        <p>Experienced practitioners generally aim to collect a net credit on every roll — the new premium received exceeds the cost to buy back the current position. A roll for a net debit extends duration without compensation, which is why most traders avoid it. The Roll Modal shows this calculation in real time before any trade is committed.</p>
        {kv([
          ['Roll out',        'Same strike, later expiry. Buys time without changing the exit price. Typically the first response when a CC is threatened.'],
          ['Roll up and out', 'Higher strike and later expiry for a net credit. Improves the exit price while collecting more premium — the most favourable roll outcome.'],
          ['Roll down (CSP)', 'Lower strike, later expiry. Reduces assignment risk but increases capital at risk. Most practitioners limit this to once on any given position — further rolls compound the exposure rather than resolving it.'],
        ])}
        {tip('Demo example — TSLA CC id=7: original $275 strike. When TSLA rallied, the position was rolled out to a later expiry at a higher strike for a net credit. The R1 badge in the Trade Log marks the rolled position. The chain shows the combined P&L across both the original and rolled trade.')}
        <p><strong>How to roll in the app:</strong> click Roll on any open CC, CSP, or spread in the Trade Log. Enter the buy-back price, new strike, new expiry, and new premium. The modal shows net credit or debit in real time. The rolled position receives an R1 badge (R2, R3 for multiple rolls) and links back to the original trade for chain P&L tracking.</p>
        {warn('The Roll Modal scenario cards show BSM-estimated premiums marked with an amber [est.] badge. Always update the New Premium field to the actual fill price from your broker before saving.')}
      </div>
    ),
  },

  {
    id: 'iron-condor', cat: 'Strategies',
    title: 'Iron Condor (IC)',
    keywords: ['iron condor','ic','condor','put spread','call spread','range','neutral','spy','qqq','adj ic'],
    content: (
      <div>
        <p>An Iron Condor sells an OTM put spread and an OTM call spread simultaneously on the same underlying and expiry. The position collects premium from both wings and profits if the stock stays between the two short strikes at expiry. No shares required — the P&L is purely from premium income on a range-bound view.</p>
        <p><strong>Structure:</strong> four legs, two spreads. Short OTM put (plus long further-OTM put to cap downside risk). Short OTM call (plus long further-OTM call to cap upside risk). Both the maximum profit (net premium received) and the maximum loss per wing (spread width minus net credit) are fully defined before entry.</p>
        {kv([
          ['Max profit',   'Total net credit collected across both wings. Achieved when both short strikes expire OTM.'],
          ['Max loss',     '(Spread width − net credit) × contracts × 100, applied to the breached wing only. The other wing expires worthless and keeps its credit.'],
          ['Close target', '50% of net credit is the standard early-close signal, visible in the % Max column of the Trade Log.'],
          ['Entry via form','Put Wing: enter Put Sell Strike, Put Buy Strike, Put Credit. Call Wing: enter Call Sell Strike, Call Buy Strike, Call Credit. Profit Zone and Total Credit display live as you type.'],
        ])}
        {tip('Demo example — SPY IC chain ids 30/130 and 31/131: put spreads at $540/$530 and $545/$535 each collected $1.55 and $1.40 net credit. SPY stayed in range throughout. Both closed early — one at 80% profit, one at near-expiry worthless. Combined chain P&L: $524 across two IC cycles on SPY.')}
        <p>The IC chain adjustment system tracks multi-leg adjustments as a linked sequence. The chain header in the Trade Log shows running P&L across all legs. See the IC and IB Adjustments article for the full adjustment workflow.</p>
      </div>
    ),
  },

  {
    id: 'iron-butterfly', cat: 'Strategies',
    title: 'Iron Butterfly (IB)',
    keywords: ['iron butterfly','ib','butterfly','atm','body','wing','adj ib','tent'],
    content: (
      <div>
        <p>An Iron Butterfly is an Iron Condor where both short strikes are placed at the same ATM price — the body. This concentrates maximum profit at exactly the current stock price, producing a tent-shaped payoff curve. The trade collects significantly more premium than an equivalent IC because both spreads are sold ATM rather than OTM. The tradeoff is a much narrower profitable range: the stock needs to pin near the body rather than simply stay within a wide channel.</p>
        <p><strong>Structure:</strong> sell put at ATM body, buy put below (put wing). Sell call at same ATM body, buy call above (call wing). The two sell strikes are identical — this is the defining characteristic of the IB.</p>
        {kv([
          ['ATM body',     'The central sell strike for both the put and call wings. Must be the same for both — the app rejects mismatched entries.'],
          ['Wing width',   'Distance from the body to each buy strike. Wider wings = more premium collected but higher maximum loss per side.'],
          ['Break-even',   'Body ± total net credit. With total credit of $12.80 and body at $875, breakevens are $875 − $12.80 = $862.20 and $875 + $12.80 = $887.80.'],
          ['Entry form',   'Enter ATM body once in Put Sell Strike — Call Sell Strike auto-mirrors it and is locked. Only the wing buy strikes differ between put and call sides.'],
        ])}
        {tip('Demo example — NVDA IB ids 50/150: body at $875, put wing $875/$840, call wing $875/$910. Total net credit per wing: $6.40 each, $12.80 combined per share ($1,280 on 1 contract). NVDA stayed near $875. Both wings closed at 75% profit. Total P&L: $480 + $480 = $960.')}
        <p><strong>Key difference from IC when adjusting:</strong> the ATM body (sell strike) is locked on all roll and adjustment types — it cannot be changed. Only the buy strikes, expiry, and premium change on any adjustment. The Adj IB wizard enforces this automatically. See the IC and IB Adjustments article for the full workflow.</p>
        {warn('The IB profitable range is narrow — typically 3–8% of the stock price. It is best suited to low-volatility environments where the stock is expected to consolidate, not trend. A sharp one-day move against the body can breach both wings simultaneously.')}
      </div>
    ),
  },

  {
    id: 'vertical-spreads', cat: 'Strategies',
    title: 'Vertical Spreads',
    keywords: ['spread','bull put','bear call','bull call','bear put','vertical','credit spread','debit spread','bps','bcs','bcls'],
    content: (
      <div>
        <p>Vertical spreads pair a bought and sold option at different strikes on the same expiry. Credit spreads (Bull Put, Bear Call) generate income with no shares required. Debit spreads (Bull Call, Bear Put) are directional trades with fully defined risk and reward. All four use the same entry form — enter net credit or net debit as the Entry Price.</p>
        {kv([
          ['Bull Put Spread',  'Sell OTM put, buy lower-strike put. Net credit. Profit if stock stays above the short strike. Neutral-to-bullish directional view.'],
          ['Bear Call Spread', 'Sell OTM call, buy higher-strike call. Net credit. Profit if stock stays below the short strike. Neutral-to-bearish view.'],
          ['Bull Call Spread', 'Buy ATM/OTM call, sell higher-strike call. Net debit. Profit if stock rises above the long strike. Bullish with capped upside.'],
          ['Bear Put Spread',  'Buy ATM/OTM put, sell lower-strike put. Net debit. Profit if stock falls below the long strike. Bearish with capped downside.'],
        ])}
        <p><strong>Validation:</strong> the app enforces a hard stop if Net Debit equals or exceeds the spread width — this is mathematically impossible and typically indicates a data entry error. An amber warning appears if Net Debit exceeds half the spread width, flagging unfavourable risk/reward before submission.</p>
        {tip('Demo example — QQQ Bull Put Spread id=36: short $468P / long $460P. Net credit $2.60, 2 contracts. QQQ held above $468. Closed at $0.52. P&L: (2.60 − 0.52) × 2 × 100 = +$416. Max loss was (8.00 − 2.60) × 200 = $1,080 — clearly defined before entry.')}
        {tip('Demo example — AXSM Bull Call Spread id=43: buy $165C / sell $175C. Net debit $3.20, 2 contracts. Max profit if AXSM > $175 at expiry: (10.00 − 3.20) × 200 = $1,360. Max loss: $3.20 × 200 = $640. Risk/reward clearly defined at entry.')}
        <p><strong>Strike error display:</strong> when strikes are in an invalid relationship (e.g. Bull Call Spread sell strike below buy strike), the error message appears on the specific field that needs correcting rather than on both fields simultaneously. The live summary banner also suppresses until strikes are valid.</p>
      </div>
    ),
  },

  {
    id: 'calendar-spread', cat: 'Strategies',
    title: 'Calendar Spread',
    keywords: ['calendar','calendar spread','front month','back month','net debit','vega','time spread','adj cal'],
    content: (
      <div>
        <p>A Calendar Spread sells a near-term option (front month, short leg) and buys a longer-dated option at the same strike (back month, long leg). The position profits from time decay on the short leg while the long leg acts as both protection and a source of residual value. Because the back month decays more slowly than the front month, the spread typically gains value as the front-month option approaches expiry — as long as the stock stays near the strike.</p>
        <p><strong>Entry:</strong> select Option Type (Call or Put calendar), enter Strike (same for both legs), Front Month Expiry (short leg), Back Month Expiry (long leg, must be later), Front Month Credit (premium received), and Back Month Cost (premium paid). The Net Debit calculates automatically — it is your total cost and maximum risk.</p>
        {kv([
          ['Net Debit',       'Back Month Cost − Front Month Credit. AUTO-calculated. Maximum loss if the stock moves far from the strike before the front month expires.'],
          ['Max profit zone', 'Stock pins near the strike at front-month expiry. The short leg expires worthless while the back-month long leg retains significant time value.'],
          ['IV relationship', 'Calendars have positive vega — rising IV benefits the position. Many practitioners enter calendars when IV is low and expected to expand.'],
          ['Option Type',     'Call calendars are neutral to slightly bullish. Put calendars are neutral to slightly bearish. The choice affects which chain is fetched for pricing.'],
        ])}
        {tip('Demo example — NFLX Calendar chain id=214/215: front month $95C sold at $4.20 (35 DTE), back month $95C bought at ~$8.80 (net debit ~$4.60). NFLX dropped sharply post-earnings. Short leg closed at $1.80 (P&L on that cycle: (4.20 − 1.80) × 100 = +$240). Back month anchor id=215 held open. New short leg id=216 sold at $3.80 at $90 strike after the move. The Adj Cal wizard managed the transition.')}
        <p>For Calendar adjustments (rolling the short leg forward, rolling the long leg to a new expiry, converting to a Diagonal by changing the long strike), see the Calendar and Diagonal Adjustments article. The Adj Cal button appears on the chain header row in the Trade Log.</p>
      </div>
    ),
  },

  {
    id: 'diagonal-spread', cat: 'Strategies',
    title: 'Diagonal Spread',
    keywords: ['diagonal','diagonal spread','pmcc','synthetic','different strikes','adj diag'],
    content: (
      <div>
        <p>A Diagonal Spread is a Calendar Spread where the two legs have different strikes as well as different expiries. The most common version (sometimes called a Poor Man's Covered Call) buys a deep ITM long-dated call as the anchor and sells shorter-dated OTM calls against it to generate income. This provides leveraged CC-like income without owning the actual shares.</p>
        <p><strong>Key distinction from Calendar:</strong> the short leg strike and the long leg strike are different. The short leg is typically OTM (the income-generating strike), while the long leg is ATM or ITM (providing delta exposure and protection). The app enforces that the short leg strike is always the lower of the two for call diagonals.</p>
        {kv([
          ['Net Debit',       'Long leg cost − short leg credit. AUTO-calculated. Your initial capital at risk.'],
          ['Strike relationship','Short (front) leg strike must be lower than the long (back) leg strike on a call diagonal. App hard-stops if entered reversed.'],
          ['Income mechanism', 'Short leg collects premium on each cycle. When it expires or is bought back, a new short leg is sold — similar to writing CCs, but against an options position rather than shares.'],
          ['Conversion',      'A Diagonal can be converted to a Calendar (matching the strikes) via the Adj Cal wizard — useful when the stock moves to the long leg strike.'],
        ])}
        {tip('Demo example — INOD Diagonal ids 49/491: short leg $25C (~21 DTE) sold at $0.58, long leg $27C (~56 DTE) bought at $1.13. Net debit: $0.55/share on 2 contracts = $110 total cost. Short leg $25C is OTM vs ~$22 spot — positioned to expire worthless and be resold. The long $27C anchor provides leveraged upside if INOD moves above $27.')}
        <p>Diagonal adjustments are handled through the Adj Cal wizard (the same wizard serves both strategies). Adjustment types include rolling the short leg forward, rolling the long leg to a new expiry, converting to a Calendar, and closing individual legs. See the Calendar and Diagonal Adjustments article for the full workflow.</p>
      </div>
    ),
  },

  {
    id: 'long-strategies', cat: 'Strategies',
    title: 'Long Strategies — Long Call, Long Put, Straddle, Strangle',
    keywords: ['long call','long put','straddle','strangle','directional','debit','iv','earnings'],
    content: (
      <div>
        <p>Long option strategies pay a premium upfront for the right to profit from a directional move (Long Call, Long Put) or a large move in either direction (Straddle, Strangle). Unlike credit strategies where time decay works in the seller's favour, long options require the stock to move enough to overcome the premium paid before expiry.</p>
        {kv([
          ['Long Call',         'Buy a call at a chosen strike. Profit if stock rises above strike + premium paid. Maximum loss: premium paid. No shares required.'],
          ['Long Put',          'Buy a put at a chosen strike. Profit if stock falls below strike − premium paid. Useful as a portfolio hedge or a standalone bearish bet.'],
          ['Long Straddle',     'Buy ATM call and ATM put at the same strike and expiry. Profit if the stock moves significantly in either direction. Enter the combined debit of both legs as a single Option $ value.'],
          ['Long Strangle',     'Buy OTM call and OTM put at different strikes. Cheaper than a straddle but requires a larger move to profit. Same single combined-debit entry approach.'],
        ])}
        {tip('Demo example — NFLX Long Put id=39: $940 put bought at $9.20 with NFLX near $920. NFLX sold off post-earnings to ~$870. Put went deep ITM, closed at $18.50. P&L: (18.50 − 9.20) × 100 = +$930. The position doubled in value on a single earnings-driven move.')}
        {tip('Demo example — CRSP Straddle id=44: ATM straddle at $57 strike, combined debit $14.20. FDA delay announced — IV collapsed (IV crush). Despite the news, CRSP barely moved. Straddle closed at $6.80 combined. P&L: (6.80 − 14.20) × 100 = −$740. Classic IV crush outcome — the event occurred but the move was smaller than IV implied.')}
        <p>For Straddles and Strangles, the Option $ field holds the combined current value of both legs (call mid + put mid). The app tracks the full position as a single P&L figure rather than two separate legs.</p>
        {warn('Long options and straddles are the strategies most sensitive to IV crush — the sharp drop in implied volatility that often follows a binary event. Buying before earnings when IV is already elevated means paying a premium that pricing may not justify if the move is smaller than expected.')}
      </div>
    ),
  },

  // ─────────────── ADJUSTMENTS ───────────────────────────

  {
    id: 'ic-ib-adjustments', cat: 'Adjustments',
    title: 'IC and IB Adjustments (Adj IC / Adj IB)',
    keywords: ['adj ic','adj ib','iron condor adjustment','iron butterfly adjustment','chain','roll leg','wizard','condor adjust'],
    content: (
      <div>
        <p>The IC and IB adjustment system tracks multi-leg adjustments as a linked chain. Each adjustment appears in the Trade Log with a chain ID and sequence badge (A1, A2). The chain header row shows running realised plus unrealised P&L across all legs combined, so you always know the full position result regardless of how many adjustments have been made.</p>
        <p><strong>To access:</strong> click Adj IC on any Iron Condor chain header row, or Adj IB on any Iron Butterfly chain header row. The button is always visible — no need to expand the chain first.</p>
        <p><strong>3-step wizard:</strong> Choose adjustment type → Enter details → Confirm with live P&L preview.</p>
        <p><strong>Seven adjustment types (available for both IC and IB):</strong></p>
        {kv([
          ['Roll one leg',       'Close the threatened spread (put or call wing) and reopen at a new strike or expiry for a credit. The most common IC adjustment when one side is approached.'],
          ['Roll full position', 'Close all open legs and reopen the entire structure at new strikes. IC: all four strikes can change. IB: ATM body is locked — only wing buy strikes and expiry change.'],
          ['Reduce size — one leg','Buy back contracts on one wing only to reduce directional risk without closing the full position.'],
          ['Reduce position',    'Reduce contracts on both wings. Proportionally scales risk down while keeping the position alive on both sides.'],
          ['Roll + reduce',      'Roll one leg to a new strike while simultaneously reducing contracts. Repositions and right-sizes in a single step.'],
          ['Close one leg',      'Close one wing entirely. The remaining wing stays open to collect further theta decay.'],
          ['Close position',     'Close all remaining open legs. Used at profit target, stop-loss, or ahead of a catalyst.'],
        ])}
        <p><strong>IB-specific locking rules:</strong> on an Iron Butterfly, the ATM body (sell strike) is locked on all adjustment types — it cannot be changed on any roll or partial close. Only the wing buy strikes, expiry, and premium can be adjusted. The wizard enforces this automatically: the sell strike field is pre-filled and read-only, and an advisory note explains why.</p>
        {tip('Demo example — SPY IC chain ids 30/130/31/131: original IC collected $1.55 + $1.55 = $3.10 combined credit (put + call wings). When SPY moved, the put spread was rolled — closed for $0.05, new put spread opened at a tighter range for $1.40 fresh credit. Running chain credit continued growing across each adjustment. The chain header showed the cumulative P&L at every stage.')}
      </div>
    ),
  },

  {
    id: 'cal-diag-adjustments', cat: 'Adjustments',
    title: 'Calendar and Diagonal Adjustments (Adj Cal)',
    keywords: ['adj cal','adj diag','calendar adjustment','diagonal adjustment','roll short','roll front','widen diagonal','convert'],
    content: (
      <div>
        <p>Calendar and Diagonal adjustments are handled through the Adj Cal wizard — the same wizard serves both strategy types. The button appears on the chain header row in the Trade Log for any open Calendar or Diagonal chain. Like the IC wizard, it is a 3-step modal: choose type → enter details → confirm with P&L preview.</p>
        <p><strong>Seven adjustment types:</strong></p>
        {kv([
          ['Roll short leg',           'Buy back the current front-month short leg and sell a new short leg at the same strike on a later expiry. The most common Calendar adjustment — extends income generation after the front month approaches expiry.'],
          ['Roll front leg out',        'Roll the long (back-month) anchor to a further expiry without changing its strike. Extends the life of the position while maintaining directional exposure.'],
          ['Widen to diagonal',         'Change the long leg strike to create a diagonal from a calendar. Used when the stock has moved away from the original strike and a different long leg strike makes more sense.'],
          ['Convert to calendar',       'Match the long leg strike to the short leg strike, converting a diagonal back to a standard calendar. Useful when the position has moved in your favour.'],
          ['Close short leg',           'Buy back only the front-month short leg. Leaves the long leg open as a standalone long option.'],
          ['Close long leg',            'Sell the back-month long leg. Leaves only the short leg open — effectively a naked short option. The app shows a warning.'],
          ['Close position',            'Close all open legs simultaneously. Used when exiting the full calendar or diagonal campaign.'],
        ])}
        {tip('Demo example — NFLX Calendar chain: NFLX dropped post-earnings. Short leg id=214 (front month $95C) was bought back at $1.80 after being sold at $4.20 — profit on that cycle: +$240. The back-month long leg id=215 ($95C, ~52 DTE) was kept open as the anchor. A new short leg id=216 was then sold at $90C for $3.80 using the Adj Cal Roll Short wizard step, repositioning the short strike below the new stock price.')}
        <p>Closing P&L, Net from Roll, and Net Cost figures are all calculated and displayed live in the wizard before confirmation — nothing is committed until you click Confirm in Step 3.</p>
      </div>
    ),
  },

  // ─────────────── FEATURES ──────────────────────────────

  {
    id: 'trade-log-cols', cat: 'Features',
    title: 'Trade Log — Column Layout',
    keywords: ['trade log','columns','dte','delta','pnl','max profit','percent','column','layout'],
    content: (
      <div>
        <p>The Trade Log uses a 16-column layout ordered by decision priority — information you need to act on is on the left, reference data on the right. Clicking any column header sorts by that column. The most useful daily sort: DTE ascending, which surfaces the most time-sensitive positions immediately.</p>
        {kv([
          ['Position',   'Ticker, strategy badge, and alert bell. All action buttons live here — Assigned, Called Away, Roll, Adj IC, Adj IB, Adj Cal, Edit, Delete, Explain (💡). Everything accessible from one column.'],
          ['DTE',        'Days To Expiry. Green (21+), amber (8–21), red (7 or fewer). Progress bar shows elapsed option life.'],
          ['Strike',     'Short strike for CCs and CSPs. Both strikes (buy / sell) for spreads. Both wings shown for IC/IB chain headers.'],
          ['Qty',        'Contracts. 1 contract = rights on 100 shares.'],
          ['Stock $',    'Type current stock price here. Turns red with an ITM warning when a CC stock price exceeds the strike, or a CSP stock price falls below it.'],
          ['Entry $',    'Premium collected or paid per share at entry.'],
          ['Opt $',      'Type current option midpoint (bid + ask ÷ 2). Updates % Max and P&L instantly.'],
          ['% Max',      '% of maximum premium captured so far. Green checkmark badge at 50% is the standard close-early signal. For closed trades: % of max profit actually realised.'],
          ['Theo P&L',   'Black-Scholes theoretical position value today. Compare against your actual Opt $ to see whether the market is pricing cheap or rich vs the model.'],
          ['P&L Curve',  'Click the chart icon for the interactive payoff chart — solid red expiry line plus dashed blue BS-today line. Adjust IV in real time via the slider.'],
          ['P&L',        'Closed: realised P&L. Open credit trade: premium collected (shown in blue, labelled "coll.").'],
          ['Greeks',     'Delta, Gamma, Theta, Vega at entry. Red badge if delta exceeds 0.50. Click for full Greeks popup.'],
          ['Entry',      'Trade entry date.'],
          ['Expiry',     'Option expiry — always a Friday, or Thursday when Friday is a US market holiday.'],
          ['Closed',     'Exit date. Blank for open trades.'],
          ['Buy Back',   'Price paid to close. Blank for open trades.'],
        ])}
      </div>
    ),
  },

  {
    id: 'alerts-insights-monitor', cat: 'Features',
    title: 'Alerts & Actionable Insights Monitor',
    keywords: ['alerts','actionable','insights','monitor','roll strategies','scenarios','alert','urgent','dte','delta','expiry','close','bell'],
    content: (
      <div>
        <p>The Alerts & Actionable Insights Monitor sits directly below the Trade Log and is always visible. It surfaces both the problem and the potential responses in the same panel — no separate screen, no manual calculations. When all positions are healthy it collapses to a single green bar. It expands automatically when any position needs attention, sorted most urgent first.</p>
        <p><strong>Three alert levels — fired automatically:</strong></p>
        {kv([
          ['Red alert',   'DTE 7 or fewer, OR delta above 0.50. Action required today.'],
          ['Amber alert', 'DTE 21 or fewer, OR delta between 0.35 and 0.50. Review this week.'],
          ['Blue alert',  '% Max Profit at 50% or above on one threshold, and 80% or above on a second threshold. Both are independent — either can trigger. Take-profit signal.'],
        ])}
        <p><strong>Roll strategy panel:</strong> click "Roll options" on any flagged row. A panel expands inline showing four pre-calculated scenarios:</p>
        {kv([
          ['Close now',                    'Estimated buy-back cost and combined P&L if closed today.'],
          ['Roll out — 30 DTE same strike', 'Minimum time extension. Net credit estimate and combined P&L.'],
          ['Roll out — 45 DTE same strike', 'Full reset into optimal theta zone. Recommended for most situations.'],
          ['Roll up/down — 45 DTE',         'Improved strike (higher for calls, lower for puts) plus 45-day extension.'],
        ])}
        <p>Every scenario shows estimated buy-back cost, new premium, net credit on the roll, and combined P&L including all previously collected premium. Figures use Black-Scholes with the trade's IV at entry and current stock price if live data is connected.</p>
        {tip('Alert thresholds reflect widely accepted options trading principles — 21 DTE gamma acceleration, 50% profit capture, delta above 0.50 assignment probability, 7 DTE expiry danger zone, and two independent profit-take levels at 50% and 80%.')}
        {warn('Demo example — open positions with red alerts show the full scenario panel in action. Click "Roll options" on any red-alert row to see all four scenarios calculated. When a scenario produces a net debit, the net credit cell turns red — a clear visual signal before any trade is executed.')}
      </div>
    ),
  },

  {
    id: 'pnl-curve', cat: 'Features',
    title: 'P&L Curve — Payoff Chart',
    keywords: ['pnl curve','payoff','chart','black scholes','iv','theoretical','graph','bs'],
    content: (
      <div>
        <p>Click the chart button on any Trade Log row to open the P&L curve popup. Two lines show the current position simultaneously:</p>
        {kv([
          ['Red solid line',    'Exact expiry payoff at every possible stock price. Mathematical payout if held all the way to expiry — no model needed.'],
          ['Blue dashed line',  'Black-Scholes theoretical value today, given current stock price, IV, and time remaining. Shows what the position is worth right now if closed.'],
          ['Zero reference',    'Horizontal breakeven line. Above = profit, below = loss.'],
          ['Current price line','Vertical line showing where the stock is today relative to strikes and breakeven points.'],
        ])}
        <p><strong>IV adjustment slider:</strong> move it and the blue BS-today line redraws instantly. Useful for modelling what happens if IV expands (option becomes more expensive to buy back) or contracts (option loses value faster).</p>
        <p><strong>IV source hierarchy:</strong> live data feed → IV at entry → VIX times a per-stock multiplier (TSLA 2.8×, NVDA 2.0×, large-cap tech 1.5×, broad ETFs 1.0×) → manual input.</p>
        {tip('The gap between the red expiry line and the blue BS-today line is the remaining time value in the option. A wide gap means significant time value remains — this is what you give up when closing early, but it is also the buffer protecting against a fast adverse move.')}
      </div>
    ),
  },

  {
    id: 'cc-recommendations', cat: 'Features',
    title: 'CC/CSP Recommendation Strip',
    keywords: ['recommendation','suggest','strike','bsm','iv','conservative','standard','aggressive','pre-fill'],
    content: (
      <div>
        <p>When opening the trade form for a new Covered Call or Cash-Secured Put, three suggested strikes appear automatically — Conservative, Standard, and Aggressive — computed using Black-Scholes from current IV and stock price.</p>
        {kv([
          ['Conservative', '30 DTE · ~0.20Δ · furthest OTM · lower assignment risk · less premium'],
          ['Standard',     '45 DTE · ~0.27Δ · optimal theta decay zone · best balance of premium vs risk'],
          ['Aggressive',   '30 DTE · ~0.35Δ · closer to ATM · more premium · higher assignment risk'],
        ])}
        <p><strong>Click any card</strong> to pre-fill expiry, strike, premium, delta, theta, and IV in one shot. The form opens ready to review — verify and update the Premium field to your actual broker fill.</p>
        {kv([
          ['Spot price source', 'Yahoo Finance live → manual input in the strip → lot avg cost as proxy'],
          ['IV source',         'Yahoo option chain → inline IV input in strip footer → 28% default'],
        ])}
        {warn('The premium shown on the recommendation card carries an amber [est.] badge — it is a BSM estimate. Always update it to your actual fill price from your broker before saving.')}
        {tip('If no live IV is available, a small "enter IV: __%" field appears in the strip footer. Typing your IV (e.g. 35) recalculates all three cards instantly — strike, premium, delta, and theta all update without reloading the form.')}
        <p><strong>Write CC button:</strong> on the Stock Positions page, every open lot with no active CC shows a blue Write CC pill. Clicking it opens the trade form pre-seeded with ticker, strategy, and lot — recommendations fire immediately.</p>
      </div>
    ),
  },

  {
    id: 'roll-modal', cat: 'Features',
    title: 'Roll Modal — Scenario Cards and Chain Viewer',
    keywords: ['roll','roll modal','scenario','chain','net credit','buy back','iv override','fill price'],
    content: (
      <div>
        <p>Click Roll on any open CC, CSP, or spread in the Trade Log. The Roll Modal shows three pre-calculated scenarios and an optional option chain viewer.</p>
        {kv([
          ['Roll Out · +30d',             'Same strike, 30 days past current expiry. Minimum time extension.'],
          ['Roll Out · +45d',             'Same strike, 45 days past current expiry. Full reset into optimal theta zone.'],
          ['Roll Out and Up/Down · +45d', 'Improved strike (+$5 for calls, −$5 for puts) plus 45-day extension.'],
        ])}
        <p>Each card shows expiry date, DTE, strike, estimated premium, and net credit (green) or net debit ⚠ (red) once the buy-back price is entered.</p>
        {warn('The New Premium Collected field shows an amber [est.] badge when filled from a scenario card — these are indicative BSM prices. Always update to your actual broker fill price after executing the roll.')}
        <p><strong>IV override:</strong> a "refine IV: ___ %" input below the scenario cards lets you correct the IV used for BSM estimates. Typing recalculates all three cards instantly.</p>
        <p><strong>Show Chain:</strong> click to open the full option chain for any expiry. Click any row to fill strike and premium. Green "live" badge = real price. Grey "est." badge = BSM synthetic price.</p>
        {tip('"How to Roll" button in the modal header opens a collapsible 5-step plain-English guide — useful reference for newer traders without interrupting the workflow for experienced ones.')}
      </div>
    ),
  },

  {
    id: 'dashboard', cat: 'Features',
    title: 'Dashboard — Performance Metrics',
    keywords: ['dashboard','pnl','profit','win rate','streak','factor','monthly','income','chart','metrics'],
    content: (
      <div>
        <p>The Dashboard shows realised performance from closed trades alongside real-time estimates for open positions. It answers two questions simultaneously: how has the strategy performed historically, and where do you stand right now if everything closed today.</p>
        {kv([
          ['Total P&L',         'Sum of all closed trade P&L. Open premium in-flight is excluded until locked in.'],
          ['Avg Monthly Income', 'Mean P&L per calendar month. Trailing 3-month shown alongside all-time — a quick read on whether recent performance is ahead or behind long-run rate.'],
          ['Win Rate + Streak',  'Win percentage of closed trades. The streak badge is a useful position-sizing signal — many practitioners reduce size on losing streaks and increase on win streaks.'],
          ['Profit Factor',      'Total wins divided by total losses in dollar terms. Above 2.0 is strong. Below 1.0 means losses are outpacing wins dollar-for-dollar.'],
          ['Monthly Bars',       '12-month bar chart. Green = profitable month. Red = losing month. Primary trend indicator.'],
          ['If Closed Today',    'Combined option plus share P&L if all open positions closed right now. Updates continuously with live data. Click to filter Stock Positions to open trades.'],
        ])}
        {tip('The If-Closed-Today card is the most actionable number on the dashboard. It shows your real financial position at this moment — not what you hope to make at expiry, but what you have actually made if you walked away from every open trade right now.')}
      </div>
    ),
  },

  {
    id: 'stock-positions', cat: 'Features',
    title: 'Stock Positions and Cost Basis',
    keywords: ['stock positions','lot','cost basis','net cost','coverage','premium','uncovered','wheel cycle','lot number'],
    content: (
      <div>
        <p>Stock Positions tracks share lots and makes the wheel's compounding effect visible over time. Each lot shows the original purchase price alongside the net cost per share after all premium collected — the difference between those two numbers is the total income the wheel has generated against that position.</p>
        {kv([
          ['Net Cost / Share',  'Purchase price minus all premium from trades linked to this lot. Falls with every successful CC or CSP cycle. When it reaches zero the shares were effectively acquired for free from a premium standpoint.'],
          ['Premium Collected', 'Running total of option income from all trades linked to this lot.'],
          ['Coverage Status',   'Green dot = active CC written against this lot. Amber badge = uncovered, no active CC. The sidebar shows uncovered count on every screen.'],
          ['Lot #',             'Unique identifier for each lot. Shown in the CC trade form dropdown when multiple open lots exist for the same ticker — essential for correctly linking the CC when lots have the same purchase price (e.g. one purchased outright, one assigned via CSP).'],
        ])}
        <p><strong>Wheel Cycle Summary</strong> appears for closed or called-away lots: total premium, share gain, combined return in dollars and percentage, and annualised return from first entry to exit.</p>
        {tip('Demo example — NVDA lot (lot id=6): 100 shares at $840 (assigned via CSP). Four CC cycles across $860/$880/$910/$960. Called away at $960. Wheel Cycle Summary: option income $3,510 + share gain (960−840)×100 = $12,000 + combined total = $15,510. Annualised return on $84,000 committed capital over ~5 months.')}
      </div>
    ),
  },

  {
    id: 'live-data', cat: 'Features',
    title: 'Live Data, Backup and Settings',
    keywords: ['live data','schwab','tradier','polygon','api','backup','restore','export','csv import','import','settings'],
    content: (
      <div>
        <p><strong>Live data connection:</strong> connect to a data provider and the Stock $ and Option $ columns populate automatically during market hours. Without a connection, prices can be typed manually at any time — all calculations are identical. Click the coloured dot at the bottom of the sidebar to configure. Status: green = live and polling, grey = market closed, red = connection error.</p>
        {kv([
          ['Schwab OAuth',  'Recommended for Schwab customers. Authenticates via OAuth — no API key to manage. Real-time quotes and Greeks. Token refreshes automatically.'],
          ['Tradier',       'Recommended for non-Schwab users. Free with a Tradier brokerage account. Real-time quotes and Greeks. Token never expires.'],
          ['Polygon.io',    'Paid plan required for intraday data. Free tier is end-of-day only.'],
          ['No connection', 'All calculations and features work fully without any live connection.'],
        ])}
        <p><strong>Backup:</strong> your data lives in a single file at C:\Users\YourName\AppData\Local\MyOptionDiary\data\trades.db. Click "Back Up Now" in Settings to download a timestamped copy. Storing backups in at least two locations (local + cloud) is widely considered minimum hygiene for a trade journal built over months or years.</p>
        <p><strong>CSV Import:</strong> click Import CSV in the Trade Log toolbar and select your broker. Supported: Charles Schwab, Tastytrade, IBKR, Robinhood. The app reads the broker's export format, maps columns automatically, and shows a preview before committing anything. Files are fingerprinted so the same file cannot be imported twice accidentally.</p>
        {warn('When entering CCs manually the lot link is always required. If trades were imported via CSV the lot link may be missing — go to Trade Log → Edit the CC → select the correct lot, then return to record Called Away or use the lot-history features.')}
      </div>
    ),
  },

  {
    id: 'ann-yield', cat: 'Features',
    title: 'Annualised Yield — How It Is Calculated',
    keywords: ['ann yield','annualized','yield','return','percent','dte','days','wheel','cost basis'],
    content: (
      <div>
        <p>Ann. Yield appears on open lot cards in Stock Positions and on the Wheel Summary tab. It answers: at the current rate, what annual return is this wheel generating on committed capital?</p>
        <p><strong>Formula:</strong> (total premium collected ÷ cost basis) ÷ max(days held, CC DTE) × 365 × 100</p>
        {kv([
          ['New position (days < DTE)',   'DTE wins → honest forward rate. A $80 premium on day 1 with 36 DTE shows ~8.7%/yr, not 314%/yr.'],
          ['Mature wheel (days > DTE)',   'Days held wins → accurate track record. 80 days of wheeling shows the real annualised yield from all cycles combined.'],
          ['Between CCs (no open CC)',    'Falls back to days held → position continues showing performance even with no active trade open.'],
        ])}
        {tip('Hover the Ann. Yield tile to see exactly which days figure was used — e.g. "÷ 36 DTE × 365" or "÷ 80 days × 365".')}
        {good('Wheel strategies on high-IV underlyings (TSLA, NVDA) typically generate 20–40%/yr annualised. Blue-chip stocks (AAPL, ABBV) typically run 10–20%/yr — lower premium but more predictable assignment behaviour and lower drawdown risk.')}
      </div>
    ),
  },

  // ─────────────── GREEKS ────────────────────────────────

  {
    id: 'delta', cat: 'Greeks',
    title: 'Delta — Probability and Directional Risk',
    keywords: ['delta','directional','probability','itm','assignment','0.30','0.50','in the money'],
    content: (
      <div>
        <p>Delta measures how much the option price moves per $1 move in the stock. For CC and CSP sellers, delta also approximates the probability the option finishes in the money at expiry. A delta of 0.30 means roughly 30% chance of being ITM — or 70% chance of expiring worthless. That 70% is the statistical edge the premium seller is extracting.</p>
        {kv([
          ['0.20–0.35 at entry', 'Target zone for CCs and CSPs. Statistically OTM 65–80% of the time while generating meaningful premium.'],
          ['0.35–0.50',          'Amber alert in the app. Option is approaching the money. Daily monitoring and a roll plan are warranted.'],
          ['Above 0.50',         'Red alert. The market is pricing ITM as the more likely outcome. Most practitioners act on this signal rather than waiting.'],
        ])}
        <p>Delta is dynamic. A CC sold at 0.28 with the stock comfortably below the strike can reach 0.45 within a week on a sharp rally. The Alerts Monitor tracks delta changes in real time and fires the alert automatically.</p>
        {tip('Higher IV generates more premium at the same delta. TSLA at delta 0.30 generates $11–16/share because IV runs around 55%. SPY at the same delta generates $3–5/share because IV runs around 14%. Same probability of success, dramatically different income — which is why many practitioners focus on high-IV underlyings for the wheel.')}
      </div>
    ),
  },

  {
    id: 'theta', cat: 'Greeks',
    title: 'Theta — Time Decay',
    keywords: ['theta','time decay','time value','45 dte','21 dte','decay','time'],
    content: (
      <div>
        <p>Theta is the daily rate at which an option loses value from time passing alone, independent of stock movement. For CC and CSP sellers, theta works in your favour every day — the option you sold decays in value while your collected premium stays in your account unchanged.</p>
        {kv([
          ['45 DTE entry',      'Where theta decay starts to accelerate meaningfully. The entry point that balances premium volume with capital efficiency.'],
          ['21 to 45 DTE',      'Steady, predictable decay. Position is manageable. Where most of the premium income is earned.'],
          ['Under 21 DTE',      'Theta accelerates — beneficial for the seller. But gamma also accelerates, making the position harder to manage if the stock moves unexpectedly.'],
          ['Under 7 DTE',       'Theta at its maximum rate — but gamma is also at peak. Small stock moves cause large option price swings. Red alert fires here.'],
        ])}
        <p>The 21 DTE close principle is primarily a gamma management decision: capturing accelerating theta profits while exiting before gamma risk becomes difficult to manage. The final few dollars of decay inside 7 DTE rarely justify the tail risk on a volatile underlying.</p>
        {tip('Demo example — NVDA CCs had theta values of −$0.18 to −$0.28 per day. At 30 DTE, that is $5.40 to $8.40 of option value decaying toward the seller every single trading day, even if NVDA does not move at all. This daily income is the structural advantage of premium selling over premium buying.')}
      </div>
    ),
  },

  {
    id: 'iv', cat: 'Greeks',
    title: 'IV — Implied Volatility',
    keywords: ['iv','implied volatility','volatility','premium','high iv','iv rank','vix','crush'],
    content: (
      <div>
        <p>IV reflects how much movement the market is pricing into the option over its remaining life. High IV means more expensive options and more premium for the seller. It is the single most important entry filter for premium sellers — selling into elevated IV is the core structural edge that wheel traders exploit.</p>
        {kv([
          ['IV above 6-month median', 'Elevated IV. Above-average premium available. If IV reverts lower after entry, the option loses value even faster — a beneficial effect called IV compression.'],
          ['IV below 6-month median', 'Suppressed IV. Options are cheap relative to their historical cost. Many practitioners prefer to wait for a volatility spike before entering.'],
          ['IV rank above 50',        'Current IV is above the midpoint of its 12-month range. Above 70 is high. The best entries are often at IV rank 50–80.'],
        ])}
        <p><strong>IV crush:</strong> IV typically spikes before earnings and major events, then drops sharply after the outcome is known. Selling into the pre-event spike and closing after the crush is a known premium-capture pattern — but it requires precise earnings-calendar tracking and an understanding that a large move can offset the IV compression benefit.</p>
        {tip('Demo example: TSLA IV at entry was 55–62%, generating $11.50–$15.00 per share per 30-day contract. QQQ IV was 17–18%, generating $7.60–$8.40 per share. Same strategy, same delta target — TSLA generates 60–80% more premium per dollar of stock price purely from the IV differential. Logging IV at entry for every trade is one of the most effective ways to build a personal entry-quality filter over time.')}
      </div>
    ),
  },

  {
    id: 'vega-gamma', cat: 'Greeks',
    title: 'Vega and Gamma',
    keywords: ['vega','gamma','volatility risk','gamma risk','danger zone','acceleration'],
    content: (
      <div>
        <p><strong>Vega</strong> measures how much the option price changes per 1% change in IV. Short-premium positions (CC, CSP, IC, credit spreads) have negative vega — falling IV benefits the position by making the option cheaper to buy back. Rising IV after entry makes the option more expensive, hurting unrealised P&L even if the stock has not moved.</p>
        {kv([
          ['Negative vega (short premium)', 'Falling IV benefits your position. Typical of CC, CSP, IC, IB, and credit spreads.'],
          ['Positive vega (long premium)',   'Rising IV benefits your position. Typical of long calls/puts, straddles, strangles, and calendar spreads.'],
          ['IC and vega',                    'Iron Condors have negative vega on both wings — they benefit from IV compression simultaneously on the put and call side.'],
        ])}
        <p style={{ marginTop: 14 }}><strong>Gamma</strong> measures how fast delta changes per $1 move in the stock. Low gamma means delta moves slowly — positions are predictable and manageable. High gamma means delta can shift dramatically on a single session move, turning a comfortable position into a critical one overnight.</p>
        {kv([
          ['Low gamma (45+ DTE)',        'Delta changes slowly. A $5 stock move might change delta by 0.02–0.03. Positions are stable.'],
          ['High gamma (under 21 DTE)',  'Delta moves fast. The same $5 move might change delta by 0.10–0.15. Positions can become urgent within a single session.'],
          ['ATM near expiry',            'Gamma is at its absolute maximum. Delta is nearly binary — one cent determines ITM or OTM. The 7 DTE red alert zone.'],
        ])}
        {warn('The 21 DTE close principle and 7 DTE red alert are gamma-management guidelines first. The accelerating theta inside 21 DTE is attractive, but so is the accelerating gamma risk. For most positions the gamma exposure outweighs the additional theta reward in the final three weeks — a widely held view among experienced retail options traders.')}
      </div>
    ),
  },

  // ─────────────── TIPS & RULES ──────────────────────────

  {
    id: 'wheel-rules', cat: 'Tips & Rules',
    title: 'Wheel Strategy — Practitioner Guidelines',
    keywords: ['rules','thumb','entry','exit','50%','21 dte','stop loss','position sizing','management','guidelines'],
    content: (
      <div>
        <p>The following guidelines reflect widely accepted principles among experienced retail options traders. They are starting frameworks developed from collective practitioner experience — not fixed rules, since every position and market environment differs. MyOptionDiary enforces several of them automatically through its alert system.</p>
        <p><strong>Entry</strong></p>
        {kv([
          ['30–45 DTE',       'The theta decay sweet spot. Too far out ties up capital with slow early decay. Too close and gamma risk is already elevated relative to remaining premium.'],
          ['Delta 0.20–0.35', 'Statistically OTM 65–80% of the time. Enough premium to justify the capital commitment, enough OTM cushion to manage the position if it moves against you.'],
          ['Elevated IV',     'Entering when IV is above the stock\'s 6-month median collects above-average premium and creates a beneficial tailwind if IV reverts lower after entry.'],
          ['Stock selection', 'Experienced practitioners only wheel stocks they would be genuinely comfortable holding at the CSP strike through a multi-month drawdown. Assignment is not a failure — it is the mechanism working.'],
          ['Diversification', 'Running all positions on highly correlated underlyings amplifies drawdown risk. NVDA, AMD, and TSLA tend to move together in sector selloffs.'],
        ])}
        <p><strong>Exit</strong></p>
        {kv([
          ['50% profit target',  'Closing at 50% of max profit captures half the premium in potentially a fraction of the time. The remaining 50% comes with diminishing reward relative to increasing gamma risk.'],
          ['21 DTE exit',        'If not at 50% profit by 21 DTE, closing and redeploying into a fresh 45-DTE position is the standard approach. Gamma risk accelerates sharply inside 21 days.'],
          ['2× stop-loss',       'A position that doubles in value against you has moved significantly. Most practitioners close and redeploy rather than hold through further deterioration. One managed loss typically recovers in two normal wins.'],
        ])}
        <p><strong>Rolling</strong></p>
        {kv([
          ['Net credit target',   'A net-credit roll collects more premium on the new position than it costs to close the current one — extending duration with compensation. A net-debit roll extends risk without it.'],
          ['Out before down',     'Rolling to a later expiry at the same or higher strike is generally preferred before considering a lower strike. Moving the strike down caps the exit price further.'],
          ['CSP roll frequency',  'Rolling a CSP down once is a common response to a falling stock. Rolling down repeatedly tends to compound exposure rather than resolve it — taking assignment and selling CCs is often the more effective path after the first roll-down.'],
        ])}
      </div>
    ),
  },

  {
    id: 'faq', cat: 'Tips & Rules',
    title: 'Common Questions',
    keywords: ['faq','question','how','record','expired','assigned','called away','partial','demo','export','restore','new pc'],
    content: (
      <div>
        {kv([
          ['Option expired OTM — how do I record it?',
           'Edit the trade: set Exit Price to 0.00 and Status to Closed. Full premium collected becomes the realised P&L. Or click the Expired button on the trade row if available.'],
          ['CSP was assigned — what do I click?',
           '"Assigned" in the Position column. Closes the CSP and creates the stock lot at the correct effective cost automatically. No manual entry needed.'],
          ['CC shares were called away?',
           '"Called Away" in the Position column. Closes the CC and marks the linked stock lot as sold at the strike price. The full Wheel Cycle Summary calculates immediately.'],
          ['Multiple lots for the same ticker — how do I pick the right one?',
           'The CC dropdown shows Lot # alongside ticker, shares, and price — e.g. "Lot #3 · AAPL — 100/100sh @ $210.50". The Lot # uniquely identifies each position, which is essential when two lots have the same ticker and price (e.g. one purchased outright, one assigned via CSP).'],
          ['Can I roll a CSP?',
           'Yes. Click Roll on any open CC, CSP, or spread. The Roll Modal shows three pre-calculated scenarios with live net credit or debit preview.'],
          ['How do I record a partial close?',
           'Create two trades: one for the quantity closed (with exit price and date), one for the quantity still open. Same entry date and notes to link them visually.'],
          ['Can I use demo without affecting real data?',
           'Yes. Demo and Live are completely separate databases. Switching between them never affects your real trades.'],
          ['Where is my data stored?',
           'C:\\Users\\YourName\\AppData\\Local\\MyOptionDiary\\data\\trades.db — on your local PC only. Nothing is transmitted to any server.'],
          ['Can I export my trades?',
           'Click Export CSV in the Trade Log toolbar. Downloads all visible trades. Apply filters first for a subset.'],
          ['App will not start — what do I do?',
           'Open %APPDATA%\\MyOptionDiary\\startup.log in Notepad. The last few lines show the exact error. Common causes: port 3002 in use by another app, or a previous node.exe still running in Task Manager.'],
          ['How do I move to a new PC?',
           'Install on the new PC, run once to create the data directory, close it, copy your backup .db file to the path above replacing the empty file. Restart and your full history is restored.'],
          ['The recommendation card premium differs from my broker — why?',
           'Cards use BSM pricing from Yahoo IV or a 28% default. Your broker shows the real bid/ask. The amber [est.] badge on the Premium field is the reminder to update to your actual fill.'],
          ['Why are expiry dates always on Fridays?',
           'Real options expire on Fridays (or Thursday when Friday is a US market holiday). The app snaps all expiry dates to the correct trading day, keeping DTE calculations and the Alerts Monitor accurate.'],
          ['The Ann. Yield on a new lot looks too high or too low — why?',
           'Ann. Yield uses max(days held, CC DTE) as the time base. On a new lot it uses CC DTE (e.g. 36 days) rather than 1 day held — avoiding inflated early numbers. Hover the tile to see which denominator was used.'],
        ])}
      </div>
    ),
  },

];

// ── Categories ────────────────────────────────────────────
const CATEGORIES = ['Getting Started', 'Strategies', 'Adjustments', 'Features', 'Greeks', 'Tips & Rules'];

// ── Component ─────────────────────────────────────────────
export default function HelpPanel({ onClose }) {
  const [search,  setSearch]  = useState('');
  const [current, setCurrent] = useState('overview');

  const filtered = useMemo(() => {
    if (!search.trim()) return ARTICLES;
    const q = search.toLowerCase();
    return ARTICLES.filter(a =>
      a.title.toLowerCase().includes(q) ||
      a.keywords.some(k => k.toLowerCase().includes(q)) ||
      a.cat.toLowerCase().includes(q)
    );
  }, [search]);

  const article = ARTICLES.find(a => a.id === current) || ARTICLES[0];

  return (
    <>
      {/* Backdrop — click anywhere outside panel to close */}
      <div className="panel-backdrop" onClick={onClose} />

      <div className="help-panel">
      <div className="help-header">
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>Help &amp; Guide</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 2 }}>MyOptionDiary &middot; {ARTICLES.length} articles</div>
        </div>
        <button className="modal-close" onClick={onClose}>&#x2715;</button>
      </div>

      {/* Search */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
        <input
          className="search-input"
          style={{ width: '100%', paddingLeft: 32 }}
          placeholder="Search articles..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="help-body">
        {/* Nav */}
        <div className="help-nav">
          {CATEGORIES.map(cat => {
            const articles = filtered.filter(a => a.cat === cat);
            if (!articles.length) return null;
            return (
              <div key={cat}>
                <div className="help-cat-label">{cat}</div>
                {articles.map(a => (
                  <div
                    key={a.id}
                    className={`help-nav-item ${current === a.id ? 'active' : ''}`}
                    onClick={() => setCurrent(a.id)}
                  >
                    {a.title.split(' — ')[0]}
                  </div>
                ))}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div style={{ padding: '20px 8px', fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
              No articles match your search.
            </div>
          )}
        </div>

        {/* Article */}
        <div className="help-article">
          <h4>{article.title}</h4>
          <div className="badge badge-blue" style={{ marginBottom: 12, fontSize: 10 }}>{article.cat}</div>
          {article.content}
        </div>
      </div>
    </div>
    </>
  );
}
