// src/components/TradeExplainModal.jsx
// Plain-English walkthrough of any trade — works in both Demo and Live modes
// All numbers verified against Black-Scholes (scipy, r=5.3%)
// P&L formula: credit = (entry-exit)×contracts×100, debit = (exit-entry)×contracts×100

import React, { useState, useEffect, useRef, useCallback } from 'react';

const G = { bg:'#edf7f2', color:'#1a7a4a', border:'#a8d5bc' };
const R = { bg:'#fdf0ee', color:'#c0392b', border:'#f0c4be' };
const B = { bg:'#eef4ff', color:'#1a5fa8', border:'#b5d0f7' };
const A = { bg:'#fffbe6', color:'#92600a', border:'#f0d898' };
function Step({ num, title, scheme, children }) {
  const s = scheme || B;
  return (
    <div style={{ display:'flex', gap:12, marginBottom:14 }}>
      <div style={{ width:26, height:26, borderRadius:'50%', flexShrink:0, marginTop:2,
        background:s.bg, border:`2px solid ${s.border}`,
        display:'flex', alignItems:'center', justifyContent:'center',
        fontSize:11, fontWeight:800, color:s.color }}>{num}</div>
      <div style={{ flex:1 }}>
        <div style={{ fontWeight:700, fontSize:13, color:'var(--text-primary)', marginBottom:3 }}>{title}</div>
        <div style={{ fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.65 }}>{children}</div>
      </div>
    </div>
  );
}

function Box({ scheme, icon, title, children }) {
  const s = scheme || B;
  return (
    <div style={{ background:s.bg, border:`1px solid ${s.border}`, borderRadius:8,
      padding:'10px 14px', marginTop:12, lineHeight:1.6 }}>
      {(icon || title) && <div style={{ fontWeight:700, fontSize:12.5, color:s.color, marginBottom:4 }}>{icon} {title}</div>}
      <div style={{ fontSize:12.5, color:'var(--text-primary)' }}>{children}</div>
    </div>
  );
}

function N({ c, children }) {
  return <strong style={{ fontFamily:'monospace', fontSize:13, color: c || 'inherit' }}>{children}</strong>;
}

// ─────────────────────────────────────────────────────────
// All explanations — numbers match trades.js exactly
// ─────────────────────────────────────────────────────────
// EXPLAIN hardcoded map removed — all trades now use buildFallback() for
// dynamic lifecycle rendering. This ensures:
//   • Wheel trades show full lot history from CSP → all CCs → outcome
//   • IC/IB chains show all legs including adjustments
//   • Calendar chains show all legs including rolls
//   • No stale hardcoded content that drifts from actual data


