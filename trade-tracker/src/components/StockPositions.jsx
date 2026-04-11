// src/components/StockPositions.jsx
import React, { useState, useMemo, useEffect, useRef, useCallback} from 'react';
const localDateISO = (d=new Date()) => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };

const fmt  = (n, d=2) => n == null ? '—' : '$' + Number(n).toFixed(d);
const pct  = (n)      => n == null ? '—' : Number(n).toFixed(1) + '%';

const CREDIT_STRATS = ['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly'];
const STRATEGY_COLORS = {
  'Covered Call': '#1a5fa8', 'Cash-Secured Put': '#1a7a4a', 'Bull Put Spread': '#1a7a4a',
  'Bear Call Spread': '#c0392b', 'Iron Condor': '#6d28d9', 'Long Call': '#1a7a4a', 'Long Put': '#c0392b',
};

// ── Premium calc ──────────────────────────────────────────
// For CSP assignments (exit_price = entry_price, strategy = Cash-Secured Put):
// The full premium WAS collected when the put was written. The matching
// exit_price is an accounting convention meaning "assigned at strike" —
// not a buy-back. avg_cost is set to the assignment price (strike), so
// we must include the full entry premium here to show cost basis reduction.
// Called-away CCs (exit=entry on a CC) are intentionally excluded —
// the share P&L on the lot already captures that gain.
function calcLotPremium(trades) {
  // Only count credit strategies — CCs, CSPs, and credit spreads written against the lot.
  // Debit strategies (Long Call, Bear Put Spread etc.) linked to a lot are hedges,
  // not wheel income, and must not inflate the premium / cost basis calculation.
  return trades.filter(t => CREDIT_STRATS.includes(t.strategy)).reduce((sum, t) => {
    const entry = t.entry_price || 0;
    const exit  = t.exit_price  || 0;
    const closed = t.status === 'closed';
    // CSP assignment detection covers two storage conventions:
    //   Demo: exit_price = entry_price (option premium as proxy, pnl=0)
    //   Live: exit_price = strike_buy  (stock acquisition price, pnl=full premium)
    // Both conventions mean the trader was assigned and received shares at the strike.
    const isCSPAssignment = closed &&
      t.strategy === 'Cash-Secured Put' &&
      (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
       (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
    // Called-away CC: exit_price = strike_sell (share sale price, not option buyback)
    // (entry - strike) would be hugely negative — must use full entry premium
    const isCCCalledAway = closed &&
      t.strategy === 'Covered Call' &&
      t.strike_sell != null &&
      Math.abs(parseFloat(t.exit_price) - parseFloat(t.strike_sell)) < 0.01;
    const effectiveExit = (isCSPAssignment || isCCCalledAway) ? 0 : exit;
    const premium = (entry - (closed ? effectiveExit : 0)) * t.contracts * 100;
    return sum + premium;
  }, 0);
}

// ── CloseTradeModal ──────────────────────────────────────
// Quick close: record an early close at a specific price (taking profit or cutting loss).
// Used when the trader buys back a CC/CSP/spread before expiry — no new position opened.
export function CloseTradeModal({
  trade,
  onSave,
  onClose,
  initialPrice = null,   // pre-fill buy-back price from broker/Yahoo live feed
}) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };
  const isDebit = ['Long Call','Long Put','Bull Call Spread','Bear Put Spread',
                   'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread'].includes(trade.strategy);
  const [closePrice, setClosePrice] = useState(initialPrice != null ? String(initialPrice) : '');
  const [closeDate,  setCloseDate]  = useState(localDateISO());
  const [contracts,  setContracts]  = useState(String(trade.contracts || 1));
  const [notes,      setNotes]      = useState('');

  const ep    = parseFloat(trade.entry_price) || 0;
  const xp    = parseFloat(closePrice);
  const nC    = Math.max(1, Math.min(parseInt(contracts) || (trade.contracts||1), trade.contracts||1));
  const pnl   = !isNaN(xp)
    ? isDebit ? (xp - ep) * nC * 100 : (ep - xp) * nC * 100
    : null;
  const isPartial = nC < (trade.contracts || 1);
  const canSave   = !isNaN(xp) && xp >= 0 && closeDate;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={{ ...modalStyle, maxWidth: 420 }}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <div>
            <h3>Close Position — {trade.ticker} {trade.strategy}</h3>
            <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
              Entered at ${ep} · {trade.contracts} contract{trade.contracts !== 1 ? 's' : ''} · {trade.expiration}
            </div>
          </div>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>

        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">
                {isDebit ? 'Sell Price' : 'Buy-Back Price'}
                {initialPrice != null && <span style={{ fontSize:10, color:'var(--green)', marginLeft:6, fontWeight:500 }}>● auto-filled from live price</span>}
              </label>
              <input type="number" step="0.01" value={closePrice}
                onChange={e => setClosePrice(e.target.value)}
                placeholder={isDebit ? 'e.g. 8.50' : 'e.g. 0.90'} autoFocus />
            </div>
            <div className="form-group">
              <label className="form-label">Close Date</label>
              <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} />
            </div>
          </div>

          {(trade.contracts || 1) > 1 && (
            <div className="form-group">
              <label className="form-label">
                Contracts to close
                <span style={{ color:'var(--text-muted)', fontSize:11, marginLeft:6 }}>
                  (1–{trade.contracts}, default = all)
                </span>
              </label>
              <input type="number" min="1" max={trade.contracts} step="1"
                value={contracts} onChange={e => setContracts(e.target.value)} />
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Notes</label>
            <input type="text" value={notes} onChange={e => setNotes(e.target.value)}
              placeholder={isDebit ? 'e.g. Taking profit at 80%' : 'e.g. Closed at 80% max profit'} />
          </div>

          {pnl !== null && (
            <div style={{
              padding: '10px 14px', borderRadius: 8,
              background: pnl >= 0 ? 'var(--color-background-success)' : 'var(--color-background-danger)',
              border: `1px solid ${pnl >= 0 ? 'var(--color-border-success)' : 'var(--color-border-danger)'}`,
            }}>
              <div style={{ fontSize: 13, fontWeight: 500,
                color: pnl >= 0 ? 'var(--color-text-success)' : 'var(--color-text-danger)' }}>
                {pnl >= 0 ? '✓ ' : '⚠ '}
                Realised P&L: <span style={{ fontFamily: 'monospace', fontSize: 15 }}>
                  {pnl >= 0 ? '+' : ''}${pnl.toLocaleString()}
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-secondary)', marginTop: 3 }}>
                {isDebit
                  ? `(${closePrice} − ${ep}) × ${nC} × 100`
                  : `(${ep} − ${closePrice}) × ${nC} × 100`}
                {isPartial && (
                  <span style={{ marginLeft: 8, color: 'var(--color-text-warning)', fontWeight: 500 }}>
                    · Partial close: {trade.contracts - nC} contract{trade.contracts - nC !== 1 ? 's' : ''} remain open
                  </span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!canSave}
            onClick={() => onSave({ trade, closePrice: xp, closeDate, contracts: nC, notes, pnl, isPartial })}>
            {isPartial ? `Close ${nC} Contract${nC !== 1 ? 's' : ''}` : 'Close Position'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── ExpiredWorthlessModal ─────────────────────────────────
// One-click close when an option expires at $0 — full premium kept.
export function ExpiredWorthlessModal({
  trade,
  onSave,
  onClose,
  currentPrices,
}) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };
  const isDebit = ['Long Call','Long Put','Bull Call Spread','Bear Put Spread',
                   'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread'].includes(trade.strategy);
  const isCC  = trade.strategy === 'Covered Call';
  const isCSP = trade.strategy === 'Cash-Secured Put';
  const [expDate, setExpDate] = useState(trade.expiration || localDateISO());
  const ep  = parseFloat(trade.entry_price) || 0;
  const pnl = isDebit
    ? -ep * (trade.contracts || 1) * 100
    : ep  * (trade.contracts || 1) * 100;

  // ── ITM warning ──────────────────────────────────────────────────────
  // Current stock price if available (from Yahoo / broker / manual entry)
  const stockPrice = parseFloat(currentPrices?.[trade.id]?.stock
    || currentPrices?.[trade.ticker?.toUpperCase()]?.stock);
  const callStrike = parseFloat(trade.strike_sell);
  const putStrike  = parseFloat(trade.strike_buy);
  const fmt = n => n == null || isNaN(n) ? '—' : '$' + Number(n).toFixed(2);

  // Determine warning level:
  //   'red'    — we have a stock price and it confirms ITM (wrong button!)
  //   'amber'  — no stock price but CC/CSP could be ITM (always warn)
  //   null     — not a CC or CSP, no relevant warning
  let itmWarning = null;
  if (isCC && callStrike > 0) {
    if (stockPrice > 0 && stockPrice > callStrike) {
      itmWarning = { level: 'red',
        msg: `Stock (${fmt(stockPrice)}) closed ABOVE your call strike (${fmt(callStrike)}). Your shares were likely called away. Use Called Away instead — not Expired.` };
    } else if (!stockPrice) {
      itmWarning = { level: 'amber',
        msg: `If the stock closed ABOVE your call strike (${fmt(callStrike)}), your shares were called away — use Called Away instead. Only confirm here if the stock closed BELOW ${fmt(callStrike)}.` };
    }
  } else if (isCSP && putStrike > 0) {
    if (stockPrice > 0 && stockPrice < putStrike) {
      itmWarning = { level: 'red',
        msg: `Stock (${fmt(stockPrice)}) closed BELOW your put strike (${fmt(putStrike)}). You were likely assigned shares. Use Assigned instead — not Expired.` };
    } else if (!stockPrice) {
      itmWarning = { level: 'amber',
        msg: `If the stock closed BELOW your put strike (${fmt(putStrike)}), you were assigned shares — use Assigned instead. Only confirm here if the stock closed ABOVE ${fmt(putStrike)}.` };
    }
  }

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={{ ...modalStyle, maxWidth: 420 }}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>Expired Worthless — {trade.ticker}</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* ITM warning — shown before the P&L confirmation */}
          {itmWarning && (
            <div className={`alert ${itmWarning.level === 'red' ? 'alert-red' : 'alert-amber'}`}
              style={{ fontWeight: itmWarning.level === 'red' ? 700 : 500 }}>
              {itmWarning.level === 'red' ? '⚠ Wrong button — ' : '⚠ Check before confirming — '}
              {itmWarning.msg}
            </div>
          )}

          {/* Standard P&L result */}
          <div className={`alert ${isDebit ? 'alert-amber' : 'alert-green'}`}>
            {isDebit
              ? `Option expired worthless — full premium lost. P&L: -$${Math.abs(pnl).toLocaleString()}`
              : `Option expired worthless — full premium kept. P&L: +$${pnl.toLocaleString()}`}
          </div>

          <div className="form-group">
            <label className="form-label">Expiry Date</label>
            <input type="date" value={expDate} onChange={e => setExpDate(e.target.value)} />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className={`btn ${itmWarning?.level === 'red' ? 'btn-danger' : isDebit ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => onSave({ trade, closePrice: 0, closeDate: expDate,
              contracts: trade.contracts || 1, notes: 'Expired worthless', pnl, isPartial: false })}>
            {itmWarning?.level === 'red' ? "Confirm Anyway (I know what I'm doing)" : 'Confirm Expiry'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── LotForm ───────────────────────────────────────────────
// Validation rules:
//   L1. Ticker is required (letters only)
//   L2. Shares must be a positive multiple of 100 (standard option lot size)
//   L3. Purchase price must be > 0
//   L4. Purchase date is required and must not be in the future
//   L5. Warn if shares are not a multiple of 100 (partial lots can't be covered)
export function LotForm({ initial, defaultTicker, onSave, onClose }) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };

  const [form, setForm] = useState({
    ticker: defaultTicker || '', shares: '', avg_cost: '', purchase_date: localDateISO(), notes: '',
    ...(initial ? { ...initial, shares: String(initial.shares), avg_cost: String(initial.avg_cost) } : {}),
  });
  const [submitted, setSubmitted] = useState(false);
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const today = localDateISO();
  const sharesNum = parseInt(form.shares);
  const priceNum  = parseFloat(form.avg_cost);

  const errors = {};
  const warnings = {};
  if (!form.ticker.trim())                          errors.ticker        = 'Ticker is required.';
  if (!form.shares || isNaN(sharesNum) || sharesNum < 1)
                                                    errors.shares        = 'Shares must be at least 1.';
  else if (sharesNum % 100 !== 0)                   warnings.shares      = `${sharesNum} shares is not a multiple of 100. You can only sell covered calls against complete 100-share lots.`;
  if (!form.avg_cost || isNaN(priceNum) || priceNum <= 0)
                                                    errors.avg_cost      = 'Purchase price must be greater than $0.';
  if (!form.purchase_date)                          errors.purchase_date = 'Purchase date is required.';
  else if (form.purchase_date > today)              errors.purchase_date = 'Purchase date cannot be in the future.';

  const hasErrors = Object.keys(errors).length > 0;

  function submit(e) {
    e.preventDefault();
    setSubmitted(true);
    if (hasErrors) return;
    onSave({ ...form, id: initial?.id, ticker: form.ticker.toUpperCase(), shares: sharesNum, avg_cost: priceNum });
  }

  const E = ({ f }) => submitted && errors[f]   ? <div style={{ color:'var(--red,#c0392b)', fontSize:11, marginTop:3, fontWeight:500 }}>⛔ {errors[f]}</div>   : null;
  const W = ({ f }) => submitted && warnings[f] ? <div style={{ color:'var(--amber,#b7730a)', fontSize:11, marginTop:3 }}>⚠ {warnings[f]}</div> : null;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={modalStyle}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>{initial ? 'Edit Stock Lot' : 'Add Stock Lot'}</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <form onSubmit={submit} noValidate>
          <div className="modal-body">
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">Ticker *</label>
              <input value={form.ticker} onChange={e => set('ticker', e.target.value.toUpperCase())}
                style={{ borderColor: submitted && errors.ticker ? 'var(--red,#c0392b)' : '' }} />
              <E f="ticker" />
            </div>
            <div className="form-group">
              <label className="form-label">Shares *
                <span style={{ fontSize:10, color:'var(--text-muted)', marginLeft:4 }}>multiples of 100 for covered calls</span>
              </label>
              <input type="number" min="1" step="1" value={form.shares} onChange={e => set('shares', e.target.value)}
                style={{ borderColor: submitted && (errors.shares || warnings.shares) ? (errors.shares ? 'var(--red,#c0392b)' : 'var(--amber,#b7730a)') : '' }} />
              <E f="shares" /><W f="shares" />
            </div>
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label className="form-label">Purchase Price / Share *</label>
              <input type="number" step="0.01" min="0.01" value={form.avg_cost} onChange={e => set('avg_cost', e.target.value)}
                style={{ borderColor: submitted && errors.avg_cost ? 'var(--red,#c0392b)' : '' }} />
              <E f="avg_cost" />
            </div>
            <div className="form-group">
              <label className="form-label">Purchase Date *</label>
              <input type="date" value={form.purchase_date || ''} onChange={e => set('purchase_date', e.target.value)} max={today}
                style={{ borderColor: submitted && errors.purchase_date ? 'var(--red,#c0392b)' : '' }} />
              <E f="purchase_date" />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Notes</label>
            <input type="text" value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Optional..." />
          </div>
          </div>{/* end modal-body */}
          <div className="modal-footer">
            <button type="button" className="btn btn-outline" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{initial ? 'Save Changes' : 'Add Lot'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── CloseLotModal ─────────────────────────────────────────
export function CloseLotModal({
  lot,
  trades,
  onSave,
  onClose,
}) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };
  const [closeDate,  setCloseDate]  = useState(lot.close_date || localDateISO());
  const [closePrice, setClosePrice] = useState(lot.close_price ? String(lot.close_price) : '');

  const preview = closePrice ? (parseFloat(closePrice) - lot.avg_cost) * lot.shares : null;
  // Net cost warning — calcLotPremium handles credit strategy filtering internally
  const lotTrades       = (trades || []).filter(t => t.lot_id === lot.id);
  const lotPremium      = calcLotPremium(lotTrades);
  const netCostPerShare = lot.avg_cost - (lotPremium / (lot.shares || 1));
  const closePriceNum   = parseFloat(closePrice) || 0;
  const belowNetCost    = closePrice && closePriceNum < netCostPerShare;
  const belowAvgCost    = closePrice && closePriceNum < lot.avg_cost && !belowNetCost;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={modalStyle}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>Sell {lot.ticker} Shares — Close Lot</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div className="alert" style={{ background:'var(--amber-bg)', border:'1px solid var(--amber-border)', color:'var(--amber)', marginBottom:12, fontSize:13 }}>
          ⚠ This records the <strong>sale of your {lot.shares} shares</strong> and closes the lot permanently. To close an open Covered Call or CSP early, use the <strong>Close</strong> button on that trade in the Trade Log instead.
        </div>
        <div className="form-group">
          <label className="form-label">Date Shares Sold</label>
          <input type="date" value={closeDate} onChange={e => setCloseDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Sale Price/Share</label>
          <input type="number" step="0.01" value={closePrice} onChange={e => setClosePrice(e.target.value)} autoFocus />
        </div>
        {preview != null && (
          <div className={`alert ${preview >= 0 ? 'alert-green' : 'alert-red'}`}>
            Share P&L: {preview >= 0 ? '+' : ''}{fmt(preview)} ({lot.shares} shares)
          </div>
        )}
        {belowNetCost && (
          <div className="alert alert-amber">
            ⚠ Sale price ${closePriceNum.toFixed(2)} is below your net cost basis of ${netCostPerShare.toFixed(2)}/sh (purchase ${lot.avg_cost} minus ${(lotPremium/(lot.shares||1)).toFixed(2)}/sh premium). Selling here will realise a net loss on this wheel position.
          </div>
        )}
        {belowAvgCost && (
          <div className="alert" style={{ background:'var(--blue-bg,#eef4ff)', border:'1px solid var(--blue-border,#b5d0f7)', color:'var(--blue,#1a5fa8)' }}>
            ℹ Sale price ${closePriceNum.toFixed(2)} is below purchase price ${lot.avg_cost} but above your net cost of ${netCostPerShare.toFixed(2)}/sh after premiums. Still profitable overall. ✓
          </div>
        )}
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave({ lot, closeDate, closePrice })} disabled={!closePrice}>Confirm — Sell Shares</button>
        </div>
      </div>
    </div>
  );
}


// ── StockSplitModal ───────────────────────────────────────
export function StockSplitModal({ lot, trades, onSave, onClose }) {
  const [pos,      setPos]      = useState(null);
  const [dragging, setDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const modalRef   = useRef(null);
  const [ratio,    setRatio]    = useState('2');
  const [reverse,  setReverse]  = useState(false);
  const [splitDate, setSplitDate] = useState(localDateISO());

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
      const w = rect?.width || 460;
      setPos({ x: Math.max(-w+80, Math.min(window.innerWidth-80, newX)), y: Math.max(0, Math.min(window.innerHeight-80, newY)) });
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [dragging]);

  const modalStyle = pos
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };

  const n = parseFloat(ratio) || 0;
  const valid = n > 0 && n !== 1;

  // Preview calculations
  const newShares  = valid ? (reverse ? Math.round(lot.shares / n) : Math.round(lot.shares * n)) : null;
  const newAvgCost = valid ? (reverse ? lot.avg_cost * n : lot.avg_cost / n) : null;

  // Open trades that will be adjusted
  const openTrades   = (trades || []).filter(t => t.lot_id === lot.id && t.status === 'open');
  // Closed trades — preserved as-is for historical accuracy (cash already settled)
  const closedTrades = (trades || []).filter(t => t.lot_id === lot.id && t.status === 'closed');
  // Reverse split edge case: fractional contracts possible
  const hasFractionalContracts = reverse && n > 0 && openTrades.some(t => ((t.contracts || 1) % n) !== 0);

  const confirm = () => {
    if (!valid) return;
    onSave({ lot, trades: openTrades, ratio: n, reverse, splitDate });
  };

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={{ ...modalStyle, maxWidth: 460 }}>
        <div className="modal-header" onMouseDown={onMouseDownHeader} title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>Record Stock Split — {lot.ticker}</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div className="alert alert-amber" style={{ fontSize: 12 }}>
            This will adjust your lot shares, avg cost, and all open option strikes to reflect the split.
            Closed trade history is preserved as-is (historical prices remain factual).
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end' }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">Split Ratio</label>
              <input type="number" step="0.5" min="0.1" value={ratio}
                onChange={e => setRatio(e.target.value)}
                placeholder="e.g. 2 for 2:1" />
            </div>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">Split Date</label>
              <input type="date" value={splitDate} onChange={e => setSplitDate(e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={reverse} onChange={e => setReverse(e.target.checked)} />
              Reverse split (consolidation)
            </label>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
              {reverse ? `1:${n} — fewer shares, higher price` : `${n}:1 — more shares, lower price`}
            </span>
          </div>
          {valid && newShares !== null && (
            <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10, color: 'var(--text-primary)' }}>Preview — What Will Change</div>

              {/* Lot-level changes */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, fontSize: 12 }}>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Shares</div>
                  <div>{lot.shares} → <strong>{newShares}</strong></div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Avg Cost/sh</div>
                  <div>${lot.avg_cost?.toFixed(2)} → <strong>${newAvgCost?.toFixed(2)}</strong></div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>Net Cost/sh</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>recalculated ✓</div>
                </div>
              </div>

              {/* Open trades — will be adjusted */}
              {openTrades.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--blue)', marginBottom: 6 }}>
                    ✎ {openTrades.length} open trade{openTrades.length > 1 ? 's' : ''} — strike, premium and contracts adjusted:
                  </div>
                  {openTrades.map(t => {
                    const oldStrike    = t.strike_sell || t.strike_buy || 0;
                    const newStrike    = reverse ? oldStrike * n : oldStrike / n;
                    const oldPrem      = t.entry_price || 0;
                    const newPrem      = reverse ? oldPrem * n : oldPrem / n;
                    const oldContracts = t.contracts || 1;
                    const newContracts = reverse ? Math.round(oldContracts / n) : Math.round(oldContracts * n);
                    return (
                      <div key={t.id} style={{ fontSize: 11, marginBottom: 4, padding: '4px 6px', background: 'var(--accent-light)', borderRadius: 4 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                          <span style={{ color: 'var(--text-secondary)' }}>{t.strategy}</span>
                          <span style={{ color: 'var(--text-muted)', fontSize: 10 }}>lot-linked</span>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginTop: 3 }}>
                          <span>Strike: ${oldStrike} → <strong>${newStrike.toFixed(2)}</strong></span>
                          <span>Premium: ${oldPrem} → <strong>${newPrem.toFixed(2)}</strong></span>
                          <span>Contracts: {oldContracts} → <strong>{newContracts}</strong></span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Reverse split fractional contracts warning */}
              {hasFractionalContracts && (
                <div className="alert alert-amber" style={{ fontSize: 11, marginTop: 8 }}>
                  ⚠ Reverse split may result in fractional contracts — rounded here. Verify with your broker that contract count matches your account.
                </div>
              )}

              {/* Closed trades — preserved as-is */}
              {closedTrades.length > 0 && (
                <div style={{ marginTop: 10, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', marginBottom: 6 }}>
                    ✓ {closedTrades.length} closed trade{closedTrades.length > 1 ? 's' : ''} — preserved as-is (cash already settled):
                  </div>
                  {closedTrades.map(t => {
                    const strike = t.strike_sell || t.strike_buy;
                    const label  = t.strategy === 'Cash-Secured Put' ? 'CSP' :
                                   t.strategy === 'Covered Call'      ? 'CC'  : t.strategy;
                    return (
                      <div key={t.id} style={{ fontSize: 11, display: 'flex', justifyContent: 'space-between', marginBottom: 2, color: 'var(--text-muted)' }}>
                        <span>{label}{strike ? ` $${strike}` : ''} {t.expiration ? `· exp ${t.expiration}` : ''}</span>
                        <span style={{ fontStyle: 'italic' }}>historical amounts unchanged ✓</span>
                      </div>
                    );
                  })}
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 4, fontStyle: 'italic' }}>
                    Old strikes will look higher than current — this is correct. Cash received does not change with a split.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={confirm} disabled={!valid}>
            Apply {reverse ? 'Reverse ' : ''}Split
          </button>
        </div>
      </div>
    </div>
  );
}

// ── AssignmentModal ───────────────────────────────────────
export function AssignmentModal({
  trade,
  onSave,
  onClose,
}) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };
  const todayStr2  = localDateISO();
  const expiryStr2 = trade.expiration || todayStr2;
  const defaultAssignDate = todayStr2 >= expiryStr2 ? expiryStr2 : todayStr2;
  const [assignDate, setAssignDate] = useState(defaultAssignDate);
  const [notes, setNotes]           = useState(`Assigned from CSP ${trade.expiration}`);
  const shares = (trade.contracts || 1) * 100;
  const cost   = trade.strike_buy || 0;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={modalStyle}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>CSP Assignment — {trade.ticker}</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        <div className="alert alert-amber">
          You are being assigned <strong>{shares} shares of {trade.ticker}</strong> at <strong>${cost}/share</strong> (total ${(shares * cost).toLocaleString()}).
        </div>
        <div className="form-group">
          <label className="form-label">Assignment Date</label>
          <input type="date" value={assignDate} onChange={e => setAssignDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Notes for new lot</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => onSave({ trade, assignDate, notes })}>Confirm Assignment</button>
        </div>
      </div>
    </div>
  );
}

// ── CalledAwayModal ───────────────────────────────────────
export function CalledAwayModal({
  trade,
  lots,
  trades,
  onSave,
  onClose,
}) {
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
      const w = rect?.width || 520;
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
    ? { position: 'fixed', top: pos.y, left: pos.x, margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }
    : { maxHeight: '88vh', display: 'flex', flexDirection: 'column' };
  const todayStr  = localDateISO();
  const expiryStr = trade.expiration || todayStr;
  // Smart default: if recording after expiry date → use expiry (economic event happened then, not today)
  //                if recording before expiry date → use today (genuine early assignment)
  const defaultSaleDate = todayStr >= expiryStr ? expiryStr : todayStr;
  const [saleDate, setSaleDate] = useState(defaultSaleDate);
  const [notes, setNotes]       = useState(`Called away at ${trade.strike_sell}`);
  const lot   = lots.find(l => l.id === trade.lot_id);
  const cost  = lot?.avg_cost || 0;
  const sale  = trade.strike_sell || 0;
  const prem  = (trade.entry_price || 0) * trade.contracts * 100;
  const sharePnl = (sale - cost) * (trade.contracts || 1) * 100;
  const total    = sharePnl + prem;
  const noLot = !trade.lot_id || !lot;
  // Net cost/share after all premium collected on this lot
  const lotTrades       = lot ? (trades || []).filter(t => t.lot_id === lot.id) : [];
  const lotPremium      = calcLotPremium(lotTrades);
  const netCostPerShare = lot ? lot.avg_cost - (lotPremium / (lot.shares || 1)) : 0;
  const belowNetCost    = lot && sale < netCostPerShare;
  const belowAvgCost    = lot && sale < lot.avg_cost && !belowNetCost;

  return (
    <div className="modal-backdrop"
      onClick={e => !dragging && e.target === e.currentTarget && onClose()}
      style={{ alignItems: pos ? 'flex-start' : 'center', justifyContent: pos ? 'flex-start' : 'center' }}>
      <div className="modal" ref={modalRef} style={modalStyle}>
        <div className="modal-header"
          onMouseDown={onMouseDownHeader}
          title="Drag to move"
          style={{ cursor: dragging ? 'grabbing' : 'grab', userSelect: 'none' }}>
          <h3>Called Away — {trade.ticker}</h3>
          <button className="modal-close" onMouseDown={e => e.stopPropagation()} onClick={onClose}>✕</button>
        </div>
        {noLot ? (
          <div style={{ background:'rgba(192,57,43,0.08)', border:'1px solid rgba(192,57,43,0.3)',
            borderRadius:8, padding:'14px 16px', marginBottom:12 }}>
            <div style={{ fontWeight:700, color:'var(--red,#c0392b)', marginBottom:6 }}>
              ⛔ No Stock Lot Linked
            </div>
            <div style={{ fontSize:13, color:'var(--text-primary)', lineHeight:1.6 }}>
              This Covered Call is not linked to a stock lot. Called Away requires a lot
              to calculate your share P&amp;L and close the position correctly.
            </div>
            <div style={{ fontSize:12, color:'var(--text-secondary)', marginTop:8 }}>
              Go to <strong>Trade Log → Edit</strong> this CC and link it to the correct stock lot,
              then return here to record the called away event.
            </div>
          </div>
        ) : (
          <>
          <div className={`alert ${total >= 0 ? 'alert-green' : 'alert-red'}`}>
            <div style={{ lineHeight: 1.7 }}>
              <div>Shares sold at: <strong>${sale}/share</strong></div>
              <div>Cost basis: <strong>${cost}/share</strong> ({lot.shares} shares @ ${cost})</div>
              <div>Net cost/share: <strong>${netCostPerShare.toFixed(2)}/sh</strong> (after ${(lotPremium/(lot.shares||1)).toFixed(2)}/sh premium)</div>
              <div>Share P&L: <strong className={sharePnl >= 0 ? 'text-green' : 'text-red'}>{sharePnl >= 0 ? '+' : ''}{fmt(sharePnl)}</strong></div>
              <div>CC premium collected: <strong className="text-green">+{fmt(prem)}</strong></div>
              <div style={{ borderTop: `1px solid ${total >= 0 ? 'var(--green-border)' : 'var(--red-border,rgba(192,57,43,0.3))'}`, marginTop: 6, paddingTop: 6, fontWeight:700 }}>
                Total wheel return: <strong className={total >= 0 ? 'text-green' : 'text-red'}>{total >= 0 ? '+' : ''}{fmt(total)}</strong>
              </div>
            </div>
          </div>
          {belowNetCost && (
            <div className="alert alert-amber" style={{ marginTop: 8 }}>
              ⚠ Strike ${sale} is below your net cost basis of ${netCostPerShare.toFixed(2)}/sh. This wheel cycle will close at a net loss. You can still save — this is a record of what happened.
            </div>
          )}
          {belowAvgCost && (
            <div className="alert" style={{ marginTop: 8, background:'var(--blue-bg,#eef4ff)', border:'1px solid var(--blue-border,#b5d0f7)', color:'var(--blue,#1a5fa8)' }}>
              ℹ Strike ${sale} is below purchase price ${cost} but above net cost ${netCostPerShare.toFixed(2)}/sh — the wheel premium made this profitable overall. ✓
            </div>
          )}
          </>
        )}
        <div className="form-group">
          <label className="form-label">Sale Date
            {trade.expiration && todayStr < expiryStr && (
              <span style={{ fontWeight:400, color:'var(--text-muted)', fontSize:10, marginLeft:6 }}>
                early assignment — expiry is {trade.expiration}
              </span>
            )}
            {trade.expiration && todayStr >= expiryStr && todayStr !== expiryStr && (
              <span style={{ fontWeight:400, color:'var(--text-muted)', fontSize:10, marginLeft:6 }}>
                defaulted to expiry date — adjust if needed
              </span>
            )}
          </label>
          <input type="date" value={saleDate} onChange={e => setSaleDate(e.target.value)} />
        </div>
        <div className="form-group">
          <label className="form-label">Notes</label>
          <input type="text" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
        <div className="modal-footer">
          <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          <button className="btn btn-green" onClick={() => onSave({ trade, saleDate, notes })}
            disabled={noLot}
            style={{ opacity: noLot ? 0.4 : 1, cursor: noLot ? 'not-allowed' : 'pointer' }}>
            Confirm Called Away
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main StockPositions ───────────────────────────────────
export default function StockPositions({ lots, trades, isMock, pill, onAddTrade, onWriteCC, onAddLot, onEditLot, onCloseLot, onReopenLot, onDeleteLot, onSplitLot, onAssignment, onCalledAway, onCloseTrade, initialFilter, filterUnhedged, onFilterConsumed, onViewTrades, onViewAlerts, currentPrices }) {
  const [tab,         setTab]         = useState('positions');
  const [expanded,    setExpanded]    = useState({});
  const toggleExpanded = (k) => setExpanded(e => ({ ...e, [k]: !e[k] }));

  // Consume the initialFilter prop once on mount (or when it changes from parent nav)
  useEffect(() => {
    if (initialFilter) {
      if (onFilterConsumed) onFilterConsumed();
    }
  }, [initialFilter]);

  // ── Unhedged sequencing state ─────────────────────────────────────────
  // When navigated from the "Unhedged Shares" Dashboard tile (filterUnhedged=true),
  // show a top-of-page banner listing every unhedged lot with a Write CC button.
  // Trader works through the queue one at a time; can exit and return later.
  // The queue is derived live from uncoveredLots — it shrinks automatically as
  // the trader writes CCs (because uncoveredLots re-evaluates from trades state).
  const [unhedgedMode, setUnhedgedMode] = useState(false);

  useEffect(() => {
    if (filterUnhedged) {
      setUnhedgedMode(true);
      if (onFilterConsumed) onFilterConsumed();
    }
  }, [filterUnhedged]); // eslint-disable-line react-hooks/exhaustive-deps

  // Group lots by ticker
  const byTicker = useMemo(() => {
    const map = {};
    lots.forEach(lot => {
      if (!map[lot.ticker]) map[lot.ticker] = [];
      map[lot.ticker].push(lot);
    });
    return map;
  }, [lots]);

  // Stock Positions always shows only tickers with at least one open lot.
  // Closed lots (called-away, sold) only appear in the summary section at the bottom.
  const filteredByTicker = useMemo(() => {
    const filtered = {};
    Object.entries(byTicker).forEach(([ticker, tickerLots]) => {
      const hasOpenLot = tickerLots.some(l => !l.close_date);
      if (hasOpenLot) filtered[ticker] = tickerLots;
    });
    return filtered;
  }, [byTicker]);

  // FIX #18: Detect both fully uncovered lots AND partially covered lots
  const uncoveredLots = useMemo(() => {
    return lots.filter(lot => {
      if (lot.close_date) return false;
      const openCCs = trades.filter(t => t.lot_id === lot.id && t.status === 'open' && t.strategy === 'Covered Call');
      if (openCCs.length === 0) return true; // fully uncovered
      const coveredShares = openCCs.reduce((s, t) => s + (t.contracts || 1) * 100, 0);
      return coveredShares < (lot.shares || 0); // partially uncovered
    });
  }, [lots, trades]);

  // Export CSV
  function exportCSV() {
    const headers = ['Ticker','Shares','Purchase Price/Share','Purchase Date','Total Premium','Net Cost/Share','Cost Reduction %','Status','Close Date','Sale Price/Share','Share P&L','Total Return','ROI %','Days Held','Notes'];
    const rows = lots.map(lot => {
      const lotTrades = trades.filter(t => t.lot_id === lot.id);
      const premium   = calcLotPremium(lotTrades);
      const net       = lot.avg_cost - (premium / lot.shares);
      const reduction = lot.avg_cost ? (1 - net / lot.avg_cost) * 100 : 0;
      const status    = lot.close_date ? 'Closed' : 'Open';
      const sharePnl  = lot.close_date ? (lot.close_price - lot.avg_cost) * lot.shares : null;
      const total     = sharePnl != null ? sharePnl + premium : null;
      const roi       = total != null && lot.avg_cost ? total / (lot.avg_cost * lot.shares) * 100 : null;
      const days      = lot.close_date ? Math.round((new Date(lot.close_date) - new Date(lot.purchase_date)) / 86400000) : null;
      return [lot.ticker, lot.shares, lot.avg_cost, lot.purchase_date || '', premium.toFixed(2), net.toFixed(2), reduction.toFixed(1), status, lot.close_date || '', lot.close_price || '', sharePnl?.toFixed(2) || '', total?.toFixed(2) || '', roi?.toFixed(1) || '', days || '', lot.notes || ''];
    });
    const csv = [headers, ...rows].map(r => r.map(v => `"${v}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `stock-positions-${localDateISO()}.csv`; a.click();
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <h2>Stock Positions</h2>
          {pill}
          <div className="subtitle">Per-lot cost basis · premium tracking · coverage alerts</div>
        </div>
        <button className="btn btn-primary btn-sm" onClick={onAddTrade}>+ Log Trade</button>
      </div>

      {/* ── Unhedged sequencing banner ────────────────────────────────────────
          Shown when navigated from "Unhedged Shares" Dashboard tile.
          Lists every unhedged lot with a Write CC button — one at a time.
          Banner auto-shrinks as trader writes CCs (live from uncoveredLots).
          Trader can dismiss and return later — state persists until page reload.
      ── */}
      {unhedgedMode && uncoveredLots.length > 0 && (
        <div style={{
          margin: '0 0 16px 0',
          background: 'var(--amber-bg)',
          border: '2px solid var(--amber-border)',
          borderRadius: 10,
          padding: '14px 16px',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--amber)' }}>
                ⚠ {uncoveredLots.length} lot{uncoveredLots.length > 1 ? 's' : ''} need{uncoveredLots.length === 1 ? 's' : ''} a Covered Call — capital not working
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3 }}>
                Write a CC on each lot below. You can do them one at a time and come back later — this list updates as you go.
              </div>
            </div>
            <button
              onClick={() => setUnhedgedMode(false)}
              style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '2px 6px' }}
              title="Dismiss — you can re-open this from the Dashboard Unhedged tile"
            >✕ Dismiss</button>
          </div>

          {/* One row per unhedged lot */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {uncoveredLots.map((lot, idx) => {
              const lotTrades   = trades.filter(t => t.lot_id === lot.id);
              const premium     = calcLotPremium(lotTrades);
              const netCost     = lot.avg_cost - (premium / (lot.shares || 1));
              const openCCs     = lotTrades.filter(t => t.status === 'open' && t.strategy === 'Covered Call');
              const coveredSh   = openCCs.reduce((s, t) => s + (t.contracts || 1) * 100, 0);
              const unhedgedSh  = (lot.shares || 0) - coveredSh;
              const isPartial   = coveredSh > 0; // some shares covered, some not
              return (
                <div key={lot.id} style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  background: 'var(--bg-primary)', borderRadius: 8,
                  padding: '10px 14px', gap: 12,
                  border: idx === 0 ? '1px solid var(--amber-border)' : '1px solid var(--border)',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                    {/* Priority indicator */}
                    {idx === 0 && (
                      <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--amber)',
                        background: 'var(--amber-bg)', border: '1px solid var(--amber-border)',
                        borderRadius: 10, padding: '1px 7px' }}>
                        Next up
                      </span>
                    )}
                    {/* Lot identity */}
                    <div>
                      <span style={{ fontWeight: 700, fontSize: 13 }}>{lot.ticker}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
                        Lot #{lot.id} · {lot.shares} shares @ ${lot.avg_cost?.toFixed(2)}
                      </span>
                    </div>
                    {/* Unhedged share count */}
                    <div style={{ fontSize: 11 }}>
                      {isPartial
                        ? <span style={{ color: 'var(--amber)' }}>⚠ {unhedgedSh} of {lot.shares} shares unhedged</span>
                        : <span style={{ color: 'var(--amber)' }}>⚠ {lot.shares} shares unhedged</span>
                      }
                    </div>
                    {/* Net cost context */}
                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      Net cost/sh: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>${netCost.toFixed(2)}</span>
                      {premium > 0 && <span style={{ color: 'var(--green)', marginLeft: 6 }}>+${Math.round(premium)} premium so far</span>}
                    </div>
                  </div>
                  {/* Write CC button */}
                  {onWriteCC && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => onWriteCC(lot)}
                      style={{ whiteSpace: 'nowrap', flexShrink: 0 }}
                      title={`Open TradeForm pre-filled for ${lot.ticker} Lot #${lot.id} (${lot.shares} shares @ $${lot.avg_cost})`}
                    >
                      + Write CC{isPartial ? ` (${unhedgedSh} sh)` : ''}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Progress indicator */}
          <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-muted)', textAlign: 'right' }}>
            {uncoveredLots.length} remaining · written CCs will disappear from this list automatically
          </div>
        </div>
      )}

      {/* Banner collapses to a soft reminder once all done */}
      {unhedgedMode && uncoveredLots.length === 0 && (
        <div style={{
          margin: '0 0 16px 0', padding: '10px 16px',
          background: 'var(--green-bg)', border: '1px solid var(--green-border)',
          borderRadius: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--green)' }}>
            ✓ All lots are covered — great work.
          </span>
          <button
            onClick={() => setUnhedgedMode(false)}
            style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer' }}
          >✕</button>
        </div>
      )}

      {/* ── Alert banner for lot-linked open CCs/CSPs ────────────────────────
          Shows when open trades attached to lots have DTE or delta alerts.
          Mirrors Tier 1 alert logic — always works without Yahoo prices.
      ── */}
      {(() => {
        const lotLinkedOpen = trades.filter(t =>
          t.status === 'open' && t.lot_id != null &&
          (t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put')
        );
        if (lotLinkedOpen.length === 0) return null;

        const alertRows = lotLinkedOpen.map(t => {
          const dte = t.expiration
            ? Math.ceil((new Date(t.expiration) - new Date()) / 86400000)
            : null;
          const curStk = parseFloat(currentPrices?.[t.id]?.stock || currentPrices?.[t.ticker?.toUpperCase()]?.stock);
          // Live delta via stock price if available, else entry delta
          let delta = Math.abs(t.delta || 0);
          if (curStk && dte != null && dte > 0) {
            const K  = parseFloat(t.strike_sell || t.strike_buy);
            const iv = (t.iv_entry || 35) / 100;
            const T  = Math.max(0.001, dte / 365);
            const isCall = t.strategy === 'Covered Call';
            if (K > 0 && iv > 0) {
              const d1 = (Math.log(curStk / K) + (0.053 + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
              const nd = x => { const a=[0,0.319381530,-0.356563782,1.781477937,-1.821255978,1.330274429],k=1/(1+0.2316419*Math.abs(x)); let p=0,kp=k; for(let i=1;i<=5;i++){p+=a[i]*kp;kp*=k;} const n=Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); const v=1-n*p; return x>=0?v:1-v; };
              delta = Math.abs(isCall ? nd(d1) : nd(d1) - 1);
            }
          }

          let sev = null, reason = null;
          if (dte != null && dte <= 7)            { sev = 'red';   reason = `${dte} DTE — expires imminently. Act today.`; }
          else if (delta > 0.50)                  { sev = 'red';   reason = `Delta ${delta.toFixed(2)} — high assignment probability.`; }
          else if (dte != null && dte <= 21)       { sev = 'amber'; reason = `${dte} DTE — entering gamma danger zone.`; }
          else if (delta > 0.35 && delta <= 0.50) { sev = 'amber'; reason = `Delta ${delta.toFixed(2)} — elevated assignment risk.`; }

          // Price-enhanced: strike breach
          if (curStk && !sev) {
            if (t.strategy === 'Covered Call') {
              const ss = parseFloat(t.strike_sell);
              if (ss > 0 && curStk >= ss) { sev = 'red'; reason = `Stock $${curStk.toFixed(2)} ≥ $${ss} strike — CC is ITM. Shares at risk.`; }
              else if (ss > 0 && curStk >= ss * 0.97) { sev = 'amber'; reason = `Stock $${curStk.toFixed(2)} within 3% of $${ss} strike.`; }
            }
            if (t.strategy === 'Cash-Secured Put') {
              const sb = parseFloat(t.strike_buy);
              if (sb > 0 && curStk <= sb) { sev = 'red'; reason = `Stock $${curStk.toFixed(2)} ≤ $${sb} put strike — CSP is ITM.`; }
              else if (sb > 0 && curStk <= sb * 1.03) { sev = 'amber'; reason = `Stock $${curStk.toFixed(2)} within 3% of $${sb} put strike.`; }
            }
          }

          if (!sev) return null;
          return { trade: t, sev, reason };
        }).filter(Boolean);

        if (alertRows.length === 0) return null;

        const redCount   = alertRows.filter(a => a.sev === 'red').length;
        const amberCount = alertRows.filter(a => a.sev === 'amber').length;
        const headerSev  = redCount > 0 ? 'red' : 'amber';

        return (
          <div style={{
            background: headerSev === 'red' ? 'var(--red-bg)' : 'var(--amber-bg)',
            border: `1px solid ${headerSev === 'red' ? 'var(--red-border)' : 'var(--amber-border)'}`,
            borderRadius: 8, padding: '10px 14px', marginBottom: 10,
          }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
              <div style={{ fontWeight:700, fontSize:13, color: headerSev === 'red' ? 'var(--red)' : 'var(--amber)', marginBottom:6 }}>
                {redCount > 0 && `⚠️ ${redCount} urgent alert${redCount!==1?'s':''}`}
                {redCount > 0 && amberCount > 0 && ' · '}
                {amberCount > 0 && `${amberCount} position${amberCount!==1?'s':''} to watch`}
                {' '} — options linked to your lots
              </div>
              {onViewAlerts && (
                <button
                  className="btn btn-outline btn-sm"
                  style={{ fontSize:11, flexShrink:0, borderColor: headerSev === 'red' ? 'var(--red)' : 'var(--amber)', color: headerSev === 'red' ? 'var(--red)' : 'var(--amber)' }}
                  onClick={onViewAlerts}
                >
                  View All Alerts →
                </button>
              )}
            </div>
            {alertRows.map(({ trade: t, sev, reason }) => (
              <div key={t.id} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12, marginBottom:3 }}>
                <span style={{ width:7, height:7, borderRadius:'50%', background: sev === 'red' ? 'var(--red)' : 'var(--amber)', flexShrink:0, display:'inline-block' }} />
                <span style={{ fontFamily:'var(--font-mono)', fontWeight:700 }}>{t.ticker}</span>
                <span style={{ color:'var(--text-muted)' }}>{t.strategy}</span>
                <span style={{ color:'var(--text-secondary)' }}>—</span>
                <span>{reason}</span>
              </div>
            ))}
          </div>
        );
      })()}

      {uncoveredLots.length > 0 && (
        <div className="alert alert-amber">
          ⚠️ {uncoveredLots.length} position{uncoveredLots.length > 1 ? 's' : ''} need attention — {uncoveredLots.map(l => l.ticker).join(', ')} — all options closed.
        </div>
      )}

      {/* ── Non-lot open trades banner ─────────────────────────────────────────
          Shows when the trader has open positions that have no share ownership
          (ICs, spreads, Long Calls etc.) so they know to manage them in Trade Log.
      ── */}
      {(() => {
        const NO_SHARE_STRATS = new Set([
          'Cash-Secured Put',
          'Iron Condor','Iron Butterfly',
          'Bull Put Spread','Bear Call Spread','Bull Call Spread','Bear Put Spread',
          'Long Call','Long Put','Long Straddle','Long Strangle',
          'Calendar Spread','Diagonal Spread',
        ]);
        // Deduplicate IC/IB chains — count each chain once, not once per leg
        const seenChains = new Set();
        const nonLotOpen = trades.filter(t => {
          if (t.status !== 'open') return false;
          if (!NO_SHARE_STRATS.has(t.strategy)) return false;
          // Deduplicate IC/IB chains — count each chain once, not per leg
          if (t.condor_chain_id) {
            if (seenChains.has('ic_' + t.condor_chain_id)) return false;
            seenChains.add('ic_' + t.condor_chain_id);
          }
          // Deduplicate Cal chains — count each campaign once, not per leg
          if (t.cal_chain_id != null) {
            if (seenChains.has('cal_' + t.cal_chain_id)) return false;
            seenChains.add('cal_' + t.cal_chain_id);
          }
          return true;
        });
        if (nonLotOpen.length === 0) return null;

        // Group by strategy for the summary line
        const byStrat = {};
        nonLotOpen.forEach(t => {
          if (!byStrat[t.strategy]) byStrat[t.strategy] = [];
          byStrat[t.strategy].push(t.ticker);
        });
        const summary = Object.entries(byStrat)
          .map(([strat, tickers]) => {
            const label = strat.replace('Cash-Secured Put','CSP').replace('Iron Condor','IC').replace('Iron Butterfly','IB')
              .replace('Bull Put Spread','BPS').replace('Bear Call Spread','BCS')
              .replace('Bull Call Spread','BCS').replace('Bear Put Spread','BPS')
              .replace('Long Straddle','Straddle').replace('Long Strangle','Strangle')
              .replace('Calendar Spread','Cal').replace('Diagonal Spread','Diag')
              .replace('Long Call','LC').replace('Long Put','LP');
            return `${label} (${[...new Set(tickers)].join(', ')})`;
          })
          .join('  ·  ');

        return (
          <div style={{
            background: 'var(--blue-bg)',
            border: '1px solid var(--blue-border)',
            borderRadius: 8,
            padding: '10px 14px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
              <span style={{ fontSize: 16, flexShrink: 0 }}>ℹ️</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--blue)', marginBottom: 3 }}>
                  {nonLotOpen.length} open position{nonLotOpen.length !== 1 ? 's' : ''} with no share ownership — manage these in Trade Log
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {summary}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 4 }}>
                  CSPs awaiting assignment, Iron Condors, spreads, long options and volatility plays do not require share ownership and are not shown on this page. Use Trade Log to close, roll, or manage assignment.
                </div>
              </div>
            </div>
            {onViewTrades && (
              <button
                className="btn btn-outline btn-sm"
                style={{ flexShrink: 0, fontSize: 12, whiteSpace: 'nowrap' }}
                onClick={() => onViewTrades('')}
                title="Go to Trade Log to manage these positions"
              >
                View in Trade Log →
              </button>
            )}
          </div>
        );
      })()}

      <div className="tabs">
        <div className={`tab ${tab === 'positions' ? 'active' : ''}`} onClick={() => setTab('positions')}>Active Positions</div>
        <div className={`tab ${tab === 'wheel' ? 'active' : ''}`} onClick={() => setTab('wheel')}>Wheel Cycle Summary</div>
      </div>

      {tab === 'positions' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
                {Object.keys(byTicker).length} stocks · {lots.filter(l => !l.close_date).length} open lots · {lots.filter(l => l.close_date).length} closed
              </span>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-outline btn-sm" onClick={exportCSV}>↓ Export CSV</button>
              <button className="btn btn-green btn-sm" onClick={() => onAddLot(null)}>+ Add Stock Lot</button>
            </div>
          </div>

          {Object.keys(filteredByTicker).length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">◈</div>
              <h3>No open stock positions</h3>
              <p>Add a stock lot to start tracking your wheel strategy.</p>
              <div className="empty-state-actions">
                <button className="btn btn-green" onClick={() => onAddLot(null)}>+ Add Stock Lot</button>
              </div>
            </div>
          ) : (
            Object.entries(filteredByTicker).map(([ticker, tickerLots]) => {
              // FIX #19: Only include lot-linked trades in premium total.
              // Unlinked IC/spread trades (lot_id: null) are not part of the wheel
              // and should not inflate the per-ticker premium or net cost figures.
              const allTrades  = trades.filter(t => tickerLots.some(l => l.id === t.lot_id));
              const totalPrem  = calcLotPremium(allTrades);
              const openLots   = tickerLots.filter(l => !l.close_date);
              const isOpen     = openLots.length > 0;
              // blended = weighted avg cost across all open lots (works for 1 or more lots)
              const totalShares = openLots.reduce((s, l) => s + l.shares, 0);
              const blended    = totalShares > 0
                ? openLots.reduce((s, l) => s + l.avg_cost * l.shares, 0) / totalShares
                : null;
              // Net cost = blended avg cost minus all wheel premium per share (open + closed lot-linked)
              // Uses totalShares from open lots only — closed lots' cost basis is already settled
              const blendedNet  = blended != null && totalShares > 0
                ? blended - totalPrem / totalShares
                : null;
              const isExp       = expanded[ticker];

              return (
                <div key={ticker} className="card" style={{ marginBottom: 10, padding: 0 }}>
                  {/* Header */}
                  <div className="collapsible-header" onClick={() => toggleExpanded(ticker)}>
                    <div style={{ display: 'grid', gridTemplateColumns: '100px 120px 1fr 1fr 1fr 1fr auto auto', gap: 10, flex: 1, alignItems: 'center' }}>

                      {/* Ticker */}
                      <div style={{ fontWeight: 800, fontSize: 15, fontFamily: 'var(--font-mono)' }}>{ticker}</div>

                      {/* Strategy — what is currently written against this ticker */}
                      <div>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>Strategy</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                          {(() => {
                            const openOpts = trades.filter(t =>
                              tickerLots.some(l => l.id === t.lot_id) && t.status === 'open'
                            );
                            const strategies = [...new Set(openOpts.map(t => t.strategy))];
                            // Check if ANY lot for this ticker is unhedged — even when other lots
                            // have open options. e.g. AAPL lot1 unhedged + lot2 has CC → must warn.
                            const hasUnhedgedLot = uncoveredLots.some(l =>
                              tickerLots.some(tl => tl.id === l.id)
                            );
                            const targetLot = uncoveredLots.find(l =>
                              tickerLots.some(tl => tl.id === l.id)
                            ) || openLots[0];

                            if (!strategies.length) {
                              // Closed lot — wheel complete, no action needed
                              if (!isOpen) return (
                                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 600 }}>✓ Wheel closed</span>
                              );
                              // Open lot with no CC — needs attention, offer quick launch
                              return (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 10, color: 'var(--amber)', fontWeight: 600 }}>⚠ No open options</span>
                                  {onWriteCC && targetLot && (
                                    <button
                                      type="button"
                                      onClick={e => { e.stopPropagation(); onWriteCC(targetLot); }}
                                      style={{
                                        fontSize: 9, fontWeight: 700, padding: '2px 7px',
                                        borderRadius: 10, border: '1px solid var(--blue-border)',
                                        background: 'var(--blue-bg)', color: 'var(--blue)',
                                        cursor: 'pointer', lineHeight: 1.4,
                                      }}
                                      title={`Write a Covered Call on ${ticker} lot #${targetLot.id} (${targetLot.shares} shares @ $${targetLot.avg_cost}) — opens trade form pre-filled`}
                                    >
                                      + Write CC
                                    </button>
                                  )}
                                </div>
                              );
                            }
                            return (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                {strategies.map((s, i) => (
                                  <span key={i} style={{
                                    fontSize: 9, fontWeight: 700, padding: '1px 6px', borderRadius: 10, width: 'fit-content',
                                    background: s === 'Covered Call' ? 'var(--blue-bg)' : s === 'Cash-Secured Put' ? 'var(--amber-bg)' : 'var(--purple-bg)',
                                    color:      s === 'Covered Call' ? 'var(--blue)'    : s === 'Cash-Secured Put' ? 'var(--amber)'    : 'var(--purple)',
                                  }}>
                                    {s.replace('Cash-Secured Put','CSP').replace('Covered Call','CC').replace('Bull Put Spread','BPS').replace('Iron Condor','IC')}
                                  </span>
                                ))}
                                {/* Show unhedged warning inline even when some lots have options */}
                                {hasUnhedgedLot && isOpen && onWriteCC && targetLot && (
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                    <span style={{ fontSize: 9, color: 'var(--amber)', fontWeight: 600 }}>⚠ lot unhedged</span>
                                    <button
                                      type="button"
                                      onClick={e => { e.stopPropagation(); onWriteCC(targetLot); }}
                                      style={{
                                        fontSize: 9, fontWeight: 700, padding: '2px 7px',
                                        borderRadius: 10, border: '1px solid var(--blue-border)',
                                        background: 'var(--blue-bg)', color: 'var(--blue)',
                                        cursor: 'pointer', lineHeight: 1.4,
                                      }}
                                      title={`Lot #${targetLot.id} (${targetLot.shares} shares @ $${targetLot.avg_cost}) has no open CC — click to write one`}
                                    >
                                      + Write CC
                                    </button>
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        </div>
                      </div>

                      {/* Avg / Blended Cost */}
                      <div title={openLots.length > 1 ? 'Weighted average purchase price per share across all open lots (weighted by share count)' : 'Average purchase price per share for this lot'}>
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                          {openLots.length > 1 ? 'Blended Avg Cost ⓘ' : 'Avg Cost ⓘ'}
                        </div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                          {!isOpen ? '—' : blended != null ? fmt(blended) : tickerLots[0]?.avg_cost ? fmt(tickerLots[0].avg_cost) : '—'}
                        </div>
                      </div>

                      {/* Total Premium */}
                      <div title="Total wheel premium income for this position — realised P&L from closed option trades (CCs, CSPs) plus the full entry premium of any open positions (assuming they expire worthless). Unlinked trades (ICs, spreads without a lot_id) are excluded.">
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Premium Collected ⓘ</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--green)' }}>+{fmt(totalPrem)}</div>
                      </div>

                      {/* Net Cost */}
                      <div title="Effective cost basis per share after all wheel premium. Avg purchase price minus (total premium ÷ open shares). This is your breakeven: the stock must stay above this level for the full position to profit. Includes open-position premium assuming expiry worthless.">
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Net Cost ⓘ</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--green)' }}>
                          {blendedNet != null ? fmt(blendedNet) : '—'}
                        </div>
                      </div>

                      {/* Lots count */}
                      <div title="Number of open share lots for this ticker">
                        <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>Lots</div>
                        <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{openLots.length}</div>
                      </div>

                      {/* Status badge */}
                      <div>
                        <span className={`badge ${isOpen ? 'badge-green' : 'badge-gray'}`}>
                          {isOpen ? 'Active' : 'Closed'}
                        </span>
                      </div>
                    </div>

                    {/* Details expand button — replaces bare chevron */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 8, flexShrink: 0 }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12,
                        background: isExp ? 'var(--blue-bg)' : 'var(--bg)',
                        color: isExp ? 'var(--blue)' : 'var(--text-secondary)',
                        border: '1px solid var(--border)',
                        whiteSpace: 'nowrap',
                      }}>
                        {isExp ? '▾ Hide' : '▸ Details'}
                      </span>
                    </div>
                  </div>

                  {isExp && (
                    <div style={{ borderTop: '1px solid var(--border)', padding: '0 16px 12px' }}>
                      {tickerLots.map(lot => {
                        const lotTrades = trades.filter(t => t.lot_id === lot.id);
                        const premium   = calcLotPremium(lotTrades);
                        const net       = lot.avg_cost - (premium / lot.shares);
                        const reduction = lot.avg_cost ? (1 - net / lot.avg_cost) * 100 : 0;
                        const openOpts  = lotTrades.filter(t => t.status === 'open');
                        const closedOpts = lotTrades.filter(t => t.status === 'closed');
                        const sharePnl  = lot.close_date ? (lot.close_price - lot.avg_cost) * lot.shares : null;
                        const totalRet  = sharePnl != null ? sharePnl + premium : null;
                        // Annualised return — the wheel trader's primary metric
                        const daysHeld  = Math.max(1, Math.round((new Date(lot.close_date || new Date()) - new Date(lot.purchase_date || new Date())) / 86400000));
                        const costBasis = (lot.avg_cost || 0) * (lot.shares || 0);
                        // Ann. Yield — use max(daysHeld, ccDTE) as the time base.
                        // This holds under all circumstances:
                        //   New lot (days < DTE):  DTE wins → honest forward rate, no day-1 inflation
                        //   Mature wheel (days > DTE): days wins → accurate track record
                        //   Between CCs (no open CC): falls back to days held → still shows performance
                        // Formula: (premium / costBasis) / max(daysHeld, ccDTE) × 365 × 100
                        const openCC   = openOpts.find(t => t.strategy === 'Covered Call');
                        const ccDTE    = openCC?.expiration
                          ? Math.max(1, Math.ceil((new Date(openCC.expiration) - new Date()) / 86400000))
                          : null;
                        const yieldDays = Math.max(daysHeld, ccDTE || 0);
                        const annualisedYield = costBasis > 0 && yieldDays > 0
                          ? (premium / costBasis) / yieldDays * 365 * 100
                          : null;
                        // Annualised total return on closed lots
                        const annualisedTotal = totalRet != null && costBasis > 0 && daysHeld > 0
                          ? (totalRet / costBasis) / daysHeld * 365 * 100
                          : null;

                        return (
                          <div key={lot.id} style={{ marginTop: 12 }}>
                            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>
                              LOT #{lot.id} — {lot.shares} shares @ ${lot.avg_cost} {lot.purchase_date && `(${lot.purchase_date})`}
                              {lot.close_date && <span className="badge badge-gray" style={{ marginLeft: 6 }}>Closed {lot.close_date}</span>}
                            </div>

                            <div className="lot-detail-grid">
                              {/* Col 1: Cost basis */}
                              <div>
                                <div className="lot-col-title">Cost Basis</div>
                                {[
                                  ['Purchase Price',    fmt(lot.avg_cost)],
                                  ['Premium Collected', <span className="text-green" title="Realised P&L from closed options on this lot, plus full entry premium from open positions (assuming worthless expiry)">+{fmt(premium)}</span>],
                                  ['Premium/Share',     <span title="Total premium ÷ shares — cost basis reduction per share">{fmt(premium / lot.shares)}</span>],
                                  ['Net Cost/Share',    <strong title="Purchase price minus premium/share — your effective breakeven price">{fmt(net)}</strong>],
                                  ['Cost Reduction',    <span className="text-green" title="Premium as % of original purchase price">{pct(reduction)}</span>],
                                  // Annualised yield on open lots
                                  ...(!lot.close_date && annualisedYield != null ? [
                                    ['Ann. Yield', <span className="text-green" title={`Premium collected ÷ cost basis ÷ ${yieldDays} days × 365. Uses the longer of days held vs CC DTE — avoids day-1 inflation on new lots while tracking true performance on mature wheels.`}>{annualisedYield.toFixed(1)}%/yr</span>],
                                  ] : []),
                                  ...(lot.close_date ? [
                                    ['Sale Price',   fmt(lot.close_price)],
                                    ['Share P&L',    <span className={sharePnl >= 0 ? 'text-green' : 'text-red'} title="(Sale price − avg cost) × shares">{sharePnl >= 0 ? '+' : ''}{fmt(sharePnl)}</span>],
                                    ['Total Return', <strong className={totalRet >= 0 ? 'text-green' : 'text-red'} title="Share P&L + all option premium collected on this lot">{totalRet >= 0 ? '+' : ''}{fmt(totalRet)}</strong>],
                                    ...( annualisedTotal != null ? [['Ann. Return', <span className={annualisedTotal >= 0 ? 'text-green' : 'text-red'} title="Total return ÷ cost basis, annualised over days held">{annualisedTotal.toFixed(1)}%/yr</span>]] : []),
                                  ] : []),
                                ].map(([label, value], i) => (
                                  <div key={i} className="lot-row">
                                    <span className="lot-row-label">{label}</span>
                                    <span className="lot-row-value">{value}</span>
                                  </div>
                                ))}
                              </div>

                              {/* Col 2: Active options */}
                              <div>
                                <div className="lot-col-title">Active Options</div>
                                {openOpts.length === 0
                                  ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No open options</div>
                                  : openOpts.map(t => (
                                    <div key={t.id} style={{ background: 'var(--bg)', borderRadius: 6, padding: '8px 10px', marginBottom: 6 }}>
                                      <div style={{ fontSize: 12, fontWeight: 600, color: STRATEGY_COLORS[t.strategy] || '#555' }}>{t.strategy}</div>
                                      <div style={{ fontSize: 11.5, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
                                        Strike {t.strike_sell ?? t.strike_buy} · Exp {t.expiration} · ${t.entry_price}
                                      </div>
                                      <div style={{ display: 'flex', gap: 5, marginTop: 5 }}>
                                        {t.strategy === 'Cash-Secured Put' && (
                                          <><button className="btn btn-xs" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-border)' }} onClick={() => onAssignment(t)}>Assigned</button>
                                          <button className="btn btn-xs" style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--amber-border)' }} onClick={() => onCloseTrade(t)}>Close Early</button></>
                                        )}
                                        {t.strategy === 'Covered Call' && (
                                          t.lot_id
                                            ? <><button className="btn btn-xs" style={{ background: 'var(--green-bg)', color: 'var(--green)', border: '1px solid var(--green-border)' }} onClick={() => onCalledAway(t)}>Called Away</button>
                                              <button className="btn btn-xs" style={{ background: 'var(--surface2)', color: 'var(--text-secondary)', border: '1px solid var(--green-border)' }} onClick={() => onCloseTrade(t)}>Close Early</button></>
                                            : <span style={{ fontSize:10, color:'var(--red,#c0392b)', fontStyle:'italic' }}
                                                title="This CC is not linked to a stock lot. Edit the trade to link it before recording called away.">
                                                ⚠ No lot linked — edit trade first
                                              </span>
                                        )}
                                      </div>
                                    </div>
                                  ))
                                }
                              </div>

                              {/* Col 3: Trade history */}
                              <div>
                                <div className="lot-col-title">Trade History ({closedOpts.length})</div>
                                <div style={{ maxHeight: 120, overflowY: 'auto' }}>
                                  {closedOpts.length === 0
                                    ? <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>No closed trades</div>
                                    : closedOpts.map(t => {
                                      // For assigned CSPs, pnl=0 (demo convention) but the
                                      // real premium collected = entry_price × contracts × 100.
                                      // Detect assignment: exit_price = entry_price OR exit_price = strike_buy
                                      const isCSPAssign = t.strategy === 'Cash-Secured Put' &&
                                        (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
                                         (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
                                      // Called-away CC: exit_price = strike_sell (share sale price, not option buyback)
                                      const isCCCalledAway = t.strategy === 'Covered Call' &&
                                        t.strike_sell != null &&
                                        Math.abs(parseFloat(t.exit_price) - parseFloat(t.strike_sell)) < 0.01;
                                      // Display the real premium collected for assignments
                                      const displayPnl = isCSPAssign || isCCCalledAway
                                        ? parseFloat(t.entry_price) * (t.contracts || 1) * 100
                                        : t.pnl;
                                      const label = isCSPAssign ? 'CSP (assigned)' : isCCCalledAway ? 'CC (called away)' : t.strategy;
                                      return (
                                      <div key={t.id} style={{ fontSize: 12, padding: '3px 0', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between' }}>
                                        <span style={{ color: 'var(--text-secondary)' }}>{label.replace('Cash-Secured Put','CSP').replace('Covered Call','CC')}</span>
                                        <span className={displayPnl >= 0 ? 'text-green' : 'text-red'} style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                                          {displayPnl != null ? (displayPnl >= 0 ? '+' : '') + '$' + Math.round(displayPnl).toLocaleString() : '—'}
                                        </span>
                                      </div>
                                      );
                                    })
                                  }
                                </div>
                              </div>
                            </div>

                            {/* Lot actions */}
                            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                              {/* Edit Lot — only shown when no open CC/CSP is written against this lot.
                                  Once a wheel is running, avg_cost and shares are broker facts — not editable. */}
                              {!trades.some(t =>
                                t.lot_id === lot.id &&
                                t.status === 'open' &&
                                (t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put')
                              ) && (
                                <button className="btn btn-outline btn-xs" onClick={() => onEditLot(lot)}>Edit Lot</button>
                              )}
                              {!lot.close_date
                                ? <button className="btn btn-xs" style={{ background: 'var(--amber-bg)', color: 'var(--amber)', border: '1px solid var(--amber-border)' }} onClick={() => onCloseLot(lot)}>✕ Sell Shares / End Wheel</button>
                                : !trades.some(t => t.lot_id === lot.id) && (
                                    <button className="btn btn-outline btn-xs" onClick={() => onReopenLot(lot)}>↩ Reopen</button>
                                  )
                              }
                              {!lot.close_date && (
                                <button className="btn btn-outline btn-xs" onClick={() => onSplitLot(lot)}
                                  style={{ borderColor: 'var(--blue)', color: 'var(--blue)' }}>
                                  ⅄ Split
                                </button>
                              )}
                              <button className="btn btn-danger btn-xs" onClick={() => onDeleteLot(lot.id)}>Remove Lot</button>
                            </div>
                          </div>
                        );
                      })}

                      {/* Blended summary for >1 open lot */}
                      {openLots.length > 1 && (
                        <div style={{ marginTop: 14, background: 'var(--accent-light)', border: '1px solid var(--blue-border)', borderRadius: 8, padding: '12px 14px' }}>
                          <div style={{ fontWeight: 700, fontSize: 12, color: 'var(--blue)', marginBottom: 8 }}>Blended Position Summary</div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 10 }}>
                            {[
                              ['Total Shares', totalShares],
                              ['Blended Cost', blended != null ? fmt(blended) : '—'],
                              ['Total Premium', '+'+fmt(totalPrem)],
                              ['Net Cost/Share', blendedNet != null ? fmt(blendedNet) : '—'],
                              ['Cost Reduction', blended != null && blendedNet != null ? pct((1 - blendedNet/blended)*100) : '—'],
                            ].map(([label, value]) => (
                              <div key={label}>
                                <div style={{ fontSize: 10, color: 'var(--blue)', marginBottom: 2 }}>{label}</div>
                                <div style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--text-primary)' }}>{value}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}

          {/* Bottom summary cards */}
          {lots.length > 0 && (() => {
            // Wheel premium: all lot-linked trades
            // Wheel premium: only open lots (matching the 5 lots visible in the main grid)
            // Closed/called-away lots (e.g. NVDA) are in Completed Wheels — not counted here
            const openLotIds = new Set((lots || []).filter(l => !l.close_date).map(l => l.id));
            const wheelPremium = calcLotPremium(trades.filter(t => t.lot_id != null && openLotIds.has(t.lot_id)));

            // Standalone P&L: all closed trades with no lot_id
            // Also includes partially-closed chain legs (open status but partial_close_pnl > 0)
            // Computed at chain level for IC/Cal (sum all legs), individual for others
            const standaloneTrades = trades.filter(t =>
              !t.lot_id && (
                (t.status === 'closed' && t.pnl !== null) ||
                (t.status === 'open'   && (t.partial_close_pnl || 0) !== 0)
              )
            );
            const icChainTotals = {};
            const calChainTotals = {};
            const purePnl = standaloneTrades.reduce((s, t) => {
              const contrib = (t.pnl || 0) + (t.partial_close_pnl || 0);
              if (t.condor_chain_id) {
                icChainTotals[t.condor_chain_id] = (icChainTotals[t.condor_chain_id] || 0) + contrib;
                return s; // counted at chain level
              }
              if (t.cal_chain_id != null) {
                calChainTotals[t.cal_chain_id] = (calChainTotals[t.cal_chain_id] || 0) + contrib;
                return s; // counted at chain level
              }
              return s + contrib;
            }, 0);
            const standalonePnl = purePnl
              + Object.values(icChainTotals).reduce((s, v) => s + v, 0)
              + Object.values(calChainTotals).reduce((s, v) => s + v, 0);

            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 14, marginTop: 16 }}>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}
                    title="Total premium collected writing options against your shares (open lots only).&#10;&#10;Includes: closed CCs and CSPs (settled cash) + open CCs/CSPs at full entry value (as if they expire worthless — conservative cost basis assumption).&#10;&#10;Excludes: NVDA and other called-away lots (shown in Completed Wheels below). Does not include standalone trades (ICs, spreads without a lot).&#10;&#10;This is your effective cost basis reducer — each dollar here lowers your breakeven per share.">
                    Wheel Premium ⓘ
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--green)' }}>+{fmt(wheelPremium)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>options written against your shares</div>
                </div>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}
                    title="Realised (settled) P&L from standalone option trades — positions not linked to any share lot.&#10;&#10;Includes: closed ICs (summed across all legs), Calendar chains, spreads, long options, straddles. Partial closes counted when booked.&#10;&#10;Excludes: open positions (unrealised P&L is not settled cash). Open ICs and calendars showing unrealised P&L are visible in Trade Log.&#10;&#10;This is the cash you have actually banked from non-wheel option activity.">
                    Standalone P&L ⓘ
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: standalonePnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {standalonePnl >= 0 ? '+' : ''}{fmt(standalonePnl)}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>ICs · calendars · spreads · long options</div>
                </div>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Open Lots</div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--blue)' }}>{lots.filter(l => !l.close_date).length}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>active positions</div>
                </div>
                <div className="card" style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 4 }}>Need Attention</div>
                  <div style={{ fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)', color: uncoveredLots.length > 0 ? 'var(--amber)' : 'var(--green)' }}>{uncoveredLots.length}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>unhedged lots</div>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {tab === 'wheel' && (
        <div>
          {lots.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">◈</div><h3>No lots yet</h3></div>
          ) : (
            lots.map(lot => {
              const lotTrades = trades.filter(t => t.lot_id === lot.id);
              const premium   = calcLotPremium(lotTrades);
              const net       = lot.avg_cost - (premium / lot.shares);
              const reduction = lot.avg_cost ? (1 - net / lot.avg_cost) * 100 : 0;
              const days      = Math.round((new Date(lot.close_date || new Date()) - new Date(lot.purchase_date || new Date())) / 86400000);
              const sharePnl  = lot.close_date ? (lot.close_price - lot.avg_cost) * lot.shares : null;
              const totalRet  = sharePnl != null ? sharePnl + premium : null;
              const roi       = totalRet != null && lot.avg_cost && lot.shares ? totalRet / (lot.avg_cost * lot.shares) * 100 : null;
              const annlz     = roi != null && days > 0 ? roi / days * 365 : null;
              const isClosed  = !!lot.close_date;

              return (
                <div key={lot.id} className={`wheel-card ${isClosed ? 'closed' : ''}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div>
                      <span style={{ fontWeight: 800, fontSize: 15, fontFamily: 'var(--font-mono)' }}>{lot.ticker}</span>
                      <span style={{ fontSize: 13, color: 'var(--text-secondary)', marginLeft: 10 }}>{lot.shares} shares @ ${lot.avg_cost}</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {onViewTrades && (
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ fontSize: 11, padding: '2px 10px' }}
                          onClick={() => onViewTrades(lot.ticker, lot.id, isClosed)}
                          title={`View all trades for ${lot.ticker} in Trade Log`}
                        >View trades →</button>
                      )}
                      <span className={`badge ${isClosed ? 'badge-gray' : 'badge-blue'}`}>{isClosed ? 'Closed' : 'Open'}</span>
                    </div>
                  </div>

                  <div className="wheel-stats-grid">
                    {isClosed ? [
                      ['Total Premium', '+'+fmt(premium), 'var(--green)',
                        `All CC and CSP premiums collected on this lot — closed at actual P&L, open positions at full entry value. This is the option income component of your wheel return. Demo: ${fmt(premium)}`],
                      ['Share P&L', (sharePnl >= 0 ? '+' : '') + fmt(sharePnl), sharePnl >= 0 ? 'var(--green)' : 'var(--red)',
                        `(Exit price − avg cost) × shares. The capital gain or loss on the shares themselves when called away or sold. Does not include option premium.`],
                      ['Total Return', (totalRet >= 0 ? '+' : '') + fmt(totalRet), totalRet >= 0 ? 'var(--green)' : 'var(--red)',
                        `Total Premium + Share P&L. The complete wheel outcome — what the entire position returned from first CSP or share purchase to final exit. The number that matters most.`],
                      ['ROI %', pct(roi), roi >= 0 ? 'var(--green)' : 'var(--red)',
                        `Total Return ÷ initial capital (avg cost × shares). Measures what percentage you made on the full capital deployed in this position.`],
                      ['Annualized', pct(annlz), 'var(--blue)',
                        `ROI % ÷ days held × 365. Projects the return to a 12-month rate so you can compare across positions of different durations. Useful for comparing a 3-month wheel vs a 6-month wheel.`],
                      ['Days Held', days, 'var(--text-secondary)',
                        `Calendar days from purchase date to close/called-away date. Used to compute annualized return.`],
                    ].map(([label, value, color, tip]) => (
                      <div key={label} className="wheel-stat" title={tip}>
                        <div className="wheel-stat-label">{label} ⓘ</div>
                        <div className="wheel-stat-value" style={{ color }}>{value}</div>
                      </div>
                    )) : [
                      ['Premium So Far', '+'+fmt(premium), 'var(--green)',
                        `Running total of all option income on this lot — realised P&L from closed CCs/CSPs plus the full entry value of any open positions (assuming they expire worthless). Used to calculate your net cost basis.`],
                      ['Cost Reduction', pct(reduction), 'var(--green)',
                        `(Premium so far ÷ shares) ÷ avg cost × 100. How much premium has reduced your effective cost basis as a percentage. e.g. 11.9% means you have recovered 11.9% of your purchase price through option income alone.`],
                      ['Net Cost/Share', fmt(net), 'var(--text-primary)',
                        `Avg cost − (premium so far ÷ shares). Your effective breakeven price per share after all premium collected. If the stock is called away at this price you break even on the full position.`],
                      ...(() => {
                        const wsOpenCC  = lotTrades.find(t => t.status === 'open' && t.strategy === 'Covered Call');
                        const wsCcDTE   = wsOpenCC?.expiration
                          ? Math.max(1, Math.ceil((new Date(wsOpenCC.expiration) - new Date()) / 86400000))
                          : null;
                        const wsYieldDays = Math.max(days, wsCcDTE || 0);
                        const wsYield   = premium > 0 && wsYieldDays > 0 && lot.avg_cost && lot.shares
                          ? premium / (lot.avg_cost * lot.shares) / wsYieldDays * 365 * 100
                          : null;
                        return wsYield != null ? [
                          ['Ann. Yield', pct(wsYield), 'var(--blue)',
                            `Premium ÷ cost basis ÷ ${wsYieldDays} days × 365. Uses max(days held, CC DTE) — honest on new lots, accurate on mature wheels. Wheel targets 20–40%/yr.`],
                        ] : [];
                      })(),
                      ['Days Running', days, 'var(--text-secondary)',
                        `Calendar days since purchase. Longer-running positions with lower annualised yield may benefit from a strategy review.`],
                      ['Open Trades', lotTrades.filter(t => t.status === 'open').length, 'var(--blue)',
                        `Active CC or CSP currently written against this lot. Ideally always 1 — if 0, capital is sitting idle and not generating income.`],
                      ['Closed Trades', lotTrades.filter(t => t.status === 'closed').length, 'var(--text-muted)',
                        `Number of completed CC/CSP cycles on this lot. Higher count = more active premium generation. Each closed trade contributed to the Premium So Far total.`],
                    ].map(([label, value, color, tip]) => (
                      <div key={label} className="wheel-stat" title={tip}>
                        <div className="wheel-stat-label">{label} ⓘ</div>
                        <div className="wheel-stat-value" style={{ color }}>{value}</div>
                      </div>
                    ))}
                  </div>

                  {/* Trade timeline pills */}
                  <div style={{ marginTop: 8 }}>
                    {[...lotTrades].sort((a, b) => (a.entry_date || '').localeCompare(b.entry_date || '')).map(t => {
                      const c = t.strategy === 'Covered Call' ? '#1a5fa8' : t.strategy === 'Cash-Secured Put' ? '#1a7a4a' : '#6d28d9';
                      // Detect special zero-pnl conventions so the pill is informative
                      const isCSPAssigned  = t.strategy === 'Cash-Secured Put' && t.status === 'closed' &&
                        (parseFloat(t.exit_price) === parseFloat(t.entry_price) ||
                         (t.strike_buy != null && parseFloat(t.exit_price) === parseFloat(t.strike_buy)));
                      const isCalledAway   = t.strategy === 'Covered Call'  && t.status === 'closed' &&
                        parseFloat(t.exit_price) === parseFloat(t.strike_sell);
                      // Display premium for CSP assignments; share gain label for called-away CCs
                      const pillPnl = isCSPAssigned
                        ? Math.round((t.entry_price || 0) * (t.contracts || 1) * 100)
                        : isCalledAway
                          ? (t.pnl && t.pnl !== 0 ? t.pnl : Math.round((t.entry_price || 0) * (t.contracts || 1) * 100))
                          : t.pnl;
                      const pillLabel = isCalledAway
                        ? `CC ✓ Called Away ${t.expiration?.slice(5) || ''}`
                        : isCSPAssigned
                          ? `CSP → Assigned ${t.expiration?.slice(5) || ''}`
                          : `${t.strategy.replace('Cash-Secured Put','CSP').replace('Covered Call','CC')} ${t.expiration?.slice(5) || ''}`;
                      return (
                        <span key={t.id} className="trade-pill" style={{ background: c + '18', color: c, border: `1px solid ${c}33` }}>
                          {pillLabel}
                          {pillPnl != null && <span style={{ marginLeft: 4, fontFamily: 'var(--font-mono)' }}>{pillPnl >= 0 ? '+' : ''}${pillPnl.toFixed(0)}</span>}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })
          )}

          {/* Total wheel performance */}
          {lots.filter(l => l.close_date).length > 0 && (() => {
            const closedLots = lots.filter(l => l.close_date);
            const totPrem = closedLots.reduce((s, l) => s + calcLotPremium(trades.filter(t => t.lot_id === l.id)), 0);
            const totShare = closedLots.reduce((s, l) => s + (l.close_price - l.avg_cost) * l.shares, 0);
            const totRet   = totPrem + totShare;
            const totCost  = closedLots.reduce((s, l) => s + l.avg_cost * l.shares, 0);
            const roi      = totCost ? totRet / totCost * 100 : 0;
            return (
              <div className="card" style={{ marginTop: 16, background: 'linear-gradient(135deg, var(--green-bg), var(--accent-light))', border: '1px solid var(--green-border)' }}>
                <div style={{ fontWeight: 700, marginBottom: 10 }}>Total Wheel Performance (Closed Lots)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14 }}>
                  {[['Total Premium', '+'+fmt(totPrem), 'var(--green)'], ['Share P&L', fmt(totShare), totShare >= 0 ? 'var(--green)' : 'var(--red)'], ['Total Return', fmt(totRet), totRet >= 0 ? 'var(--green)' : 'var(--red)'], ['Overall ROI', pct(roi), roi >= 0 ? 'var(--green)' : 'var(--red)']].map(([label, value, color]) => (
                    <div key={label}>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 3 }}>{label}</div>
                      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: 'var(--font-mono)', color }}>{value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