// ─────────────────────────────────────────────────────────
// Generic fallback explanation built from trade fields
function buildFallback(trade, allTrades) {
  if (!trade) return null;

  const isCredit = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'].includes(trade.strategy);
  const isIC     = trade.condor_chain_id != null;
  const isCal    = trade.cal_chain_id    != null;
  const isDiag   = isCal && trade.strategy === 'Diagonal Spread';
  const isWheel  = trade.lot_id != null;


  // ── WHEEL LIFECYCLE — show full lot history when lot_id present ──────────
  if (isWheel) {
    // All trades on this lot, sorted by entry_date ascending
    const lotTrades = (allTrades || [])
      .filter(t => t.lot_id === trade.lot_id)
      .sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || ''));

    const originCSP  = lotTrades.find(t => t.strategy === 'Cash-Secured Put');
    const allCCs     = lotTrades.filter(t => t.strategy === 'Covered Call');
    const openCC     = allCCs.find(t => t.status === 'open');

    // Running premium total from all closed trades on the lot
    // Closed trades premium (realised)
    const closedPremium = lotTrades
      .filter(t => t.status === 'closed')
      .reduce((s, t) => {
        if (t.strategy === 'Cash-Secured Put') {
          // assignment: entry_price × c × 100 (demo pnl=0 convention)
          return s + (parseFloat(t.entry_price) || 0) * (t.contracts || 1) * 100;
        }
        if (t.pnl != null && t.pnl !== 0) return s + t.pnl;
        // Called-away CC (pnl=0 demo): add entry premium
        if (t.strategy === 'Covered Call') {
          const sks = parseFloat(t.strike_sell) || 0;
          const exitP = parseFloat(t.exit_price) || 0;
          if (sks > 0 && Math.abs(exitP - sks) < 0.01) {
            return s + (parseFloat(t.entry_price) || 0) * (t.contracts || 1) * 100;
          }
        }
        return s + (t.pnl || 0);
      }, 0);

    // Open CC/CSP premium already collected — included in net cost basis from the moment sold
    const openPremium = lotTrades
      .filter(t => t.status === 'open' && (t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put'))
      .reduce((s, t) => s + (parseFloat(t.entry_price) || 0) * (t.contracts || 1) * 100, 0);

    const totalOptionPremium = closedPremium + openPremium;

    const wheelDone  = lotTrades.some(t => t.strategy === 'Covered Call' && t.status === 'closed' &&
      Math.abs((parseFloat(t.exit_price)||0) - (parseFloat(t.strike_sell)||0)) < 0.01);
    const statusTag  = wheelDone ? 'Wheel Complete' : openCC ? 'Wheel Active' : 'Wheel — Unhedged';
    const tagScheme  = wheelDone ? G : openCC ? B : A;
    const ticker     = trade.ticker;

    // Build one Step per trade in the lot lifecycle
    const steps = lotTrades.map((t, idx) => {
      const isOpen   = t.status === 'open';
      const pnl      = t.pnl;
      const isCCt    = t.strategy === 'Covered Call';
      const isCSPt   = t.strategy === 'Cash-Secured Put';
      const premium  = (parseFloat(t.entry_price) || 0) * (t.contracts || 1) * 100;
      const strike   = t.strike_sell || t.strike_buy;
      const dte      = t.expiration ? Math.max(0, Math.ceil((new Date(t.expiration) - new Date()) / 86400000)) : null;
      const isActive = t.id === trade.id; // highlight the trade the user clicked on
      const isCalled = isCCt && t.status === 'closed' && strike && Math.abs((parseFloat(t.exit_price)||0) - (parseFloat(strike)||0)) < 0.01;
      const isAssigned = isCSPt && t.status === 'closed';

      let stepTitle, scheme, body;
      if (isCSPt) {
        stepTitle = isAssigned ? `CSP $${strike} — Assigned` : `CSP $${strike}${isOpen ? ' — Open' : ' — Closed'}`;
        scheme    = isAssigned ? A : isOpen ? B : G;
        body      = <>
          <strong>{isAssigned ? 'Assigned' : isOpen ? 'Open' : 'Closed'}</strong> Cash-Secured Put at <N>${strike}</N>.
          Collected <N>+${premium.toFixed(0)}</N>{isAssigned ? ' — shares acquired at strike' : isOpen ? ` · ${dte != null ? dte + ' DTE' : t.expiration}` : ` · ${t.exit_date || ''}`}.
          {isAssigned && <> Lot created: <N>100sh @ ${strike}</N>.</>}
        </>;
      } else if (isCCt) {
        const ccNum = allCCs.filter(c => (c.entry_date || '') <= (t.entry_date || '')).length;
        const ccPnl = isCalled ? premium : (pnl != null ? pnl : null);
        stepTitle = isCalled ? `CC #${ccNum} $${strike} — Called Away` : isOpen ? `CC #${ccNum} $${strike} — Open` : `CC #${ccNum} $${strike} — ${pnl != null && pnl > 0 ? 'Profit' : pnl != null && pnl < 0 ? 'Loss' : 'Closed'}`;
        scheme    = isCalled ? G : isOpen ? B : pnl != null && pnl >= 0 ? G : pnl != null ? R : B;
        body      = <>
          <strong>CC #{ccNum}</strong> — sold <N>${strike}</N> call, collected <N>+${premium.toFixed(0)}</N>.
          {isOpen && <> Expires <N>{t.expiration}</N>{dte != null ? ` (${dte} DTE)` : ''}.</>}
          {!isOpen && ccPnl != null && <> Result: <N style={{ color: ccPnl >= 0 ? '#1a7a4a' : '#c0392b' }}>{ccPnl >= 0 ? '+' : ''}${ccPnl.toFixed(0)}</N>.</>}
          {isCalled && <> Shares called away at <N>${strike}</N>.</>}
        </>;
      } else {
        stepTitle = `${t.strategy}${isOpen ? ' — Open' : ''}`;
        scheme    = B;
        body      = <>{t.strategy} on {ticker}{strike ? ` @ $${strike}` : ''}. {isOpen ? `Open — ${dte != null ? dte + ' DTE' : ''}` : `Closed ${t.exit_date || ''}`}</>;
      }

      return (
        <Step key={t.id} num={idx + 1} title={stepTitle} scheme={scheme}
          style={isActive ? { border: '2px solid var(--blue)', borderRadius: 6 } : {}}>
          {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 4, display: 'block' }}>▶ This trade</span>}
          {body}
        </Step>
      );
    });

    // Summary step: totals
    if (lotTrades.length > 0) {
      steps.push(
        <Step key="summary" num={lotTrades.length + 1} title="Position Summary" scheme={totalOptionPremium >= 0 ? G : R}>
          Total option income collected: <N style={{ color: '#1a7a4a' }}>+${totalOptionPremium.toFixed(0)}</N> across {lotTrades.length} trade{lotTrades.length !== 1 ? 's' : ''}.
          {originCSP && <> Cost basis: <N>${originCSP.strike_buy}/share</N>. Net cost after premiums: <N>${((parseFloat(originCSP.strike_buy)||0) - totalOptionPremium / ((originCSP.contracts||1)*100)).toFixed(2)}/share</N>.</>}
          {wheelDone ? <> Wheel complete — position fully closed.</> : openCC ? <> Active CC — position hedged.</> : <> No active CC — consider writing a covered call.</>}
        </Step>
      );
    }

    return {
      title: `${ticker} Wheel — Full Lot Lifecycle`,
      tag: statusTag,
      tagScheme,
      summary: `Complete history of the ${ticker} position: ${lotTrades.length} trade${lotTrades.length !== 1 ? 's' : ''} from ${lotTrades[0]?.entry_date || 'inception'} · Total option income +$${totalOptionPremium.toFixed(0)}.`,
      steps,
      outcome: wheelDone
        ? { scheme: G, icon: '🏆', title: 'Wheel Complete', text: `Full cycle closed. Total option income: +$${totalOptionPremium.toFixed(0)}.` }
        : openCC
          ? { scheme: B, icon: '⏳', title: 'Wheel Active', text: `CC running — ${openCC.expiration ? Math.max(0, Math.ceil((new Date(openCC.expiration) - new Date()) / 86400000)) + ' DTE' : 'expiry pending'}. Total income so far: +$${totalOptionPremium.toFixed(0)}.` }
          : { scheme: A, icon: '⚠', title: 'Unhedged', text: `No active CC. Consider writing a covered call to collect income.` },
    };
  }

  // ── IC / IB CHAIN — show all legs including closed + adjustments ─────────
  if (isIC) {
    const chainLegs = (allTrades || [])
      .filter(t => t.condor_chain_id === trade.condor_chain_id)
      .sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || ''));

    const chainRealised = chainLegs.reduce((s, t) => s + (t.pnl || 0) + (t.partial_close_pnl || 0), 0);
    const openLegs   = chainLegs.filter(t => t.status === 'open');
    const chainDone  = chainLegs.length > 0 && chainLegs.every(t => t.status === 'closed');
    const statusTag  = chainDone ? 'Fully Closed' : openLegs.length > 0 ? 'Active' : 'Closed';
    const tagScheme  = chainDone ? G : B;

    const steps = chainLegs.map((t, idx) => {
      const leg  = t.condor_leg || 'leg';
      const ss   = t.strike_sell, sb = t.strike_buy;
      const prem = t.entry_price;
      const pcp  = t.partial_close_pnl || 0;
      const co   = t.contracts_open != null ? t.contracts_open : t.contracts;
      const isActive = t.id === trade.id;
      const scheme = t.status === 'closed' ? (((t.pnl||0)+pcp) >= 0 ? G : R) : B;
      return (
        <Step key={t.id} num={idx + 1} title={`${leg} leg — ${t.status === 'open' ? `${co} contracts open` : 'Closed'}`} scheme={scheme}
          style={isActive ? { border: '2px solid var(--blue)', borderRadius: 6 } : {}}>
          {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 4, display: 'block' }}>▶ This trade</span>}
          <strong>{leg}</strong> — sell <N>${ss}</N> / buy <N>${sb}</N> · entry <N>${prem?.toFixed(2)}</N> · {t.contracts} contract{t.contracts !== 1 ? 's' : ''}.
          {t.status === 'closed'
            ? <> Closed: <N style={{ color: ((t.pnl||0)+pcp) >= 0 ? '#1a7a4a' : '#c0392b' }}>{((t.pnl||0)+pcp) >= 0 ? '+' : ''}${((t.pnl||0)+pcp).toFixed(0)}</N>.</>
            : pcp !== 0
              ? <> Partial close locked: <N>{pcp >= 0 ? '+' : ''}${pcp.toFixed(0)}</N>. {co} contracts still open.</>
              : <> Expires <N>{t.expiration}</N>.</>
          }
        </Step>
      );
    });

    steps.push(
      <Step key="chain-total" num={chainLegs.length + 1} title="Chain P&L" scheme={chainRealised >= 0 ? G : R}>
        Total realised: <N style={{ color: chainRealised >= 0 ? '#1a7a4a' : '#c0392b' }}>{chainRealised >= 0 ? '+' : ''}${chainRealised.toFixed(0)}</N>.
        {openLegs.length > 0 ? <> {openLegs.length} leg{openLegs.length !== 1 ? 's' : ''} still open — unrealised not included.</> : <> All legs closed.</>}
      </Step>
    );

    return {
      title: `${trade.ticker} Iron Condor — Full Chain History`,
      tag: statusTag, tagScheme,
      summary: `Iron Condor on ${trade.ticker} — ${chainLegs.length} leg records. Profits when ${trade.ticker} stays between the short strikes.`,
      steps,
      outcome: chainDone
        ? { scheme: chainRealised >= 0 ? G : R, icon: chainRealised >= 0 ? '✓' : '✗', title: 'Chain Closed', text: `Total: ${chainRealised >= 0 ? '+' : ''}$${chainRealised.toFixed(0)}.` }
        : { scheme: B, icon: '⏳', title: 'Active', text: `${openLegs.length} leg${openLegs.length !== 1 ? 's' : ''} open. Realised so far: ${chainRealised >= 0 ? '+' : ''}$${chainRealised.toFixed(0)}.` },
    };
  }

  // ── CALENDAR / DIAGONAL CHAIN ────────────────────────────────────────────
  if (isCal) {
    const chainLegs = (allTrades || [])
      .filter(t => t.cal_chain_id === trade.cal_chain_id)
      .sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || ''));

    const chainRealised = chainLegs.reduce((s, t) => s + (t.pnl || 0) + (t.partial_close_pnl || 0), 0);
    const openLegs  = chainLegs.filter(t => t.status === 'open');
    const chainDone = chainLegs.length > 0 && chainLegs.every(t => t.status === 'closed');
    const statusTag = chainDone ? 'Fully Closed' : 'Active';
    const tagScheme = chainDone ? G : B;

    const steps = chainLegs.map((t, idx) => {
      const leg  = t.cal_leg || 'leg';
      const strike = t.strike_sell || t.strike_buy;
      const pcp  = t.partial_close_pnl || 0;
      const isActive = t.id === trade.id;
      const scheme = t.status === 'closed' ? (((t.pnl||0)+pcp) >= 0 ? G : R) : B;
      return (
        <Step key={t.id} num={idx + 1} title={`${leg} leg — $${strike} · ${t.status === 'open' ? 'Open' : 'Closed'}`} scheme={scheme}
          style={isActive ? { border: '2px solid var(--blue)', borderRadius: 6 } : {}}>
          {isActive && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', marginBottom: 4, display: 'block' }}>▶ This trade</span>}
          <strong>{leg}</strong> — strike <N>${strike}</N> · {leg === 'short' ? `collected $${((t.entry_price||0)*(t.contracts||1)*100).toFixed(0)}` : `paid $${((t.entry_price||0)*(t.contracts||1)*100).toFixed(0)}`}.
          Exp: <N>{t.expiration}</N>{t.expiration_back && t.expiration_back !== t.expiration ? <> / <N>{t.expiration_back}</N></> : null}.
          {t.status === 'closed'
            ? <> Closed: <N style={{ color: ((t.pnl||0)+pcp) >= 0 ? '#1a7a4a' : '#c0392b' }}>{((t.pnl||0)+pcp) >= 0 ? '+' : ''}${((t.pnl||0)+pcp).toFixed(0)}</N>.</>
            : pcp !== 0
              ? <> Partial: <N>{pcp >= 0 ? '+' : ''}${pcp.toFixed(0)}</N> locked.</>
              : null
          }
        </Step>
      );
    });

    steps.push(
      <Step key="cal-total" num={chainLegs.length + 1} title="Chain P&L" scheme={chainRealised >= 0 ? G : R}>
        Total realised: <N style={{ color: chainRealised >= 0 ? '#1a7a4a' : '#c0392b' }}>{chainRealised >= 0 ? '+' : ''}${chainRealised.toFixed(0)}</N>.
        {openLegs.length > 0 ? <> {openLegs.length} leg{openLegs.length !== 1 ? 's' : ''} still open.</> : <> All legs closed.</>}
      </Step>
    );

    return {
      title: `${trade.ticker} ${isDiag ? 'Diagonal' : 'Calendar'} — Full Chain History`,
      tag: statusTag, tagScheme,
      summary: isDiag
        ? `Diagonal Spread on ${trade.ticker} — short front-month leg at one strike + long back-month leg at a different strike. Adds directional bias to the calendar structure.`
        : `Calendar Spread on ${trade.ticker} — near-term short leg + far-term long leg. Profits from time-decay differential.`,
      steps,
      outcome: chainDone
        ? { scheme: chainRealised >= 0 ? G : R, icon: chainRealised >= 0 ? '✓' : '✗', title: 'Chain Closed', text: `Total: ${chainRealised >= 0 ? '+' : ''}$${chainRealised.toFixed(0)}.` }
        : { scheme: B, icon: '⏳', title: 'Active', text: `${openLegs.length} leg${openLegs.length !== 1 ? 's' : ''} open.` },
    };
  }

  // ── STANDALONE SINGLE TRADE (BPS, BCS, Long options etc.) ───────────────
  const strike  = trade.strike_sell || trade.strike_buy;
  const premium = trade.entry_price;
  const maxProfit = isCredit && premium ? `$${(premium * (trade.contracts || 1) * 100).toFixed(0)}` : null;
  const dte = trade.expiration ? Math.max(0, Math.ceil((new Date(trade.expiration) - new Date()) / 86400000)) : null;

  return {
    title: `${trade.ticker} ${trade.strategy}`,
    tag: trade.status === 'open' ? 'Open position' : 'Closed position',
    tagScheme: trade.status === 'closed' ? G : B,
    summary: `${trade.strategy} on ${trade.ticker}. ${isCredit ? 'A credit strategy — you collected premium upfront and profit when the option decays or expires worthless.' : 'A debit strategy — you paid premium upfront and profit when the option increases in value.'}`,
    steps: [
      <Step key={1} num={1} title="What was traded" scheme={B}>
        {trade.strategy} on <N>{trade.ticker}</N>
        {strike ? <>, strike <N>${strike}</N></> : null}
        {premium ? <>, {isCredit ? 'collected' : 'paid'} <N>${premium}/share</N> = <N>{maxProfit || `$${(premium*(trade.contracts||1)*100).toFixed(0)}`}</N></> : null}.
        {trade.entry_date ? <> Entered <N>{trade.entry_date}</N>.</> : null}
        {trade.expiration ? <> Expires <N>{trade.expiration}</N>{dte != null && trade.status === 'open' ? ` (${dte} DTE)` : ''}.</> : null}
      </Step>,
      <Step key={2} num={2} title="How it makes money" scheme={G}>
        {isCredit
          ? <>As a credit strategy, cash is received upfront. The option loses value via theta decay. <strong>Best outcome:</strong> expires worthless — keep 100% of <N>{maxProfit || 'premium'}</N>.</>
          : <>As a debit strategy, premium is paid upfront. You profit when {trade.ticker} moves in your favour and the option gains intrinsic value.</>
        }
      </Step>,
      trade.pnl != null && !isNaN(trade.pnl)
        ? <Step key={3} num={3} title="Result" scheme={trade.pnl >= 0 ? G : R}>
            This trade <N style={{ color: trade.pnl >= 0 ? '#1a7a4a' : '#c0392b' }}>{trade.pnl >= 0 ? 'made' : 'lost'} ${Math.abs(trade.pnl).toFixed(0)}</N>.
            {trade.exit_date ? <> Closed on <N>{trade.exit_date}</N>.</> : null}
          </Step>
        : <Step key={3} num={3} title="Managing this trade" scheme={B}>
            {isCredit
              ? <>Close at <N>50% of max profit</N> early. Roll if the underlying approaches the strike with 7+ DTE remaining.</>
              : <>Watch for your profit target. Debit trades have a defined max loss equal to the premium paid.</>
            }
          </Step>,
    ],
    outcome: trade.pnl != null && !isNaN(trade.pnl)
      ? { scheme: trade.pnl >= 0 ? G : R, icon: trade.pnl >= 0 ? '✓' : '✗', title: 'Final P&L', text: `${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)} on this trade.` }
      : maxProfit
        ? { scheme: B, icon: '⏳', title: 'Max profit', text: `${maxProfit} if the option expires worthless.` }
        : null,
  };
}

export default function TradeExplainModal({ trade, trades, onClose, isMock }) {
  // Always use dynamic buildFallback — full lifecycle for all trade types.
  const exp = buildFallback(trade, trades);

  // ── Drag state ──────────────────────────────────────────────────
  // Initialise to centre of screen; reset whenever a new trade opens.
  const [pos,     setPos]     = useState(null);  // null = use CSS centering on first open
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const modalRef   = useRef(null);

  // Centre the modal on first render (after mount, so we know the modal's size)
  useEffect(() => {
    setPos(null);   // reset to centred whenever trade changes
  }, [trade?.id]);

  const onMouseDownHeader = useCallback((e) => {
    if (e.button !== 0) return;  // left-click only
    e.preventDefault();
    const rect = modalRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Record where inside the modal header the user clicked
    dragOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // If we haven't set an explicit position yet, lock it to current screen position
    if (!pos) {
      setPos({ x: rect.left, y: rect.top });
    }
    setDragging(true);
  }, [pos]);

  useEffect(() => {
    if (!dragging) return;

    const onMove = (e) => {
      const newX = e.clientX - dragOffset.current.x;
      const newY = e.clientY - dragOffset.current.y;
      const rect = modalRef.current?.getBoundingClientRect();
      const w = rect?.width  || 720;
      // Clamp so at least 80px of the modal stays on screen on every edge
      const clampedX = Math.max(-w + 80, Math.min(window.innerWidth  - 80, newX));
      const clampedY = Math.max(0,        Math.min(window.innerHeight - 80, newY));
      setPos({ x: clampedX, y: clampedY });
    };

    const onUp = () => setDragging(false);

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
  }, [dragging]);

  if (!exp) return null;

  // When pos is set, render the modal at exact coordinates (breaks out of flex centering).
  // When pos is null, the backdrop's flex:center does the work on first open.
  const modalStyle = pos
    ? {
        position: 'fixed',
        top: pos.y,
        left: pos.x,
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
        // Override the backdrop's centering — the modal positions itself
        margin: 0,
      }
    : {
        maxHeight: '88vh',
        display: 'flex',
        flexDirection: 'column',
      };

  return (
    // Backdrop dims the screen but does NOT close on click when dragging
    <div
      className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}
    >
      <div className="modal modal-lg" ref={modalRef} style={modalStyle}>

        {/* ── Draggable header ── */}
        <div
          className="modal-header"
          onMouseDown={onMouseDownHeader}
          style={{
            cursor: dragging ? 'grabbing' : 'grab',
            userSelect: 'none',
            borderRadius: 'var(--radius-xl) var(--radius-xl) 0 0',
          }}
          title="Drag to move"
        >
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
              <span style={{ fontFamily:'var(--font-mono)', fontWeight:800, fontSize:15 }}>{trade.ticker}</span>
              {isMock ? <span className="badge badge-blue" style={{ fontSize:10 }}>Demo Mode</span> : <span className="badge badge-green" style={{ fontSize:10, background:'var(--green-bg)', color:'var(--green)', border:'1px solid var(--green-border)' }}>Live Mode</span>}
              <span style={{ fontSize:10, fontWeight:700, padding:'2px 8px', borderRadius:20,
                background:exp.tagScheme.bg, color:exp.tagScheme.color, border:`1px solid ${exp.tagScheme.border}` }}>
                {exp.tag}
              </span>
              <span style={{ fontSize:9, color:'var(--text-muted)', fontStyle:'italic', marginLeft:4 }}>
                drag to move
              </span>
            </div>
            <h3 style={{ marginTop:4, fontSize:14, fontWeight:700 }}>{exp.title}</h3>
          </div>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>

        <div style={{ overflowY:'auto', flex:1, padding:'16px 20px' }}>
          <div style={{ borderLeft:`3px solid ${exp.tagScheme.border}`, paddingLeft:12,
            marginBottom:18, fontSize:13, color:'var(--text-secondary)', lineHeight:1.65 }}>
            {exp.summary}
          </div>

          {exp.steps}

          {exp.outcome && (
            <Box scheme={exp.outcome.scheme} icon={exp.outcome.icon} title={exp.outcome.title}>
              {exp.outcome.text}
            </Box>
          )}

          <div style={{ marginTop:16, fontSize:11, color:'var(--text-muted)',
            borderTop:'1px solid var(--border)', paddingTop:10 }}>
            Educational purposes only. Figures reflect your actual trade data. Not financial advice.
          </div>
        </div>
      </div>
    </div>
  );
}
