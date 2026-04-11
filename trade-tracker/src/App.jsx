// src/App.jsx
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import './index.css';
import Dashboard      from './components/Dashboard';
import TradeLog       from './components/TradeLog';
import TradeForm      from './components/TradeForm';
import StockPositions, { LotForm, CloseLotModal, AssignmentModal, CalledAwayModal, CloseTradeModal, ExpiredWorthlessModal, StockSplitModal } from './components/StockPositions';
import Alerts         from './components/Alerts';
import { getDemoTrades, getDemoLots, getNextDemoTradeId, getNextDemoLotId } from './api/demoEngine';
import ImportModal         from './components/ImportModal';
import DataConnectionModal from './components/DataConnectionModal';
import HelpPanel           from './components/HelpPanel';
import QuickStartPanel     from './components/QuickStartPanel';
import { fetchYahooPrices, fetchStockPrice, fetchAtmIv, clearStockCache } from './utils/yahooQuotes';
import { fetchMarketDataPrices } from './utils/marketDataQuotes';
import ErrorBoundary        from './ErrorBoundary';
import CalAdjustModal       from './components/CalAdjustModal';
const localDateISO = (d=new Date()) => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };

const VIEWS = [
  { id: 'dashboard', icon: '▦', label: 'Analytics' },
  { id: 'positions', icon: '◈', label: 'Stock Positions' },
  { id: 'trades',    icon: '≡', label: 'Trade Log' },
  { id: 'alerts',    icon: '⚡', label: 'Alerts & Insights' },
];

function getBase() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol;
  if (proto === 'app:' || proto === 'file:') {
    // Electron — use port injected by main process
    const port = window.__BACKEND_PORT__ || 3002;
    return `http://127.0.0.1:${port}`;
  }
  // Browser (Scenario 1 — npm start) — backend always runs on 3002
  if (proto === 'http:' || proto === 'https:') {
    return `http://127.0.0.1:3002`;
  }
  return '';
}

// ── normLot ──────────────────────────────────────────────
export function normLot(lot) {
  return {
    ...lot,
    shares:      parseFloat(lot.shares)      || 0,
    avg_cost:    parseFloat(lot.avg_cost)    || 0,
    close_price: lot.close_price != null ? parseFloat(lot.close_price) : null,
  };
}

// ── DemoWatermark ─────────────────────────────────────────
function DemoWatermark() {
  return (
    <div style={{ position:'fixed', inset:0, pointerEvents:'none', zIndex:9998, overflow:'hidden' }}>
      <div style={{
        position:'absolute', left:'-20%', width:'140%', height:90,
        top:'40%', transform:'rotate(-30deg)',
        background:'rgba(255,193,7,0.12)',
        borderTop:'1px solid rgba(146,96,10,0.15)', borderBottom:'1px solid rgba(146,96,10,0.15)',
        display:'flex', alignItems:'center', justifyContent:'center',
      }}>
        <span style={{ fontSize:36, fontWeight:800, color:'rgba(146,96,10,0.25)', letterSpacing:12 }}>DEMO DATA</span>
      </div>
    </div>
  );
}

// ── DemoPill ──────────────────────────────────────────────
function DemoPill({ isMock, onToggle, loading }) {
  return (
    <div className="demo-pill">
      <div className="demo-pill-label">
        <div className="demo-pill-dot" style={{ background: isMock ? '#92600a' : '#1a7a4a' }} />
        <span style={{ color: isMock ? 'var(--amber)' : 'var(--green)' }}>
          {isMock ? 'Demo Mode' : 'Live Mode'}
        </span>
      </div>
      <button className="demo-pill-btn" onClick={onToggle} disabled={loading}>
        {isMock ? '→ Live Mode' : '→ Demo Mode'}
      </button>
    </div>
  );
}

// ── Temp IDs for mock mode (module-level counters) ───────
// Demo temp IDs are managed in demoEngine.js (getNextDemoTradeId / getNextDemoLotId)

// ── BackupModal ───────────────────────────────────────────
function BackupModal({ lastBackup, onBackup, onSkip, onDisable }) {
  const [downloading, setDownloading] = React.useState(false);
  const [done,        setDone]        = React.useState(false);

  async function handleBackup() {
    setDownloading(true);
    try {
      const res  = await fetch(getBase() + '/api/backup/download');
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const size = blob.size;
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      const date = localDateISO();
      a.href     = url;
      a.download = `myoptiondiary-backup-${date}.db`;
      a.click();
      URL.revokeObjectURL(url);
      // Record backup
      await fetch(getBase() + '/api/backup/record', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ size }),
      });
      setDone(true);
      setTimeout(() => onBackup(), 1800);
    } catch (e) {
      alert('Backup failed: ' + e.message);
    }
    setDownloading(false);
  }

  const lastStr = lastBackup
    ? 'Last backup: ' + new Date(lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : 'You have never backed up your data.';

  return (
    <div className="backup-modal-overlay" onClick={e => e.target === e.currentTarget && onSkip()}>
      <div className="backup-modal">
        <div className="backup-modal-icon">{done ? '✅' : '💾'}</div>
        <div className="backup-modal-title">
          {done ? 'Backup saved!' : 'Monthly backup reminder'}
        </div>
        {!done && (
          <>
            <div className="backup-modal-body">
              It's the end of the month — a great time to save a backup of your trades database to a safe place (USB drive, cloud storage, email to yourself).
            </div>
            <div className="backup-modal-last">{lastStr}</div>
            <div className="backup-modal-actions">
              <button
                className="btn btn-primary"
                onClick={handleBackup}
                disabled={downloading}
                style={{ width: '100%', padding: '11px' }}
              >
                {downloading ? '⏳ Downloading...' : '💾 Back Up Now'}
              </button>
              <button className="btn btn-outline" onClick={onSkip} style={{ width: '100%' }}>
                Remind me later
              </button>
              <button className="backup-modal-skip" onClick={onDisable}>
                Don't remind me again
              </button>
            </div>
          </>
        )}
        {done && (
          <div className="backup-modal-body" style={{ marginBottom: 0 }}>
            Your database has been saved. Keep it somewhere safe!
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  // ── State ────────────────────────────────────────────
  const [trades,        setTrades]        = useState([]);
  const [lots,          setLots]          = useState([]);
  const [isMock,        setIsMock]        = useState(false);
  const [loading,       setLoading]       = useState(true);
  const [dataLoading,   setDataLoading]   = useState(false);
  const [backendOnline, setBackendOnline] = useState(false);
  const [view,          setView]          = useState('dashboard');
  const [alertsFrom,    setAlertsFrom]    = useState(null); // 'positions' | null — tracks nav context for Alerts back button
  const [positionsFilter, setPositionsFilter] = useState(null);
  const [filterUnhedged,   setFilterUnhedged]   = useState(false); // true = Stock Positions highlights unhedged lots
  const [tradeSearch,      setTradeSearch]      = useState('');
  const [tradeFilterLotId, setTradeFilterLotId] = useState(null);  // lot_id filter when nav from Wheel Summary
  const [tradeInitialFilter, setTradeInitialFilter] = useState('Open'); // 'All' for closed lots, 'Open' default
  const [filterTickers,    setFilterTickers]    = useState(null); // Set of tickers | null = no filter
  const [adjustingCal,     setAdjustingCal]     = useState(null); // { trade, chainTrades }

  // Dark mode — persisted to localStorage, applied as class on <html>
  // Defaults to TRUE (dark) on first launch; respects stored preference thereafter.
  const [darkMode, setDarkMode] = useState(() => {
    try {
      const stored = localStorage.getItem('ott-dark-mode');
      return stored === null ? true : stored === 'true';
    } catch { return true; }
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', darkMode);
    try { localStorage.setItem('ott-dark-mode', darkMode); } catch {}
  }, [darkMode]); // 'all' | 'active-lots' | null

  // Modals
  const [showTradeForm,   setShowTradeForm]   = useState(false);
  const [editTrade,       setEditTrade]       = useState(null);
  const [prefillTrade,    setPrefillTrade]    = useState(null); // pre-seeds new trade form (not edit)
  const [pendingRollTrade,setPendingRollTrade]= useState(null); // trade staged for rolling from Alerts
  const [showLotForm,     setShowLotForm]     = useState(false);
  const [editLot,         setEditLot]         = useState(null);
  const [lotTicker,       setLotTicker]       = useState(null);
  const [showCloseLot,    setShowCloseLot]    = useState(false);
  const [showSplitLot,    setShowSplitLot]    = useState(false);
  const [splittingLot,    setSplittingLot]    = useState(null);
  const [closingLot,      setClosingLot]      = useState(null);
  const [showAssignment,  setShowAssignment]  = useState(false);
  const [assigningTrade,  setAssigningTrade]  = useState(null);
  const [showCalledAway,  setShowCalledAway]  = useState(false);
  const [calledAwayTrade, setCalledAwayTrade] = useState(null);
  const [showCloseTrade,  setShowCloseTrade]  = useState(false);
  const [closingTrade,    setClosingTrade]    = useState(null);
  const [showExpired,     setShowExpired]     = useState(false);
  const [expiredTrade,    setExpiredTrade]    = useState(null);
  const [showImport,      setShowImport]      = useState(false);
  const [showHelp,        setShowHelp]        = useState(false);
  const [showQuickStart,  setShowQuickStart]  = useState(false);
  const [historicalMode,  setHistoricalMode]  = useState(false); // resets on restart — for entering past trades
  const [showDataConn,    setShowDataConn]    = useState(false);
  const [showFirstLaunch, setShowFirstLaunch] = useState(false);

  // Backup
  const [showBackupModal,  setShowBackupModal]  = useState(false);
  const [backupReminder,   setBackupReminder]   = useState(true);
  const [lastBackup,       setLastBackup]       = useState(null);
  const [backupDownloading, setBackupDownloading] = useState(false);
  const [showClearConfirm,  setShowClearConfirm]  = useState(false);
  const [clearingData,      setClearingData]      = useState(false);

  // Live data (broker feed OR Yahoo fallback OR manual entry — all merge into currentPrices)
  const [currentPrices,   setCurrentPrices]  = useState(() => {
    // Restore manually-entered prices from localStorage on mount
    try {
      const saved = localStorage.getItem('ott-manual-prices');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const [liveStatus,      setLiveStatus]     = useState({ status: 'grey', label: 'No broker connected' });
  const [yahooStatus,     setYahooStatus]    = useState({ status: 'idle' }); // idle | loading | partial | done | failed
  const [pricesUpdatedAt, setPricesUpdatedAt] = useState(null); // timestamp of last price fetch

  // ── Load real data ────────────────────────────────────
  const loadRealData = useCallback(async () => {
    try {
      const [tr, lo] = await Promise.all([
        fetch(getBase() + '/api/trades'),
        fetch(getBase() + '/api/lots'),
      ]);
      if (tr.status === 402 || lo.status === 402) {
        setBackendOnline(false); setTrades([]); setLots([]); return;
      }
      if (!tr.ok || !lo.ok) throw new Error('not ok');
      const [tData, lData] = await Promise.all([tr.json(), lo.json()]);
      setTrades(tData);
      setLots(lData);
      setBackendOnline(true);
    } catch {
      setBackendOnline(false); setTrades([]); setLots([]);
    }
  }, []);

  // ── Init ──────────────────────────────────────────────
  useEffect(() => {
    async function init() {
      setLoading(true);
      // Always start in Demo Mode regardless of backend status
      setTrades(getDemoTrades());
      setLots(getDemoLots());
      setIsMock(true);
      // Try backend in background (for settings/polling config only)
      try {
        const h = await fetch(getBase() + '/health');
        if (h.ok || h.status === 402) {
          setBackendOnline(true);
          // Check settings for first launch / polling
          try {
            const s = await fetch(getBase() + '/api/settings');
            if (s.ok) {
              const settings = await s.json();
              if (!settings.firstLaunchDone) setShowFirstLaunch(true);
              else if (settings.provider && settings.provider !== 'none') {
                startPolling(settings.provider, settings.apiKey, {
                  schwabClientId:     settings.schwabClientId     || '',
                  schwabClientSecret: settings.schwabClientSecret || '',
                });
              }
            }
          } catch {}
        }
      } catch {}
      setLoading(false);
    }
    init();
  }, []);

  // ── Yahoo Finance auto-fetch ───────────────────────────────
  // Runs when: no live broker connected AND user clicks "Refresh Prices"
  // OR automatically on first load if no broker is configured.
  // Falls back gracefully — any failure is silent, user can still enter manually.
  const fetchYahooForOpenTrades = useCallback(async () => {
    const openTrades = trades.filter(t => t.status === 'open');
    if (openTrades.length === 0) return;

    // Check if MarketData.app is configured as the data provider
    let mdToken = null;
    try {
      const s = await fetch(getBase() + '/api/settings');
      if (s.ok) {
        const settings = await s.json();
        if (settings.provider === 'marketdata' && settings.apiKey) {
          mdToken = settings.apiKey;
        }
      }
    } catch { /* backend not available — fall through to Yahoo */ }

    const sourceName = mdToken ? 'MarketData.app' : 'Yahoo Finance';
    setYahooStatus({ status: 'loading', message: `Fetching prices via ${sourceName}...` });

    try {
      let prices = {};
      if (mdToken) {
        prices = await fetchMarketDataPrices(openTrades, mdToken, ({ done, total, stage }) => {
          setYahooStatus({ status: 'loading', message: `${stage === 'stocks' ? 'Stock' : 'Option'} prices: ${done}/${total}` });
        });
      } else {
        prices = await fetchYahooPrices(openTrades, ({ done, total, stage }) => {
          setYahooStatus({ status: 'loading', message: `${stage === 'stocks' ? 'Stock' : 'Option'} prices: ${done}/${total}` });
        });
      }

      if (Object.keys(prices).length === 0) {
        setYahooStatus({ status: 'failed', message: `${sourceName} unavailable. Enter prices manually.` });
        return;
      }

      const openTradeIds = new Set(openTrades.map(t => String(t.id)));
      const openTickers  = new Set(openTrades.map(t => t.ticker.toUpperCase()));

      setCurrentPrices(prev => {
        const next = { ...prev };
        Object.entries(prices).forEach(([key, val]) => {
          // Only write prices for open trade IDs or open tickers — never for closed trades
          if (openTradeIds.has(String(key)) || openTickers.has(String(key).toUpperCase())) {
            next[key] = { ...(next[key] || {}), ...val };
          }
        });
        try { localStorage.setItem('ott-manual-prices', JSON.stringify(next)); } catch {}
        return next;
      });
      setPricesUpdatedAt(new Date());

      const optionCount = openTrades.filter(t => prices[t.id]?.option != null).length;
      const stockCount  = [...new Set(openTrades.map(t => t.ticker))].filter(tk => prices[tk.toUpperCase()]?.stock != null).length;

      if (optionCount < openTrades.length) {
        setYahooStatus({
          status: 'partial',
          message: `${sourceName}: ${stockCount} stock price${stockCount!==1?'s':''} · ${optionCount}/${openTrades.length} option prices fetched. Enter missing prices manually.`,
        });
      } else {
        setYahooStatus({ status: 'done', message: `All prices refreshed via ${sourceName}.` });
      }
    } catch {
      setYahooStatus({ status: 'failed', message: `Could not reach ${sourceName}. Enter prices manually.` });
    }
  }, [trades]);


  // ── Purge stale prices for closed trades ──────────────
  // When trades load/change, remove any currentPrices entries for closed trade IDs.
  // This prevents stale localStorage prices from showing on closed positions.
  useEffect(() => {
    if (!trades.length) return;
    const closedIds = new Set(
      trades.filter(t => t.status === 'closed').map(t => String(t.id))
    );
    if (!closedIds.size) return;
    setCurrentPrices(prev => {
      const next = { ...prev };
      let changed = false;
      closedIds.forEach(id => { if (next[id]) { delete next[id]; changed = true; } });
      if (changed) {
        try { localStorage.setItem('ott-manual-prices', JSON.stringify(next)); } catch {}
      }
      return changed ? next : prev;
    });
  }, [trades]);
  // Automatically fetches Yahoo Finance stock + option prices after the app
  // loads so Close-Out P&L is populated without manual action.
  // Only runs once per session. Skips if broker is already providing live prices.
  const autoFetchDone = React.useRef(false);
  const autoFetchMode = React.useRef(null); // track which mode triggered the fetch
  useEffect(() => {
    // Reset if mode changed (demo ↔ live switch) so live mode gets its own auto-fetch
    if (autoFetchMode.current !== null && autoFetchMode.current !== isMock) {
      autoFetchDone.current = false;
    }
    if (autoFetchDone.current) return;
    if (loading) return;
    if (liveStatus?.status === 'green' || liveStatus?.status === 'blue') return;
    const openCount = trades.filter(t => t.status === 'open').length;
    if (openCount === 0) return;
    autoFetchDone.current = true;
    autoFetchMode.current = isMock;
    const timer = setTimeout(() => { fetchYahooForOpenTrades(); }, 1500);
    return () => clearTimeout(timer);
  }, [loading, trades, liveStatus, isMock, fetchYahooForOpenTrades]);

  // ── Post-save auto price refresh ─────────────────────
  // Triggered at the end of every handler that modifies trades or lots.
  // Debounced 2 s so burst operations (IC/Cal multi-record adjustments) collapse
  // into a single fetch. Skips entirely when a broker is streaming live prices.
  const postSaveTimerRef = useRef(null);
  const postSaveRefresh = useCallback(() => {
    if (liveStatus?.status === 'green' || liveStatus?.status === 'blue') return;
    if (postSaveTimerRef.current) clearTimeout(postSaveTimerRef.current);
    postSaveTimerRef.current = setTimeout(() => { fetchYahooForOpenTrades(); }, 2000);
  }, [liveStatus, fetchYahooForOpenTrades]);

  // ── Live data polling ─────────────────────────────────
  const pollingRef = useRef(null);

  // ── Manual price update (lifted from TradeLog) ────────────
  // Called when user types in Opt$/Stock$ inputs in TradeLog.
  // Merges into currentPrices so Dashboard, Alerts, and all
  // other views see the price immediately.
  // Also persists to localStorage so prices survive page reload.
  const handlePriceUpdate = useCallback((tradeId, ticker, update) => {
    setCurrentPrices(prev => {
      const next = { ...prev };
      // Per-trade prices (option price, greeks)
      if (tradeId) {
        next[tradeId] = { ...(next[tradeId] || {}), ...update };
      }
      // Per-ticker stock price (shared across all trades for that ticker)
      if (ticker && update.stock != null) {
        next[ticker.toUpperCase()] = { ...(next[ticker.toUpperCase()] || {}), stock: update.stock };
        // Also propagate to all other trades for this ticker
        Object.keys(next).forEach(key => {
          if (next[key]?.ticker === ticker.toUpperCase() || next[ticker.toUpperCase()]) {
            // stock price is already on the ticker key — TradeLog getStkPrice checks both
          }
        });
      }
      // Persist to localStorage (only save manual/yahoo prices, not the whole live feed)
      try { localStorage.setItem('ott-manual-prices', JSON.stringify(next)); } catch {}
      return next;
    });
    setPricesUpdatedAt(new Date());
  }, []);

  // Bug fix: wrap in useCallback so startPolling/fetchLivePrices always reference
  // the latest setters without creating stale closures when called from useEffect.
  const fetchLivePrices = useCallback(async (provider, apiKey, schwabCreds) => {
    try {
      const mktRes = await fetch(getBase() + '/api/live/market-status');
      if (mktRes.ok) {
        const mkt = await mktRes.json();
        if (!mkt.is_open) { setLiveStatus({ status: 'grey', label: 'Market closed' }); return; }
      }
      setLiveStatus({ status: 'blue', label: 'Updating...' });
      const res = await fetch(getBase() + '/api/live/prices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          apiKey,
          schwabClientId:     schwabCreds?.schwabClientId     || '',
          schwabClientSecret: schwabCreds?.schwabClientSecret || '',
        }),
      });
      if (res.status === 429) { setLiveStatus({ status: 'grey', label: 'Rate limited' }); return; }
      if (!res.ok) { setLiveStatus({ status: 'red', label: 'Data error' }); return; }
      const prices = await res.json();
      setCurrentPrices(prices);
      const label = provider === 'tradier' ? 'Tradier live' : provider === 'schwab' ? 'Schwab live' : 'Polygon live';
      setLiveStatus({ status: 'green', label });
    } catch {
      setLiveStatus({ status: 'red', label: 'Data error' });
    }
  }, []);

  const startPolling = useCallback((provider, apiKey, schwabCreds) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    if (!provider || provider === 'none') return;
    // MarketData.app: client-side fetch — no backend polling needed
    // It plugs into the Yahoo fetch button — auto-fetch on load is handled separately
    if (provider === 'marketdata') {
      setLiveStatus({ status: 'grey', label: 'MarketData.app ready' });
      return;
    }
    const interval = provider === 'tradier' || provider === 'schwab' ? 30000 : 60000;
    fetchLivePrices(provider, apiKey, schwabCreds);
    pollingRef.current = setInterval(() => fetchLivePrices(provider, apiKey, schwabCreds), interval);
  }, [fetchLivePrices]);

  // Bug fix: clean up polling interval on unmount to prevent memory leaks
  // and double-firing in React StrictMode dev.
  useEffect(() => {
    return () => { if (pollingRef.current) clearInterval(pollingRef.current); };
  }, []);

  // ── Backup status + monthly reminder check ────────────
  useEffect(() => {
    async function loadBackupStatus() {
      try {
        const res  = await fetch(getBase() + '/api/backup/status');
        if (!res.ok) return;
        const data = await res.json();
        setBackupReminder(data.backupReminder !== false);
        setLastBackup(data.lastBackup || null);

        // Fire reminder on the last day of the month if:
        // 1. Reminder is enabled
        // 2. It's the last day of the current month
        // 3. It's been more than 25 days since last backup (or never backed up)
        if (data.backupReminder === false) return;
        const now      = new Date();
        const lastDay  = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const isLastDay = now.getDate() === lastDay;
        if (!isLastDay) return;
        if (data.lastBackup) {
          const daysSince = (Date.now() - new Date(data.lastBackup).getTime()) / 86400000;
          if (daysSince < 25) return; // Already backed up recently this month
        }
        // Small delay so app is fully loaded before showing modal
        setTimeout(() => setShowBackupModal(true), 3000);
      } catch {}
    }
    loadBackupStatus();
  }, []);

  // ── Enriched trades ───────────────────────────────────
  const enrichedTrades = useMemo(() => trades.map(trade => {
    const lot      = trade.lot_id ? lots.find(l => l.id === trade.lot_id) : null;
    // FIX LOW: fallback to open lots only — closed lots have wrong avg_cost for current positions
    const fallback = !lot ? lots.find(l => l.ticker === trade.ticker && !l.close_date) : null;
    return { ...trade, stock_buy_price: (lot || fallback)?.avg_cost ?? null };
  }), [trades, lots]);

  // ── Stats ─────────────────────────────────────────────
  // Broker is connected when live polling is actively returning green status
  const isBrokerConnected = !isMock && liveStatus?.status === 'green';

  const stats = useMemo(() => {
    // IC chain legs (condor_chain_id set) and Calendar chain legs (cal_chain_id set)
    // are tracked as chains — exclude from individual win/loss/winRate counts to avoid
    // double-counting. But bestTrade and worstTrade INCLUDE chain outcomes — a trader
    // needs to know their actual best and worst results regardless of strategy structure.
    const stdTrades = trades.filter(t => !t.condor_chain_id && t.cal_chain_id == null);
    const closed = stdTrades.filter(t => t.status === 'closed' && t.pnl !== null);
    const wins   = closed.filter(t => t.pnl > 0);
    const losses = closed.filter(t => t.pnl < 0);
    // totalPnl: assignment-aware realised P&L — same logic as closedSum in Dashboard.jsx.
    // For assigned CSPs and called-away CCs (pnl=0), add the real premium collected.
    // Also adds closed lot share gains (close_price − avg_cost) × shares.
    const totalPnl = (() => {
      // Uses identical formula to Dashboard closedPnl + realisedBreakdown
      // so tile always matches breakdown total.
      const allClosed = trades.filter(t => t.status === 'closed' && t.pnl != null);
      const optionPnl = allClosed.reduce((s, t) => {
        if (t.pnl !== 0 && t.pnl != null) return s + t.pnl;
        const entry = parseFloat(t.entry_price) || 0;
        const exitP = parseFloat(t.exit_price)  || 0;
        const skb   = parseFloat(t.strike_buy)  || 0;
        const sks   = parseFloat(t.strike_sell) || 0;
        const c     = t.contracts || 1;
        const isCSPAssign    = t.strategy === 'Cash-Secured Put' &&
          (exitP === entry || (skb > 0 && exitP === skb));
        const isCCCalledAway = t.strategy === 'Covered Call' &&
          sks > 0 && Math.abs(exitP - sks) < 0.01;
        if (isCSPAssign || isCCCalledAway) return s + Math.round(entry * c * 100);
        return s;
      }, 0)
      // Add partial_close_pnl from still-open IC/Cal chain legs
      + trades.reduce((s, t) => {
          if (t.status !== 'open') return s;
          if (!t.condor_chain_id && t.cal_chain_id == null) return s;
          return s + (t.partial_close_pnl || 0);
        }, 0);
      const sharePnl = (lots || [])
        .filter(l => l.close_date && l.close_price != null)
        .reduce((s, l) => {
          const calledAwayCC = allClosed.find(t =>
            t.lot_id === l.id && t.strategy === 'Covered Call' &&
            t.pnl != null && t.pnl !== 0 &&
            Math.abs(parseFloat(t.exit_price) - parseFloat(l.close_price)) < 0.01
          );
          if (calledAwayCC) {
            const premiumOnly = Math.round((parseFloat(calledAwayCC.entry_price) || 0) * (calledAwayCC.contracts || 1) * 100);
            if (calledAwayCC.pnl > premiumOnly * 1.5) return s;
          }
          const gain = Math.round((parseFloat(l.close_price) - parseFloat(l.avg_cost)) * parseFloat(l.shares));
          return s + (isNaN(gain) ? 0 : gain);
        }, 0);
      return optionPnl + sharePnl;
    })();
    const winRate      = closed.length ? (wins.length / closed.length * 100) : 0;
    const avgWin       = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss      = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
    const profitFactor = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : (avgWin > 0 ? 999 : 0);

    // ── Best / Worst trade — includes chain outcomes ─────────────────
    // Compute chain-level P&L by summing all closed legs per chain ID.
    // Then compare against individual trade P&Ls for true best/worst.
    const icChainPnl = {};
    trades.filter(t => t.condor_chain_id && t.status === 'closed' && t.pnl !== null)
          .forEach(t => { icChainPnl[t.condor_chain_id] = (icChainPnl[t.condor_chain_id] || 0) + (t.pnl || 0) + (t.partial_close_pnl || 0); });
    const calChainPnl = {};
    trades.filter(t => t.cal_chain_id != null && t.status === 'closed' && t.pnl !== null)
          .forEach(t => { calChainPnl[t.cal_chain_id] = (calChainPnl[t.cal_chain_id] || 0) + (t.pnl || 0) + (t.partial_close_pnl || 0); });
    // Only count chains where ALL legs are closed (complete outcome)
    const closedIcChains  = Object.values(icChainPnl);
    const closedCalChains = Object.values(calChainPnl);
    const allOutcomes = [
      ...closed.map(t => t.pnl),
      ...closedIcChains,
      ...closedCalChains,
    ];
    const bestTrade  = allOutcomes.length ? Math.max(...allOutcomes) : 0;
    const worstTrade = allOutcomes.length ? Math.min(...allOutcomes) : 0;
    // Win streak — count consecutive wins/losses from most recent standard trade
    let streak = 0, streakType = 'win';
    if (closed.length > 0) {
      const sorted = [...closed].sort((a, b) => new Date(b.exit_date) - new Date(a.exit_date));
      streakType = sorted[0].pnl >= 0 ? 'win' : 'loss';
      for (const t of sorted) {
        if ((t.pnl >= 0) === (streakType === 'win')) streak++;
        else break;
      }
    }
    // ── Three dashboard buckets ──────────────────────────────────────
    // Bucket 1 — Wheel Positions: open lot + active option on that lot
    const wheelTrades = trades.filter(t =>
      t.status === 'open' && t.lot_id != null &&
      !t.condor_chain_id && t.cal_chain_id == null
    ).length;

    // Bucket 2 — Unhedged Shares: OPEN lots with NO active option linked to them.
    // Closed lots are excluded — they're done, not actionable.
    const openLotIds = new Set(
      trades.filter(t => t.status === 'open' && t.lot_id != null).map(t => t.lot_id)
    );
    const unhedgedLots = lots.filter(l => !l.close_date && !openLotIds.has(l.id)).length;

    // Bucket 3 — Standalone Trades: no share ownership (CSPs awaiting assignment,
    // spreads, long options) + IC/Cal chains each counted as 1
    const standalonesolo = trades.filter(t =>
      t.status === 'open' && t.lot_id == null &&
      !t.condor_chain_id && t.cal_chain_id == null
    ).length;
    const standaloneChains = new Set(
      trades.filter(t =>
        t.status === 'open' && t.lot_id == null &&
        (t.condor_chain_id || t.cal_chain_id)
      ).map(t => t.condor_chain_id || t.cal_chain_id)
    ).size;
    const standaloneTrades = standalonesolo + standaloneChains;

    return { totalPnl,
      openTrades: trades.filter(t => t.status === 'open' && !t.condor_chain_id && t.cal_chain_id == null).length,
      wheelTrades, unhedgedLots, standaloneTrades,
      closedTrades: closed.length, winRate, avgWin, avgLoss, profitFactor, bestTrade, worstTrade, streak, streakType };
  }, [trades, lots, isMock]);

  // ── Ticker sets for dashboard tile navigation ─────────────────
  // Computes which tickers belong to each bucket so clicking a tile
  // opens Trade Log pre-filtered to only the relevant tickers.
  const bucketTickers = useMemo(() => {
    const openLotIds = new Set(
      trades.filter(t => t.status === 'open' && t.lot_id != null).map(t => t.lot_id)
    );
    const wheelSet = new Set(
      trades.filter(t => t.status === 'open' && t.lot_id != null && !t.condor_chain_id && t.cal_chain_id == null)
            .map(t => t.ticker)
    );
    const standaloneSet = new Set(
      trades.filter(t => t.status === 'open' && t.lot_id == null)
            .map(t => t.ticker)
    );
    const unhedgedSet = new Set(
      lots.filter(l => !l.close_date && !openLotIds.has(l.id)).map(l => l.ticker)
    );
    return { wheelSet, standaloneSet, unhedgedSet };
  }, [trades, lots]);
  // A lot with 250 shares and a 2-contract CC covers only 200 shares — 50 are unhedged.
  // Both fully uncovered and partially covered show in the sidebar badge and positions alert.
  const uncoveredCount = useMemo(() => {
    const openLots = lots.filter(l => normLot(l).close_date === null);
    return openLots.filter(lot => {
      const openCCs = trades.filter(t =>
        t.lot_id === lot.id &&
        t.status === 'open' &&
        t.strategy === 'Covered Call'
      );
      if (openCCs.length === 0) return true; // fully uncovered
      // Check if total contracts × 100 covers all shares
      const coveredShares = openCCs.reduce((s, t) => s + (t.contracts || 1) * 100, 0);
      return coveredShares < (lot.shares || 0); // partially uncovered
    }).length;
  }, [lots, trades]);

  // ── API helpers ───────────────────────────────────────
  const apiPost   = async (url, d) => { try { const r = await fetch(getBase()+url, { method:'POST',   headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) }); if (!r.ok) return null; const text = await r.text(); return text ? JSON.parse(text) : null; } catch { return null; } };
  const apiPut    = async (url, d) => { try { const r = await fetch(getBase()+url, { method:'PUT',    headers:{'Content-Type':'application/json'}, body:JSON.stringify(d) }); if (!r.ok) return null; const text = await r.text(); return text ? JSON.parse(text) : null; } catch { return null; } };
  const apiDelete = async (url)    => { try { const r = await fetch(getBase()+url, { method:'DELETE' }); return r.ok; } catch { return false; } };

  // ── Trade CRUD ────────────────────────────────────────
  const handleAddTrade = () => { setEditTrade(null); setPrefillTrade(null); setShowTradeForm(true); };

  // Context-aware CC launch from Stock Positions lot card.
  // Pre-seeds ticker, strategy, and lot_id so TradeForm opens ready to go
  // and the recommendation strip fires immediately (spot from currentPrices or lot avg_cost).
  const handleWriteCC = (lot) => {
    setEditTrade(null); // ensure no stale edit state
    setPrefillTrade({
      ticker:   lot.ticker,
      strategy: 'Covered Call',
      lot_id:   lot.id,
      // deliberately no expiration/strike/price — these come from recommendations or trader input
    });
    setShowTradeForm(true);
  };

  const handleSaveTrade = async (data) => {
    // Pass historical_mode to backend so it can skip past-expiry validation
    data = { ...data, historical_mode: historicalMode };
    if (isMock) {
      if (data.id) {
        setTrades(prev => prev.map(t => t.id === data.id ? { ...t, ...data } : t));
      } else {
        const newId = getNextDemoTradeId();
        const newTrade = {
          ...data, id: newId, roll_count: 0, roll_parent_id: null,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        };
        // IC: create two separate leg records (put wing + call wing)
        if ((data.strategy === 'Iron Condor' || data.strategy === 'Iron Butterfly') && data._icLegs) {
          const chainId = newId;
          const ctr     = data.contracts || 1;
          const putLeg  = data._icLegs.put;
          const callLeg = data._icLegs.call;
          const seedLeg = (legName, strikes, credit, legId) => ({
            ...data,
            id:                legId,
            entry_price:       credit,
            strike_buy:        strikes.strike_buy,
            strike_sell:       strikes.strike_sell,
            condor_chain_id:   chainId,
            condor_leg:        legName,
            condor_seq:        0,
            contracts_original: ctr,
            contracts_open:    ctr,
            contracts_closed:  0,
            partial_close_pnl: 0,
            roll_count:        0,
            roll_parent_id:    null,
            created_at:        new Date().toISOString(),
            updated_at:        new Date().toISOString(),
            _icLegs:           undefined,
          });
          const putId  = newId;
          const callId = getNextDemoTradeId();
          setTrades(prev => [
            ...prev,
            seedLeg('put',  putLeg,  putLeg.entry_price,  putId),
            seedLeg('call', callLeg, callLeg.entry_price, callId),
          ]);
        } else if (data.strategy === 'Calendar Spread' || data.strategy === 'Diagonal Spread') {
          // Cal/Diagonal: create short leg + long leg as a chain
          const chainId = newId;
          const ctr     = data.contracts || 1;
          const shortId = newId;
          const longId  = getNextDemoTradeId();
          const shortCredit = parseFloat(data.cal_short_credit) || 0;
          const longCost    = parseFloat(data.cal_long_cost)    || 0;
          const seedCalLeg = (legType, legId) => ({
            ...data,
            id:                 legId,
            cal_chain_id:       chainId,
            cal_leg:            legType,
            cal_seq:            0,
            status:             'open',
            // Short leg: front month expiry, no back expiry. Long leg: back month expiry, no back expiry field needed.
            expiration:         legType === 'short' ? data.expiration : (data.expiration_back || data.expiration),
            expiration_back:    null,
            // Per-leg entry price: short leg stores the credit received; long leg stores the cost paid
            entry_price:        legType === 'short' ? shortCredit : longCost,
            strike_sell:        legType === 'short' ? (data.strike_sell || data.strike_buy) : null,
            strike_buy:         legType === 'long'  ? (data.strike_buy  || data.strike_sell) : null,
            contracts_original: ctr,
            contracts_open:     ctr,
            contracts_closed:   0,
            partial_close_pnl:  0,
            roll_count:         0,
            roll_parent_id:     null,
            pnl:                null,
            exit_price:         null,
            exit_date:          null,
            created_at:         new Date().toISOString(),
            updated_at:         new Date().toISOString(),
            _icLegs:            undefined,
            cal_short_credit:   undefined,
            cal_long_cost:      undefined,
          });
          setTrades(prev => [
            ...prev,
            seedCalLeg('short', shortId),
            seedCalLeg('long',  longId),
          ]);
        } else {
          if (data.strategy === 'Iron Condor') {
            // fallback: no _icLegs — old 'full' path (edit/import)
            newTrade.condor_chain_id   = newId;
            newTrade.condor_leg        = 'full';
            newTrade.condor_seq        = 0;
            newTrade.contracts_original = data.contracts || 1;
            newTrade.contracts_open    = data.contracts || 1;
            newTrade.contracts_closed  = 0;
            newTrade.partial_close_pnl = 0;
          }
          setTrades(prev => [...prev, newTrade]);
        }
      }
    } else {
      if (data.id) {
        await apiPut(`/api/trades/${data.id}`, data);
      } else {
        // IC: create put leg first (its id becomes condor_chain_id), then call leg
        if ((data.strategy === 'Iron Condor' || data.strategy === 'Iron Butterfly') && data._icLegs) {
          const ctr     = data.contracts || 1;
          const putLeg  = data._icLegs.put;
          const callLeg = data._icLegs.call;
          // Insert put leg first — its id becomes the chain id
          const putBase = { ...data, entry_price: putLeg.entry_price,
            strike_buy: putLeg.strike_buy, strike_sell: putLeg.strike_sell,
            _icLegs: undefined };
          const putCreated = await apiPost('/api/trades', putBase);
          if (putCreated?.id) {
            const chainId = putCreated.id;
            await apiPut(`/api/trades/${putCreated.id}`, { ...putBase,
              condor_chain_id: chainId, condor_leg: 'put', condor_seq: 0,
              contracts_original: ctr, contracts_open: ctr, contracts_closed: 0, partial_close_pnl: 0 });
            // Insert call leg with same chain_id
            const callBase = { ...data, entry_price: callLeg.entry_price,
              strike_buy: callLeg.strike_buy, strike_sell: callLeg.strike_sell,
              _icLegs: undefined };
            const callCreated = await apiPost('/api/trades', callBase);
            if (callCreated?.id) {
              await apiPut(`/api/trades/${callCreated.id}`, { ...callBase,
                condor_chain_id: chainId, condor_leg: 'call', condor_seq: 0,
                contracts_original: ctr, contracts_open: ctr, contracts_closed: 0, partial_close_pnl: 0 });
            }
          }
        } else if (data.strategy === 'Calendar Spread' || data.strategy === 'Diagonal Spread') {
          // Cal/Diagonal: insert short leg first (its id becomes cal_chain_id), then long leg
          const ctr         = data.contracts || 1;
          const shortCredit = parseFloat(data.cal_short_credit) || 0;
          const longCost    = parseFloat(data.cal_long_cost)    || 0;
          const shortBase = {
            ...data, _icLegs: undefined, cal_short_credit: undefined, cal_long_cost: undefined,
            expiration:      data.expiration,
            expiration_back: null,
            entry_price:     shortCredit,
            strike_sell:     data.strike_sell || data.strike_buy,
            strike_buy:      null,
            cal_leg: 'short', cal_seq: 0,
            contracts_original: ctr, contracts_open: ctr, contracts_closed: 0, partial_close_pnl: 0,
            pnl: null, exit_price: null, exit_date: null,
          };
          const shortCreated = await apiPost('/api/trades', shortBase);
          if (shortCreated?.id) {
            const chainId = shortCreated.id;
            await apiPut(`/api/trades/${shortCreated.id}`, { ...shortBase, cal_chain_id: chainId });
            const longBase = {
              ...data, _icLegs: undefined, cal_short_credit: undefined, cal_long_cost: undefined,
              expiration:      data.expiration_back || data.expiration,
              expiration_back: null,
              entry_price:     longCost,
              strike_buy:      data.strike_buy || data.strike_sell,
              strike_sell:     null,
              cal_leg: 'long', cal_seq: 0, cal_chain_id: chainId,
              contracts_original: ctr, contracts_open: ctr, contracts_closed: 0, partial_close_pnl: 0,
              pnl: null, exit_price: null, exit_date: null,
            };
            await apiPost('/api/trades', longBase);
          }
        } else {
          // Non-IC or legacy 'full' path (edit/import)
          const created = await apiPost('/api/trades', data);
          if (data.strategy === 'Iron Condor' && created?.id) {
            await apiPut(`/api/trades/${created.id}`, {
              ...data, condor_chain_id: created.id, condor_leg: 'full', condor_seq: 0,
              contracts_original: data.contracts || 1, contracts_open: data.contracts || 1,
              contracts_closed: 0, partial_close_pnl: 0,
            });
          }
        }
      }
      await loadRealData();
    }
    clearStockCache(data?.ticker ? [data.ticker] : []);
    postSaveRefresh();
    setShowTradeForm(false);
    setEditTrade(null);
    setPrefillTrade(null);
  };

  const handleDeleteTrade = async (id) => {
    if (!window.confirm('Delete this trade?')) return;
    const t = trades.find(tr => tr.id === id);
    if (isMock) { setTrades(prev => prev.filter(t => t.id !== id)); }
    else { await apiDelete(`/api/trades/${id}`); await loadRealData(); }
    clearStockCache(t?.ticker ? [t.ticker] : []);
    postSaveRefresh();
  };

  // ── Delete entire IC or Calendar chain ───────────────
  // Removes ALL leg records sharing the same condor_chain_id or cal_chain_id.
  const handleDeleteChain = async ({ chainIds, ticker, type }) => {
    const legCount = chainIds.length;
    const label = type === 'ic' ? 'IC/IB chain' : 'Calendar chain';
    if (!window.confirm(`Delete this ${label}? This will remove all ${legCount} leg records and cannot be undone.`)) return;
    if (isMock) {
      setTrades(prev => prev.filter(t => !chainIds.includes(t.id)));
    } else {
      for (const id of chainIds) {
        await apiDelete(`/api/trades/${id}`);
      }
      await loadRealData();
    }
    clearStockCache(ticker ? [ticker] : []);
    postSaveRefresh();
  };

  const handleEditTrade = (trade) => { setEditTrade(trade); setPrefillTrade(null); setShowTradeForm(true); };

  // ── Roll ──────────────────────────────────────────────
  const DEBIT_STRATEGIES_ROLL = new Set([
    'Long Call','Long Put','Bull Call Spread','Bear Put Spread',
    'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread'
  ]);

  const handleRoll = async ({ original, exitPrice, exitDate, newData, rollContracts }) => {
    // rollContracts: how many contracts to roll. Defaults to all if not specified.
    // Allows partial rolls: trader closes 3 of 5 contracts and rolls just those 3.
    const totalContracts = original.contracts || 1;
    const nRoll   = Math.min(rollContracts || totalContracts, totalContracts);
    const nRemain = totalContracts - nRoll;

    // P&L direction: credit strategies profit when exit < entry; debit when exit > entry.
    const isDebitStrat = DEBIT_STRATEGIES_ROLL.has(original.strategy);
    const closePnl = isDebitStrat
      ? (exitPrice - original.entry_price) * nRoll * 100   // debit: profit when exit > entry
      : (original.entry_price - exitPrice) * nRoll * 100;  // credit: profit when exit < entry

    const closedOriginal = {
      ...original,
      status:     nRemain > 0 ? 'open' : 'closed',  // keep open if partial roll
      exit_date:  nRemain > 0 ? null  : exitDate,
      exit_price: nRemain > 0 ? null  : exitPrice,
      contracts:  nRemain > 0 ? nRemain : original.contracts,
      pnl:        nRemain > 0 ? null  : closePnl,
      notes:      nRemain > 0
        ? `Partially rolled ${nRoll} of ${totalContracts} contracts. ${nRemain} remaining open.`
        : original.notes,
    };

    // FIX #8: Estimate greeks on the new (rolled) trade so alerts fire immediately.
    // Use the original trade's IV and the Black-Scholes formula to compute delta.
    // Other greeks are approximated or carried forward; IV is inherited from original.
    const estimateRolledGreeks = () => {
      const iv    = original.iv_entry ? original.iv_entry / 100 : 0.30;
      const newK  = parseFloat(newData.strike_sell || newData.strike_buy || original.strike_sell || original.strike_buy) || 0;
      const today = new Date();
      const expD  = newData.expiration ? new Date(newData.expiration) : new Date(today.getTime() + 45 * 86400000);
      const T     = Math.max(0.001, (expD - today) / (365 * 86400000));
      const r     = 0.053;
      const isCall = ['Covered Call','Bear Call Spread','Bull Call Spread'].includes(original.strategy);
      // Use original stock price proxy: strike ± 2% as neutral starting point
      const S = newK * (isCall ? 0.97 : 1.03);
      if (!newK || iv <= 0 || T <= 0) return {};
      // Simple delta approximation using normal CDF approximation
      const d1 = (Math.log(S / newK) + (r + 0.5 * iv * iv) * T) / (iv * Math.sqrt(T));
      const ndCdf = x => 0.5 * (1 + Math.sign(x) * Math.sqrt(1 - Math.exp(-2 * x * x / Math.PI)));
      const deltaRaw = isCall ? ndCdf(d1) : ndCdf(d1) - 1;
      const delta = Math.round(deltaRaw * 1000) / 1000;
      // Theta: approximate as -IV × entry_price / (2 × sqrt(365 × T × 365))
      const theta = Math.round(-(iv * (newData.entry_price || original.entry_price || 1)) / (2 * Math.sqrt(365 * T)) * 1000) / 1000;
      return { delta, theta, iv_entry: original.iv_entry || null, gamma: null, vega: null };
    };

    const newTrade = {
      ...newData,
      ...estimateRolledGreeks(),
      ticker: original.ticker, lot_id: original.lot_id, contracts: nRoll,
      status: 'open', exit_date: null, exit_price: null, pnl: null,
      roll_parent_id: original.roll_parent_id || original.id,
      roll_count: (original.roll_count || 0) + 1,
      notes: newData.notes || `Rolled from ${original.expiration}`,
    };
    if (isMock) {
      setTrades(prev => prev.map(t => t.id === original.id ? closedOriginal : t).concat({ ...newTrade, id: getNextDemoTradeId() }));
    } else {
      try {
        await apiPut(`/api/trades/${original.id}`, closedOriginal);
        await apiPost('/api/trades', newTrade);
        await loadRealData();
      } catch (e) {
        alert(`Roll failed: ${e.message}\n\nThe original trade may have been partially updated. Please check Trade Log and verify both the closed original and new rolled trade are correct before continuing.`);
        await loadRealData(); // reload to show actual DB state
      }
    }
    // Note: do NOT clearStockCache here — it causes positions to vanish from
    // Analytics See Details before the next price fetch repopulates them.
    // postSaveRefresh (added session 98) fetches fresh prices safely — does not
    // wipe the cache, just triggers a re-fetch after the 2 s debounce.
    postSaveRefresh();
  };

  // ── Iron Condor chain adjust ──────────────────────────
  const handleICAdjust = async (body) => {
    if (isMock) {
      // In mock mode: simulate the adjustment locally
      const chainId = body.chain_id;

      setTrades(prev => {
        let updated = [...prev];
        const chainTrades = updated.filter(t => (t.condor_chain_id || t.id) === chainId);
        const adjType = body.adjustment_type;
        const adjDate = body.date || localDateISO();

        // Helper: close N contracts on a specific leg, return updated trade
        function closeLegContracts(legRecord, nClose, closePx, date) {
          const avail = legRecord.contracts_open || 0;
          // Guard: if leg already fully closed (e.g. double-fire / stale state), return unchanged.
          if (avail <= 0) return legRecord;
          const realN = Math.min(nClose || avail, avail);
          const newOpen   = avail - realN;
          // Cap contracts_closed at contracts_original to prevent double-fire accumulation.
          const maxClosed = legRecord.contracts_original || legRecord.contracts || realN;
          const newClosed = Math.min((legRecord.contracts_closed || 0) + realN, maxClosed);
          const legPnl    = (legRecord.entry_price - closePx) * realN * 100;
          const isFullClose = newOpen <= 0;
          return {
            ...legRecord,
            contracts_open:    newOpen,
            contracts_closed:  newClosed,
            // On full close: absorb all prior partial P&L into pnl, reset partial to 0
            // On partial close: accumulate into partial_close_pnl, leave pnl null
            partial_close_pnl: isFullClose ? 0 : (legRecord.partial_close_pnl || 0) + legPnl,
            exit_price:        isFullClose ? closePx : legRecord.exit_price,
            exit_date:         isFullClose ? date     : legRecord.exit_date,
            status:            isFullClose ? 'closed' : 'open',
            pnl:               isFullClose ? legPnl + (legRecord.partial_close_pnl || 0) : legRecord.pnl,
          };
        }

        // Find most-recent open leg for a given leg side ('put', 'call', 'full', 'both')
        function findOpenLeg(legName) {
          return chainTrades.filter(t =>
            (legName === 'both' || t.condor_leg === legName || t.condor_leg === 'full') &&
            (t.contracts_open || t.contracts || 0) > 0
          ).sort((a,b) => (b.condor_seq||0) - (a.condor_seq||0))[0] || null;
        }

        const numClose = body.contracts_to_close || 0;
        const closePx  = body.close_price || 0;
        const maxSeq   = Math.max(...chainTrades.map(t => t.condor_seq || 0));
        const newConts = body.new_contracts || numClose;

        // Helper: new leg record template
        function makeLeg(source, legName, seq, entryPx, nConts, strikeBuy, strikeSell, expiry, notesStr) {
          return {
            id: getNextDemoTradeId(), ticker: source.ticker, lot_id: null,
            strategy: source.strategy, status: 'open',
            entry_date: adjDate, expiration: expiry,
            entry_price: entryPx,
            exit_price: null, exit_date: null, pnl: null,
            contracts: nConts,
            contracts_original: source.contracts_original ?? source.contracts ?? nConts,
            contracts_open: nConts,
            contracts_closed: 0, partial_close_pnl: 0,
            strike_buy: strikeBuy || null, strike_sell: strikeSell || null,
            delta: null, gamma: null, theta: null, vega: null, iv_entry: null,
            notes: notesStr || `IC adjustment ${adjType}`,
            condor_chain_id: chainId, condor_leg: legName, condor_seq: seq,
            roll_parent_id: null, roll_count: 0,
            created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          };
        }

        if (adjType === 'reduce_both' || adjType === 'reduce_position') {
          // reduce_both (legacy) / reduce_position (new): per-leg contracts + prices
          const putLeg  = findOpenLeg('put');
          const callLeg = findOpenLeg('call') || findOpenLeg('full');
          const putPx   = parseFloat(body.close_put_price)  || closePx;
          const callPx  = parseFloat(body.close_call_price) || closePx;
          // reduce_position supports independent contract counts per leg
          const putN    = adjType === 'reduce_position' ? (parseInt(body.put_contracts_to_close)  || numClose) : numClose;
          const callN   = adjType === 'reduce_position' ? (parseInt(body.call_contracts_to_close) || numClose) : numClose;
          if (putLeg  && putN  > 0) updated = updated.map(t => t.id === putLeg.id  ? closeLegContracts(putLeg,  putN,  putPx,  adjDate) : t);
          if (callLeg && callN > 0) updated = updated.map(t => t.id === callLeg.id ? closeLegContracts(callLeg, callN, callPx, adjDate) : t);

        } else if (adjType === 'take_profit' || adjType === 'close_position') {
          // take_profit (legacy) / close_position (new): close all open legs, per-leg prices
          const putLeg  = findOpenLeg('put');
          const callLeg = findOpenLeg('call') || findOpenLeg('full');
          const putPx   = parseFloat(body.close_put_price)  || closePx;
          const callPx  = parseFloat(body.close_call_price) || closePx;
          if (putLeg)  updated = updated.map(t => t.id === putLeg.id  ? closeLegContracts(putLeg,  putLeg.contracts_open,  putPx,  adjDate) : t);
          if (callLeg) updated = updated.map(t => t.id === callLeg.id ? closeLegContracts(callLeg, callLeg.contracts_open, callPx, adjDate) : t);

        } else if (adjType === 'roll_full') {
          // Close ALL open legs with per-leg buy-back prices, reopen BOTH wings with 4-strike data
          const putLeg  = findOpenLeg('put');
          const callLeg = findOpenLeg('call') || findOpenLeg('full');
          const putPx   = parseFloat(body.close_put_price)  || closePx;
          const callPx  = parseFloat(body.close_call_price) || closePx;
          if (putLeg)  updated = updated.map(t => t.id === putLeg.id  ? closeLegContracts(putLeg,  putLeg.contracts_open,  putPx,  adjDate) : t);
          if (callLeg) updated = updated.map(t => t.id === callLeg.id ? closeLegContracts(callLeg, callLeg.contracts_open, callPx, adjDate) : t);
          if (body.new_expiry) {
            const rollConts = newConts || (putLeg?.contracts_original || callLeg?.contracts_original || 1);
            const src = chainTrades[0];
            updated.push(makeLeg(src, 'put',  maxSeq+1,
              parseFloat(body.roll_full_put_credit)  || 0, rollConts,
              parseFloat(body.roll_full_put_buy)     || null,
              parseFloat(body.roll_full_put_sell)    || null,
              body.new_expiry, body.notes || 'Rolled condor — put wing'));
            updated.push(makeLeg(src, 'call', maxSeq+2,
              parseFloat(body.roll_full_call_credit) || 0, rollConts,
              parseFloat(body.roll_full_call_buy)    || null,
              parseFloat(body.roll_full_call_sell)   || null,
              body.new_expiry, body.notes || 'Rolled condor — call wing'));
          }

        } else {
          // roll_one_leg, reduce_one, roll_resize, close_one — single leg operations
          const openLeg = findOpenLeg(body.leg);
          if (!openLeg) return prev;
          // reduce_one: close N contracts (partial); others: close all open contracts
          const nToClose = adjType === 'reduce_one'
            ? Math.min(numClose || openLeg.contracts_open, openLeg.contracts_open)
            : (openLeg.contracts_open || openLeg.contracts);
          updated = updated.map(t => t.id === openLeg.id
            ? closeLegContracts(openLeg, nToClose, closePx, adjDate) : t);
          // roll_one_leg / roll_resize: create new rolled leg
          if (['roll_one_leg','roll_resize'].includes(adjType) && body.new_expiry && body.new_premium) {
            const rConts = adjType === 'roll_resize'
              ? (parseInt(body.new_contracts) || nToClose)
              : openLeg.contracts_open || openLeg.contracts;
            // IB: sell strike (ATM body) must always equal the original leg's strike_sell.
            // new_strike_sell may be null if the modal sent it as readOnly/empty — fall back to openLeg.strike_sell.
            const resolvedStrikeSell = parseFloat(body.new_strike_sell) ||
              (openLeg.strategy === 'Iron Butterfly' ? parseFloat(openLeg.strike_sell) || null : null);
            updated.push(makeLeg(openLeg, body.leg, maxSeq+1,
              parseFloat(body.new_premium), rConts,
              parseFloat(body.new_strike_buy)  || null,
              resolvedStrikeSell,
              body.new_expiry, body.notes));
          }
        }
        return updated;
      });
    } else {
      const res = await fetch(getBase() + '/api/trades/ic-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Adjustment failed');
      }
      await loadRealData();
    }
    clearStockCache(trades.find(t => t.condor_chain_id === body.chain_id)?.ticker
      ? [trades.find(t => t.condor_chain_id === body.chain_id).ticker] : []);
    postSaveRefresh();
  };
  // ── Calendar Spread chain adjust ──────────────────────
  const handleCalAdjust = async (body) => {
    const chainId = body.chain_id;
    if (isMock) {
      setTrades(prev => {
        let updated = [...prev];
        const chainTrades = updated.filter(t => (t.cal_chain_id || t.id) === chainId);
        const adj      = body.adjustment_type;
        const adjDate  = body.date || localDateISO();
        const maxSeq   = Math.max(...chainTrades.map(t => t.cal_seq || 0));

        const findLeg = (legType) => chainTrades
          .filter(t => t.cal_leg === legType && t.status === 'open')
          .sort((a,b) => (b.cal_seq||0)-(a.cal_seq||0))[0] || null;

        const closeLegInPlace = (leg, exitPx, nClose) => {
          const avail = leg.contracts_open ?? leg.contracts ?? 1;
          // Guard: leg already fully closed — double-fire protection.
          if (avail <= 0) return leg;
          const realN = nClose != null ? Math.min(nClose, avail) : avail;
          const newOpen = avail - realN;
          const isFullClose = newOpen <= 0;
          const legPnl = Math.round((leg.cal_leg === 'short'
            ? (leg.entry_price - exitPx) * realN * 100
            : (exitPx - leg.entry_price) * realN * 100) * 100) / 100;
          // Cap contracts_closed at contracts_original — prevents accumulation beyond original size.
          const maxClosed = leg.contracts_original || leg.contracts || realN;
          if (isFullClose) {
            return { ...leg, status:'closed', exit_price:exitPx, exit_date:adjDate,
              pnl: legPnl + (leg.partial_close_pnl || 0),
              partial_close_pnl: 0,
              contracts_open: 0,
              contracts_closed: Math.min((leg.contracts_closed||0) + realN, maxClosed) };
          } else {
            return { ...leg,
              contracts_open: newOpen,
              contracts_closed: Math.min((leg.contracts_closed||0) + realN, maxClosed),
              partial_close_pnl: (leg.partial_close_pnl || 0) + legPnl,
            };
          }
        };

        const makeNewLeg = (src, legType, seq, strike, expiry, expiryBack, premium, notes) => ({
          id: getNextDemoTradeId(), ticker: src.ticker, lot_id: null,
          strategy: src.strategy || 'Calendar Spread', status: 'open',
          entry_date: adjDate, expiration: expiry, expiration_back: expiryBack || null,
          entry_price: premium, exit_price: null, exit_date: null, pnl: null,
          contracts: src.contracts_open ?? src.contracts ?? 1,
          contracts_original: src.contracts_original ?? src.contracts ?? 1,
          contracts_open: src.contracts_open ?? src.contracts ?? 1, contracts_closed: 0, partial_close_pnl: 0,
          strike_buy:  legType === 'long'  ? (parseFloat(strike) || null) : null,
          strike_sell: legType === 'short' ? (parseFloat(strike) || null) : null,
          delta: null, gamma: null, theta: null, vega: null, iv_entry: null,
          notes: notes || `Cal adjustment: ${adj}`,
          cal_chain_id: chainId, cal_leg: legType, cal_seq: seq,
          option_type: src.option_type || null,  // carry option_type from source leg
          roll_parent_id: null, roll_count: 0,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });

        if (adj === 'roll_short_leg') {
          const shortLeg = findLeg('short');
          if (shortLeg) {
            updated = updated.map(t => t.id === shortLeg.id ? closeLegInPlace(shortLeg, parseFloat(body.close_short_price)||0) : t);
            updated.push(makeNewLeg(shortLeg, 'short', maxSeq+1,
              body.new_short_strike || shortLeg.strike_sell,
              body.new_short_expiry || shortLeg.expiration, null,
              parseFloat(body.new_short_premium)||0,
              body.notes || `Rolled short → ${body.new_short_expiry||shortLeg.expiration}`));
          }
        } else if (adj === 'convert_to_calendar') {
          if (body.move_leg === 'short') {
            const shortLeg = findLeg('short');
            if (shortLeg) {
              updated = updated.map(t => t.id === shortLeg.id ? closeLegInPlace(shortLeg, parseFloat(body.close_short_price)||0) : t);
              const longLeg = findLeg('long');
              updated.push(makeNewLeg(shortLeg, 'short', maxSeq+1,
                longLeg?.strike_buy || shortLeg.strike_sell,
                body.new_short_expiry, null,
                parseFloat(body.new_short_premium)||0,
                body.notes || `Converted to calendar — short → ${longLeg?.strike_buy}`));
            }
          } else {
            const longLeg = findLeg('long');
            if (longLeg) {
              updated = updated.map(t => t.id === longLeg.id ? closeLegInPlace(longLeg, parseFloat(body.close_long_price)||0) : t);
              const shortLeg = findLeg('short');
              updated.push(makeNewLeg(longLeg, 'long', maxSeq+1,
                shortLeg?.strike_sell || longLeg.strike_buy,
                body.new_long_expiry, body.new_long_expiry,
                parseFloat(body.new_long_premium)||0,
                body.notes || `Converted to calendar — long → ${shortLeg?.strike_sell}`));
            }
          }
        } else if (adj === 'roll_long_out') {
          // Roll long leg out in time — same strike, later expiry. Extends the back month anchor.
          const longLeg = findLeg('long');
          if (longLeg) {
            updated = updated.map(t => t.id === longLeg.id ? closeLegInPlace(longLeg, parseFloat(body.close_long_price)||0) : t);
            updated.push(makeNewLeg(longLeg, 'long', maxSeq+1,
              longLeg.strike_buy || longLeg.strike_sell,   // same strike — locked
              body.new_long_expiry, body.new_long_expiry,
              parseFloat(body.new_long_premium)||0,
              body.notes || `Rolled long out → ${body.new_long_expiry}`));
          }
        } else if (adj === 'convert_diagonal') {
          const longLeg = findLeg('long');
          if (longLeg) {
            updated = updated.map(t => t.id === longLeg.id ? closeLegInPlace(longLeg, parseFloat(body.close_long_price)||0) : t);
            updated.push(makeNewLeg(longLeg, 'long', maxSeq+1,
              body.new_long_strike || longLeg.strike_buy,
              body.new_long_expiry, body.new_long_expiry,
              parseFloat(body.new_long_premium)||0,
              body.notes || `Converted to diagonal — long → ${body.new_long_strike}`));
          }
        } else if (adj === 'close_one_leg') {
          if (body.close_side === 'short') {
            const shortLeg = findLeg('short');
            if (shortLeg) updated = updated.map(t => t.id === shortLeg.id ? closeLegInPlace(shortLeg, parseFloat(body.close_short_price)||0) : t);
          } else {
            const longLeg = findLeg('long');
            if (longLeg) updated = updated.map(t => t.id === longLeg.id ? closeLegInPlace(longLeg, parseFloat(body.close_long_price)||0) : t);
          }
        } else if (adj === 'take_profit' || adj === 'close_both') {
          const shortLeg = findLeg('short');
          const longLeg  = findLeg('long');
          if (shortLeg) updated = updated.map(t => t.id === shortLeg.id ? closeLegInPlace(shortLeg, parseFloat(body.close_short_price)||0) : t);
          if (longLeg)  updated = updated.map(t => t.id === longLeg.id  ? closeLegInPlace(longLeg,  parseFloat(body.close_long_price)||0)  : t);
        } else if (adj === 'reduce_position') {
          const shortLeg = findLeg('short');
          const longLeg  = findLeg('long');
          const sn = parseInt(body.reduce_short_contracts) || 0;
          const ln = parseInt(body.reduce_long_contracts)  || 0;
          const sp = parseFloat(body.reduce_short_price)   || 0;
          const lp = parseFloat(body.reduce_long_price)    || 0;
          if (shortLeg && sn > 0) updated = updated.map(t => t.id === shortLeg.id ? closeLegInPlace(shortLeg, sp, sn) : t);
          if (longLeg  && ln > 0) updated = updated.map(t => t.id === longLeg.id  ? closeLegInPlace(longLeg,  lp, ln) : t);
        }
        return updated;
      });
    } else {
      const res = await fetch(getBase() + '/api/trades/cal-adjust', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Adjustment failed');
      }
      await loadRealData();
    }
    clearStockCache(trades.find(t => t.cal_chain_id === body.chain_id)?.ticker
      ? [trades.find(t => t.cal_chain_id === body.chain_id).ticker] : []);
    postSaveRefresh();
  };

  const handleAssignment = async ({ trade, lotData, assignDate, notes }) => {
    // FIX #1: Correct CSP assignment P&L.
    // When a CSP is assigned the trader receives the shares at the strike price.
    // P&L = premium collected − intrinsic loss absorbed at assignment.
    // Formula: (entry_price − strike_buy) × contracts × 100
    // entry_price = credit received; strike_buy = obligation price (put strike).
    // If stock closed at $196 and strike was $205 with $6 premium:
    //   P&L = (6.00 − 205.00) × ... no — correct formula below:
    //   The option's value at assignment = intrinsic = strike − stock_close
    //   Net premium kept = entry_price − (strike_buy − stock_close at expiry)
    //   But we don't have stock_close here — we store option P&L as:
    //   (entry_price − exit_price) × contracts × 100  where exit_price = intrinsic at assignment
    //   The exit_price on assignment is recorded as the strike_buy (stock acquired at strike).
    //   We therefore record the option credit retained net of the intrinsic loss:
    //   pnl = (entry_price − 0) × contracts × 100  — premium collected, shares acquired separately.
    //   The share gain/loss is tracked on the lot, not the option trade.
    //   This is the standard accounting: option P&L = full premium collected (the option expired and
    //   was exercised — we received the full credit but took the shares). Loss on shares is on the lot.
    const assignmentPnl = (parseFloat(trade.entry_price) || 0) * (trade.contracts || 1) * 100;
    const closed = { ...trade, status: 'closed', exit_date: assignDate, exit_price: trade.strike_buy, pnl: assignmentPnl, notes };
    const newLot = { ticker: trade.ticker, shares: trade.contracts * 100, avg_cost: trade.strike_buy, purchase_date: assignDate, notes: `Assigned from CSP ${trade.expiration}` };
    if (isMock) {
      const newLotId = getNextDemoLotId();
      // FIX MEDIUM: Write lot_id back to closed CSP trade so it appears in lot history
      setTrades(prev => prev.map(t => t.id === trade.id ? { ...closed, lot_id: newLotId } : t));
      setLots(prev => [...prev, { ...newLot, id: newLotId }]);
    } else {
      await apiPut(`/api/trades/${trade.id}`, closed);
      const lot = await apiPost('/api/lots', newLot);
      // FIX MEDIUM: Write lot_id back to closed CSP trade in live DB
      if (lot?.id) {
        await apiPut(`/api/trades/${trade.id}`, { ...closed, lot_id: lot.id });
      }
      await loadRealData();
    }
    clearStockCache(trade?.ticker ? [trade.ticker] : []);
    postSaveRefresh();
    setShowAssignment(false);
    setAssigningTrade(null);
  };

  // ── Called Away ───────────────────────────────────────
  const handleCalledAway = async ({ trade, saleDate, notes }) => {
    const stockBasis    = parseFloat(trade.stock_buy_price) || 0;
    const premiumCredit = parseFloat(trade.entry_price) || 0;
    const closedPnl     = ((trade.strike_sell - stockBasis) * trade.contracts * 100) + (premiumCredit * trade.contracts * 100);
    const closed = { ...trade, status: 'closed', exit_date: saleDate, exit_price: trade.strike_sell, pnl: closedPnl, notes };

    // FIX #4: When shares are called away, close the linked stock lot so it no longer
    // appears as open in Stock Positions and stops triggering false uncovered-lot alerts.
    const linkedLot = trade.lot_id ? lots.find(l => l.id === trade.lot_id) : null;

    if (isMock) {
      setTrades(prev => prev.map(t => t.id === trade.id ? closed : t));
      if (linkedLot) {
        setLots(prev => prev.map(l => l.id === linkedLot.id
          ? { ...l, close_date: saleDate, close_price: parseFloat(trade.strike_sell) }
          : l
        ));
      }
    } else {
      await apiPut(`/api/trades/${trade.id}`, closed);
      if (linkedLot) {
        await apiPut(`/api/lots/${linkedLot.id}`, {
          ...linkedLot,
          close_date:  saleDate,
          close_price: parseFloat(trade.strike_sell),
        });
      }
      await loadRealData();
    }
    clearStockCache(trade?.ticker ? [trade.ticker] : []);
    postSaveRefresh();
    setShowCalledAway(false);
    setCalledAwayTrade(null);
  };

  // ── Close Trade (early exit at specific price, optional partial) ──
  const handleCloseTrade = async ({ trade, closePrice, closeDate, contracts, notes, pnl, isPartial }) => {
    const DEBIT_STRATS = new Set([
      'Long Call','Long Put','Bull Call Spread','Bear Put Spread',
      'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread'
    ]);
    const isDebit = DEBIT_STRATS.has(trade.strategy);
    const totalContracts = trade.contracts || 1;
    const nClose  = Math.min(contracts || totalContracts, totalContracts);
    const nRemain = totalContracts - nClose;

    // Recalculate P&L precisely (don't trust passed-in value)
    const closedPnl = isDebit
      ? (closePrice - (trade.entry_price || 0)) * nClose * 100
      : ((trade.entry_price || 0) - closePrice) * nClose * 100;

    if (nRemain > 0) {
      // Partial close: close nClose contracts, update original to nRemain contracts
      const closedPart = {
        ...trade,
        id: undefined,             // new record for the closed portion
        contracts: nClose,
        status: 'closed',
        exit_date: closeDate,
        exit_price: closePrice,
        pnl: Math.round(closedPnl),
        notes: notes || `Partial close: ${nClose} of ${totalContracts} contracts`,
        roll_parent_id: trade.id,  // link back to the original
        roll_count: (trade.roll_count || 0) + 1,
      };
      const remainingOpen = {
        ...trade,
        contracts: nRemain,
        notes: `${nRemain} contracts remaining after partial close on ${closeDate}`,
      };
      if (isMock) {
        setTrades(prev => [
          ...prev.map(t => t.id === trade.id ? remainingOpen : t),
          { ...closedPart, id: getNextDemoTradeId() },
        ]);
      } else {
        await apiPut(`/api/trades/${trade.id}`, remainingOpen);
        await apiPost('/api/trades', closedPart);
        await loadRealData();
      }
    } else {
      // Full close
      const closed = {
        ...trade,
        status: 'closed',
        exit_date: closeDate,
        exit_price: closePrice,
        pnl: Math.round(closedPnl),
        notes: notes || trade.notes,
      };
      if (isMock) {
        setTrades(prev => prev.map(t => t.id === trade.id ? closed : t));
      } else {
        await apiPut(`/api/trades/${trade.id}`, closed);
        await loadRealData();
      }
    }
    clearStockCache(trade?.ticker ? [trade.ticker] : []);
    postSaveRefresh();
    setShowCloseTrade(false);
    setClosingTrade(null);
  };

  // (Expired Worthless is handled via handleCloseTrade with exit_price=0 — see ExpiredWorthlessModal)

  // ── Lot CRUD ──────────────────────────────────────────
  const handleRequestAddLot = (ticker) => { setEditLot(null); setLotTicker(ticker); setShowLotForm(true); };

  const handleSaveLot = async (data) => {
    if (isMock) {
      if (data.id) { setLots(prev => prev.map(l => l.id === data.id ? { ...l, ...data } : l)); }
      else         { setLots(prev => [...prev, { ...data, id: getNextDemoLotId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() }]); }
    } else {
      if (data.id) { await apiPut(`/api/lots/${data.id}`, data); }
      else         { await apiPost('/api/lots', data); }
      await loadRealData();
    }
    clearStockCache(data?.ticker ? [data.ticker] : []);
    postSaveRefresh();
    setShowLotForm(false); setEditLot(null); setLotTicker(null);
  };

  const handleDeleteLot = async (id) => {
    // Check for linked trades before allowing deletion
    const linkedTrades  = trades.filter(t => t.lot_id === id);
    const openLinked    = linkedTrades.filter(t => t.status === 'open');
    const closedLinked  = linkedTrades.filter(t => t.status === 'closed');

    if (openLinked.length > 0) {
      // Hard block — cannot delete a lot with active open trades against it
      const list = openLinked.map(t => `${t.strategy} ${t.expiration ? '(exp '+t.expiration+')' : ''}`).join('\n  • ');
      window.alert(
        `Cannot remove this lot — it has ${openLinked.length} open trade${openLinked.length > 1 ? 's' : ''} against it:\n\n  • ${list}\n\nClose or delete those trades first, then remove the lot.`
      );
      return;
    }

    if (closedLinked.length > 0) {
      // Soft warning — closed trades will be unlinked (orphaned) but P&L already settled
      const ok = window.confirm(
        `This lot has ${closedLinked.length} closed trade${closedLinked.length > 1 ? 's' : ''} linked to it. Those trades will remain in the Trade Log but lose their lot association.\n\nRemove the lot anyway?`
      );
      if (!ok) return;
    } else {
      if (!window.confirm('Remove this lot? This cannot be undone.')) return;
    }

    const deletedLot = lots.find(l => l.id === id);
    if (isMock) { setLots(prev => prev.filter(l => l.id !== id)); }
    else { await apiDelete(`/api/lots/${id}`); await loadRealData(); }
    clearStockCache(deletedLot?.ticker ? [deletedLot.ticker] : []);
    postSaveRefresh();
  };

  const handleCloseLot = async ({ lot, closeDate, closePrice }) => {
    const updated = { ...lot, close_date: closeDate, close_price: parseFloat(closePrice) };
    if (isMock) { setLots(prev => prev.map(l => l.id === lot.id ? updated : l)); }
    else { await apiPut(`/api/lots/${lot.id}`, updated); await loadRealData(); }
    clearStockCache(lot?.ticker ? [lot.ticker] : []);
    postSaveRefresh();
    setShowCloseLot(false); setClosingLot(null);
  };

  const handleSplitLot = async ({ lot, trades: openTrades, ratio, reverse, splitDate }) => {
    const factor = reverse ? (1 / ratio) : ratio;
    // Update lot: shares × factor, avg_cost ÷ factor
    const updatedLot = {
      ...lot,
      shares:   Math.round(lot.shares * factor),
      avg_cost: parseFloat((lot.avg_cost / factor).toFixed(4)),
      notes: `${lot.notes ? lot.notes + ' · ' : ''}${reverse ? `1:${ratio}` : `${ratio}:1`} split applied ${splitDate}`,
    };
    // Update open trades: strikes, premiums AND contracts adjust by factor
    // In a real split (e.g. 2:1) the broker doubles contracts AND halves the strike.
    // contracts_open/contracts_original also scaled. For reverse splits the result
    // may be fractional — we round and the note warns the trader to verify with broker.
    const updatedTrades = openTrades.map(t => {
      const newContracts         = Math.round((t.contracts          || 1) * factor);
      const newContractsOriginal = Math.round((t.contracts_original || t.contracts || 1) * factor);
      const newContractsOpen     = Math.round((t.contracts_open     || t.contracts || 1) * factor);
      const newContractsClosed   = t.contracts_closed != null ? Math.round(t.contracts_closed * factor) : 0;
      return {
        ...t,
        strike_sell:         t.strike_sell         != null ? parseFloat((t.strike_sell         / factor).toFixed(2)) : null,
        strike_buy:          t.strike_buy           != null ? parseFloat((t.strike_buy          / factor).toFixed(2)) : null,
        entry_price:         t.entry_price          != null ? parseFloat((t.entry_price         / factor).toFixed(4)) : null,
        contracts:           newContracts,
        contracts_original:  newContractsOriginal,
        contracts_open:      newContractsOpen,
        contracts_closed:    newContractsClosed,
      };
    });
    if (isMock) {
      setLots(prev => prev.map(l => l.id === lot.id ? updatedLot : l));
      setTrades(prev => prev.map(t => {
        const updated = updatedTrades.find(u => u.id === t.id);
        return updated || t;
      }));
    } else {
      await apiPut(`/api/lots/${lot.id}`, updatedLot);
      for (const t of updatedTrades) {
        await apiPut(`/api/trades/${t.id}`, t);
      }
      await loadRealData();
    }
    clearStockCache(lot?.ticker ? [lot.ticker] : []);
    postSaveRefresh();
    setShowSplitLot(false); setSplittingLot(null);
  };

  const handleReopenLot = async (lot) => {
    const updated = { ...lot, close_date: null, close_price: null };
    if (isMock) { setLots(prev => prev.map(l => l.id === lot.id ? updated : l)); }
    else { await apiPut(`/api/lots/${lot.id}`, updated); await loadRealData(); }
    clearStockCache(lot?.ticker ? [lot.ticker] : []);
    postSaveRefresh();
  };

  // ── Import ────────────────────────────────────────────
  const handleImport = async (parsedTrades, fileHash, fileName, broker) => {
    // ── Separate lot-create / lot-close / end-markers from trade rows ──────
    // lotCreateRows: pure stock purchase rows (no strategy) PLUS merged event rows that carry
    // _lotCreate (e.g. Schwab/IBKR/Robinhood CSP Assigned rows which have strategy='Cash-Secured Put').
    const lotCreateRows = parsedTrades.filter(t => t._lotCreate);
    // lotCloseRows: pure stock sale rows (no strategy) PLUS merged event rows that carry
    // _lotClose (e.g. Schwab/IBKR/Robinhood CC Called Away rows which have strategy='Covered Call').
    const lotCloseRows  = parsedTrades.filter(t => t._lotClose && !t._lotCreate);
    const tradeRows     = parsedTrades.filter(t => !t._endMarker);               // option trades (may also carry _lotCreate/_lotClose for assignment/called-away)

    // ── Step 1: Create lots from stock purchase rows ───────────────────────
    // Build a running map of ticker → newly created lot so option rows in the
    // same END group can be linked to it even before loadRealData() is called.
    const importedLotMap = {}; // ticker → lot object (for isMock) or lot_id (live)


    for (const row of lotCreateRows) {
      // Merged event rows (CSP Assigned) carry lot data in lot_* fields.
      // Pure stock rows (Tastytrade RD Buy, IBKR Stocks) carry data in direct fields.
      const lotData = {
        ticker:        row.lot_ticker    || row.ticker,
        shares:        row.lot_shares    || row.shares,
        avg_cost:      row.lot_avg_cost  || row.avg_cost,
        purchase_date: row.lot_purchase_date || row.purchase_date,
        notes:         row.notes || `Imported from ${broker}`,
      };
      if (isMock) {
        const newId = getNextDemoLotId();
        const newLot = { ...lotData, id: newId, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        setLots(prev => [...prev, newLot]);
        importedLotMap[row.ticker.toUpperCase()] = newLot;
      } else {
        const created = await apiPost('/api/lots', lotData);
        if (created?.id) importedLotMap[row.ticker.toUpperCase()] = created;
      }
    }

    // ── Step 2: Close lots from stock sale rows (called-away / manual sale) ─
    // Attempt to match to the most recently created lot for this ticker.
    // We do this after creating new lots so we never close a just-created lot.
    const allLots = isMock
      ? [...lots, ...Object.values(importedLotMap)]  // include freshly created mock lots
      : lots;

    for (const row of lotCloseRows) {
      const ticker = row.lot_ticker?.toUpperCase();
      if (!ticker) continue;
      // Find the best open lot to close: prefer the one just created in this import.
      // In the live path, importedLotMap holds the POST response object directly —
      // the lot is NOT yet in the 'lots' React state (loadRealData hasn't run).
      // So we use importedLotMap[ticker] directly rather than searching allLots.
      const imported = importedLotMap[ticker];
      const openLot = imported
        ? imported   // use directly — valid for both isMock and live
        : allLots.find(l => l.ticker?.toUpperCase() === ticker && !l.close_date);
      if (!openLot?.id) continue; // no matching lot found — skip silently

      const updated = { ...openLot, close_date: row.lot_close_date, close_price: row.lot_close_price };
      if (isMock) {
        setLots(prev => prev.map(l => l.id === openLot.id ? updated : l));
        // update importedLotMap so subsequent option trades see the closed status
        if (importedLotMap[ticker]?.id === openLot.id) importedLotMap[ticker] = updated;
      } else {
        await apiPut(`/api/lots/${openLot.id}`, updated);
      }
    }

    // ── Rebuild allLots after creates/closes for option auto-linking ────────
    // For isMock: setLots is async-batched so we build a local snapshot.
    // For live: we'll reload after all operations.
    // We pass this snapshot into autoMatchLot below.
    const snapshotLots = isMock
      ? (() => {
          // Apply creates and closes to the current lots state manually for the snapshot
          let snap = [...lots];
          for (const row of lotCreateRows) {
            const tickerKey = (row.lot_ticker || row.ticker)?.toUpperCase();
            const existing = importedLotMap[tickerKey];
            if (existing && !snap.find(l => l.id === existing.id)) snap = [...snap, existing];
          }
          for (const row of lotCloseRows) {
            const ticker = row.lot_ticker?.toUpperCase();
            const imp = importedLotMap[ticker];
            if (imp) snap = snap.map(l => l.id === imp.id ? { ...l, close_date: row.lot_close_date, close_price: row.lot_close_price } : l);
          }
          return snap;
        })()
      : (() => {
          // Live path: lots = old React state, doesn't include lots just created.
          // Build a snapshot the same way as isMock — start with existing lots,
          // add newly created lots, apply close dates.
          let snap = [...lots];
          for (const row of lotCreateRows) {
            const tickerKey = (row.lot_ticker || row.ticker)?.toUpperCase();
            const existing = importedLotMap[tickerKey];
            if (existing?.id && !snap.find(l => l.id === existing.id)) snap = [...snap, existing];
          }
          for (const row of lotCloseRows) {
            const t = row.lot_ticker?.toUpperCase();
            const imp = importedLotMap[t];
            if (imp?.id) snap = snap.map(l => l.id === imp.id ? { ...l, close_date: row.lot_close_date, close_price: row.lot_close_price } : l);
          }
          return snap;
        })();

    // ── Auto-match CC/CSP trades to open lots ──────────────────────────────
    const CC_STRATEGIES = ['Covered Call', 'Bear Call Spread', 'Bull Call Spread'];

    const NO_LOT_STRATEGIES = new Set([
      'Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly',
      'Bull Call Spread','Bear Put Spread','Long Call','Long Put',
      'Long Straddle','Long Strangle','Calendar Spread','Diagonal Spread',
    ]);

    function autoMatchLot(trade) {
      if (NO_LOT_STRATEGIES.has(trade.strategy)) return null;
      if (![...CC_STRATEGIES, 'Cash-Secured Put'].includes(trade.strategy)) return null;

      // If this trade itself carried a _lotCreate inline (Schwab Assigned CSP),
      // use the lot we just created from it
      if (trade._lotCreate && trade.lot_ticker) {
        const imp = importedLotMap[trade.lot_ticker.toUpperCase()];
        if (imp) return { lot_id: imp.id, note: `Auto-linked to newly created ${trade.lot_ticker} lot (assignment)` };
      }

      // Include lots that were closed in this same import (called-away/sale in same file).
      // A trade should link to the lot it belonged to regardless of close status.
      // Exception: open trades (new STO/BTO) must NOT link to closed lots —
      // a closed lot's wheel is finished; new options start a new cycle.
      const tickerLots = snapshotLots.filter(l =>
        l.ticker?.toUpperCase() === trade.ticker?.toUpperCase() &&
        (trade.status !== 'open' || !l.close_date)
      );
      if (tickerLots.length === 0) return null;

      if (trade.lot_id) {
        const directLot = tickerLots.find(l => l.id === parseInt(trade.lot_id));
        if (directLot) return { lot_id: directLot.id, note: `Linked by Lot #${directLot.id} (supplied in CSV)` };
      }
      if (tickerLots.length === 1)
        return { lot_id: tickerLots[0].id, note: `Auto-linked to ${trade.ticker} lot (only open lot)` };

      const contractShares = (trade.contracts || 1) * 100;
      const sizeMatches = tickerLots.filter(l => Math.round(l.shares) === contractShares);
      if (sizeMatches.length === 1)
        return { lot_id: sizeMatches[0].id, note: `Auto-linked by size (${trade.contracts} contracts = ${contractShares} shares)` };

      if (trade.lot_avg_cost) {
        const costTarget = parseFloat(trade.lot_avg_cost);
        const costMatches = tickerLots.filter(l => Math.abs((l.avg_cost || 0) - costTarget) < 0.50);
        if (costMatches.length === 1)
          return { lot_id: costMatches[0].id, note: `Linked by avg cost $${costTarget} match to Lot #${costMatches[0].id}` };
        if (costMatches.length > 1) {
          const bothMatch = costMatches.filter(l => Math.round(l.shares) === contractShares);
          if (bothMatch.length === 1)
            return { lot_id: bothMatch[0].id, note: `Linked by avg cost + size match to Lot #${bothMatch[0].id}` };
        }
      }
      return { lot_id: null, note: `⚠ ${tickerLots.length} ${trade.ticker} lots found — link manually in Trade Log` };
    }

    // ── Step 3: Enrich trade rows and filter invalid ones ──────────────────
    // Calculate pnl for merged event trades (expired/assigned/called-away).
    // pairOpenClose sets pnl for BTC/STC pairs but not for event-merged records.
    // Without pnl, Realised P&L and Analytics show incorrect figures after import.
    const CREDIT_STRATS_IMPORT = new Set(['Covered Call','Cash-Secured Put','Bull Put Spread','Bear Call Spread','Iron Condor','Iron Butterfly','Bull Call Spread']);
    const tradeRowsWithPnl = tradeRows.map(t => {
      if (t.pnl != null) return t; // already set (e.g. BTC/STC paired trades)
      if (t.status !== 'closed') return t; // open trades have no pnl yet
      const ep = parseFloat(t.entry_price) || 0;
      const ct = t.contracts || 1;
      if (!ep || ep <= 0) return t; // no entry price to calculate from
      const isCredit = CREDIT_STRATS_IMPORT.has(t.strategy);
      let pnl;
      if (t._event === 'assigned_put' || t._event === 'called_away') {
        // Assignment/called-away: option P&L = full premium collected.
        // exit_price is the strike (stock transaction price), not a buyback price.
        pnl = Math.round(ep * ct * 100 * 100) / 100;
      } else {
        // Expired worthless: credit strats keep full premium, debit strats lose it.
        pnl = isCredit
          ? Math.round(ep * ct * 100 * 100) / 100
          : Math.round(-ep * ct * 100 * 100) / 100;
      }
      return { ...t, pnl };
    });

    const enrichedTrades = tradeRowsWithPnl.map(t => {
      const match = autoMatchLot(t);
      if (!match) return t;
      const notes = [t.notes, match.note].filter(Boolean).join(' · ');
      return { ...t, lot_id: match.lot_id ?? t.lot_id ?? null, notes };
    }).filter(t => {
      // Pure lot rows (stock purchase/sale with no strategy) must not be posted as trades
      if (!t.strategy) return false;
      if (t.status === 'open' && (!t.entry_price || parseFloat(t.entry_price) <= 0)) return false;
      // Allow event rows (expired/assigned) through even with null entry_price —
      // they are valid closed records. Identify by _event flag.
      if (t._event) return true;
      if (t.status === 'closed' && (!t.entry_price || parseFloat(t.entry_price) <= 0)) return false;
      return true;
    });


    const linked    = enrichedTrades.filter(t => t.lot_id && [...CC_STRATEGIES, 'Cash-Secured Put'].includes(t.strategy)).length;
    const ambiguous = enrichedTrades.filter(t => !t.lot_id && [...CC_STRATEGIES, 'Cash-Secured Put'].includes(t.strategy) && snapshotLots.some(l => l.ticker?.toUpperCase() === t.ticker?.toUpperCase() && !l.close_date)).length;

    if (isMock) {
      const seededTrades = enrichedTrades.map(t => {
        const newId = getNextDemoTradeId();
        if (['Iron Condor','Iron Butterfly'].includes(t.strategy)) {
          return { ...t, id: newId, roll_count: 0, roll_parent_id: null,
            condor_chain_id: newId, condor_leg: 'full', condor_seq: 0,
            contracts_original: t.contracts||1, contracts_open: t.contracts||1,
            contracts_closed: 0, partial_close_pnl: 0 };
        }
        return { ...t, id: newId, roll_count: 0, roll_parent_id: null };
      });
      setTrades(prev => [...prev, ...seededTrades]);
    } else {
      // Strip parser-internal fields before posting to backend.
      // Event rows (expired/assigned) carry entry_price=null; use 0.01 placeholder so
      // backend accepts them — the note instructs the user to press Assignment/Called Away/
      // Expired button in Trade Log to correct the record properly.
      const toPost = enrichedTrades.map(({ _event, _lotCreate, _lotClose, _endMarker, ...t }) => {
        if (_event && (!t.entry_price || parseFloat(t.entry_price) <= 0)) {
          return { ...t, entry_price: 0.01,
            notes: (t.notes || '') + ' · entry price unknown — press the correct action button in Trade Log' };
        }
        return t;
      });
      const posted = await Promise.all(toPost.map(t => apiPost('/api/trades', t)));
      const failed = posted.filter(r => r === null).length;
      if (failed > 0) console.warn(`Import: ${failed} trade(s) rejected by backend validation`);
      const condorSeeds = posted
        .map((created, i) => ({ created, t: enrichedTrades[i] }))
        .filter(({ created, t }) => created?.id && ['Iron Condor','Iron Butterfly'].includes(t.strategy));
      await Promise.all(condorSeeds.map(({ created, t }) =>
        apiPut(`/api/trades/${created.id}`, {
          ...t, id: created.id,
          condor_chain_id: created.id, condor_leg: 'full', condor_seq: 0,
          contracts_original: t.contracts||1, contracts_open: t.contracts||1,
          contracts_closed: 0, partial_close_pnl: 0,
        })
      ));
      await apiPost('/api/import-history', {
        file_hash:     fileHash,
        file_name:     fileName,
        broker,
        trade_count:   enrichedTrades.length,
        lot_linked:    linked,
        lot_ambiguous: ambiguous,
      });
      await loadRealData();
    }
    clearStockCache([...new Set(enrichedTrades.map(t => t.ticker).filter(Boolean))]);
    postSaveRefresh();
    setShowImport(false);
  };

  // ── Backup handlers ───────────────────────────────────
  const handleManualBackup = async () => {
    setBackupDownloading(true);
    try {
      const res  = await fetch(getBase() + '/api/backup/download');
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `myoptiondiary-backup-${localDateISO()}.db`;
      a.click();
      URL.revokeObjectURL(url);
      await fetch(getBase() + '/api/backup/record', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ size: blob.size }),
      });
      setLastBackup(new Date().toISOString());
    } catch (e) { alert('Backup failed: ' + e.message); }
    setBackupDownloading(false);
  };

  const handleToggleReminder = async (enabled) => {
    setBackupReminder(enabled);
    await fetch(getBase() + '/api/backup/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupReminder: enabled }),
    }).catch(() => {});
  };

  const handleClearAllData = async () => {
    if (!showClearConfirm) { setShowClearConfirm(true); return; }
    setClearingData(true);
    setShowClearConfirm(false);
    try {
      if (isMock) {
        // Demo mode — reset to original demo data
        setTrades(getDemoTrades());
        setLots(getDemoLots());
      } else {
        const res = await fetch(getBase() + '/api/data/clear-all', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'DELETE_ALL_MY_DATA' }),
        });
        if (!res.ok) throw new Error('Clear failed');
        await loadRealData();
      }
      postSaveRefresh();
    } catch (e) {
      console.error('Clear all data failed:', e);
    } finally {
      setClearingData(false);
    }
  };

  // ── Toggle demo mode ──────────────────────────────────
  const toggleMock = async () => {
    // Always close all modals when switching modes — demo trade objects are invalid in live and vice versa
    setShowTradeForm(false);   setEditTrade(null);   setPrefillTrade(null);
    setShowLotForm(false);     setEditLot(null);     setLotTicker(null);
    setShowCloseLot(false);    setClosingLot(null);
    setShowAssignment(false);  setAssigningTrade(null);
    setShowCalledAway(false);  setCalledAwayTrade(null);
    setShowCloseTrade(false);  setClosingTrade(null);
    setShowExpired(false);     setExpiredTrade(null);
    setAdjustingCal(null);  // IC adjust modal is local to TradeLog — auto-closes on trades refresh
    // Clear prices on every mode switch — demo and live trade IDs overlap (both start at 1)
    // and ticker-keyed prices share the same namespace. Stale cross-mode prices produce
    // wrong buy-back pre-fills and wrong BSM inputs in Alerts and RollModal.
    setCurrentPrices({});
    try { localStorage.removeItem('ott-manual-prices'); } catch {}
    if (!isMock) {
      setIsMock(true);
      setTrades(getDemoTrades());
      setLots(getDemoLots());
    } else {
      setIsMock(false);
      setDataLoading(true);
      await loadRealData();
      setDataLoading(false);
    }
  };

  const pill = <DemoPill isMock={isMock} onToggle={toggleMock} loading={dataLoading} />;


  if (loading) {
    return (
      <div style={{ display:'flex', height:'100vh', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:12, color:'#f0efe9', background:'#1c1c1a' }}>
        <div style={{ fontSize:36 }}>📈</div>
        <p style={{ fontFamily:"'DM Sans', sans-serif", margin:0 }}>Loading MyOptionDiary...</p>
      </div>
    );
  }

  return (
    <div className="app-layout">
      {isMock && <DemoWatermark />}

      {/* ── Sidebar ───────────────────────────────── */}
      <aside className="sidebar">
        {/* ── Logo ──────────────────────────────────── */}
        <div className="sidebar-logo">
          <span className="logo-icon">📈</span>
          <div>
            <h1>MyOptionDiary</h1>
            <p>Options Journal</p>
          </div>
        </div>

        {/* ── Views ─────────────────────────────────── */}
        <nav className="nav-section">
          <div className="nav-section-label">Views</div>
          {VIEWS.map(v => (
            <div key={v.id} className={`nav-item ${view === v.id ? 'active' : ''}`} onClick={() => {
              if (v.id === 'trades') { setTradeSearch(''); setFilterTickers(null); setTradeFilterLotId(null); setTradeInitialFilter('Open'); }
              setAlertsFrom(null);
              setFilterUnhedged(false);
              setView(v.id);
            }}>
              <span className="nav-icon">{v.icon}</span>
              {v.label}
              {v.id === 'positions' && uncoveredCount > 0 && (
                <span className="nav-badge">{uncoveredCount}</span>
              )}
              {v.id === 'alerts' && (() => {
                const openTrades = trades.filter(t => t.status === 'open');
                const urgentCount = openTrades.filter(t => {
                  const dte = t.expiration ? Math.ceil((new Date(t.expiration) - new Date()) / 86400000) : null;
                  return (dte != null && dte <= 7) || Math.abs(t.delta || 0) > 0.50;
                }).length;
                return urgentCount > 0 ? <span className="nav-badge" style={{ background: 'var(--red)' }}>{urgentCount}</span> : null;
              })()}
            </div>
          ))}
        </nav>

        <div className="sidebar-divider" />

        {/* ── Actions ───────────────────────────────── */}
        <nav className="nav-section">
          <div className="nav-section-label">Actions</div>
          <div className="nav-item" onClick={handleAddTrade} style={{ color: 'var(--accent)' }}>
            <span className="nav-icon">+</span> Log New Trade
          </div>
          <div className="nav-item" onClick={() => handleRequestAddLot(null)} style={{ color: 'var(--green)' }}>
            <span className="nav-icon">◈</span> Add Stock Lot
          </div>
          <div className="nav-item" onClick={() => setShowImport(true)} style={{ color: 'rgba(255,255,255,0.80)' }}>
            <span className="nav-icon">↑</span> Import CSV
          </div>

          {/* Clear All Data — with two-step confirmation */}
          <div style={{ padding: '4px 10px 8px' }}>
            {!showClearConfirm ? (
              <button
                onClick={handleClearAllData}
                disabled={clearingData}
                style={{
                  width: '100%', padding: '6px 8px', borderRadius: 6, border: 'none',
                  background: 'rgba(220,53,69,0.15)', color: 'rgba(255,120,130,0.85)',
                  cursor: 'pointer', fontSize: 11.5, fontWeight: 600,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                }}
              >
                <span>🗑</span>
                <span>{clearingData ? 'Clearing...' : 'Clear All Data'}</span>
              </button>
            ) : (
              <div style={{ background: 'rgba(220,53,69,0.12)', borderRadius: 6, padding: '8px 10px', border: '1px solid rgba(220,53,69,0.30)' }}>
                <div style={{ fontSize: 11, color: 'rgba(255,180,180,0.9)', marginBottom: 6, fontWeight: 600 }}>
                  Delete all trades &amp; lots?
                </div>
                <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginBottom: 8, lineHeight: 1.4 }}>
                  This cannot be undone. Back up first.
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    onClick={handleClearAllData}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 5, border: 'none',
                      background: 'rgba(220,53,69,0.70)', color: '#fff',
                      cursor: 'pointer', fontSize: 11, fontWeight: 700,
                    }}
                  >
                    Yes, delete all
                  </button>
                  <button
                    onClick={() => setShowClearConfirm(false)}
                    style={{
                      flex: 1, padding: '5px 0', borderRadius: 5, border: '1px solid rgba(255,255,255,0.15)',
                      background: 'transparent', color: 'rgba(255,255,255,0.60)',
                      cursor: 'pointer', fontSize: 11,
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        </nav>

        <div className="sidebar-divider" />

        {/* ── Settings ──────────────────────────────── */}
        <nav className="nav-section">
          <div className="nav-section-label">Settings</div>

          {/* Demo / Live toggle */}
          <div className="dark-toggle-row" onClick={() => !dataLoading && toggleMock()} style={{ opacity: dataLoading ? 0.5 : 1, cursor: dataLoading ? 'default' : 'pointer' }}>
            <span className="dark-toggle-label">
              <span className="dark-toggle-icon">{isMock ? '🎮' : '📡'}</span>
              {isMock ? 'Demo Mode' : 'Live Mode'}
            </span>
            <div className={`toggle-track ${isMock ? 'on' : ''}`} style={{ background: isMock ? 'var(--amber)' : 'var(--green)' }}>
              <div className="toggle-knob" />
            </div>
          </div>

          {/* Broker connection — dot + status, opens settings on click */}
          <div className="nav-item" onClick={() => setShowDataConn(true)}>
            <span className="nav-icon">
              <span className={`live-dot-inline ${liveStatus.status}`} />
            </span>
            <span>Connect to Broker</span>
            <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.50 }}>{liveStatus.label}</span>
          </div>

          {/* Quick Start */}
          <div
            className="nav-item"
            onClick={() => setShowQuickStart(v => !v)}
            style={{ color: showQuickStart ? '#fff' : 'rgba(255,255,255,0.80)', background: showQuickStart ? 'rgba(255,255,255,0.12)' : undefined }}
          >
            <span className="nav-icon">🚀</span> Quick Start
          </div>

          {/* Help */}
          <div
            className="nav-item"
            onClick={() => setShowHelp(v => !v)}
            style={{ color: showHelp ? '#fff' : 'rgba(255,255,255,0.80)', background: showHelp ? 'rgba(255,255,255,0.12)' : undefined }}
          >
            <span className="nav-icon">?</span> Help &amp; Guide
          </div>

          {/* Dark mode toggle */}
          <div className="dark-toggle-row" onClick={() => setDarkMode(d => !d)}>
            <span className="dark-toggle-label">
              <span className="dark-toggle-icon">{darkMode ? '☀' : '◑'}</span>
              {darkMode ? 'Light mode' : 'Dark mode'}
            </span>
            <div className={`toggle-track ${darkMode ? 'on' : ''}`}>
              <div className="toggle-knob" />
            </div>
          </div>

          {/* Historical Entry Mode toggle */}
          <div className="dark-toggle-row" onClick={() => setHistoricalMode(v => !v)}>
            <span className="dark-toggle-label">
              <span className="dark-toggle-icon">🕐</span>
              Historical Entry
            </span>
            <div className={`toggle-track ${historicalMode ? 'on' : ''}`} style={{ background: historicalMode ? 'var(--red,#c0392b)' : undefined }}>
              <div className="toggle-knob" />
            </div>
          </div>

          <div className="sidebar-divider" style={{ margin: '6px 0' }} />

          {/* Backup: button on left, monthly reminder toggle on the right */}
          <div
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '6px 10px', gap: 8,
            }}
          >
            {/* Left: Back Up Now button + last backup date below */}
            <div
              className="nav-item"
              onClick={handleManualBackup}
              style={{
                flex: 1, padding: '5px 8px', margin: 0,
                color: backupDownloading ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.80)',
                flexDirection: 'column', alignItems: 'flex-start', gap: 2,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span className="nav-icon" style={{ margin: 0 }}>💾</span>
                <span style={{ fontWeight: 600 }}>{backupDownloading ? 'Saving...' : 'Back Up Now'}</span>
              </div>
              {lastBackup && (
                <div style={{ fontSize: 9.5, color: 'rgba(255,255,255,0.35)', paddingLeft: 22, lineHeight: 1.3 }}>
                  Last: {new Date(lastBackup).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
              )}
            </div>

            {/* Right: Monthly reminder toggle with label below */}
            <div
              onClick={() => handleToggleReminder(!backupReminder)}
              style={{
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                cursor: 'pointer', flexShrink: 0, padding: '4px 6px', borderRadius: 6,
                background: 'rgba(255,255,255,0.05)',
              }}
            >
              <div className={`toggle-track ${backupReminder ? 'on' : ''}`}>
                <div className="toggle-knob" />
              </div>
              <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.40)', textAlign: 'center', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
                Monthly<br/>reminder
              </div>
            </div>
          </div>
        </nav>

        {/* ── Stats (bottom) ────────────────────────── */}
        <div className="sidebar-stats">
          {isMock && <div className="sidebar-banner demo">⚠ DEMO DATA MODE</div>}
          {!backendOnline && !isMock && <div className="sidebar-banner offline">Backend offline</div>}

          <div className="sidebar-stat-label" style={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, marginBottom: 4 }}>Total P&L</div>
          <div className={`sidebar-pnl ${stats.totalPnl >= 0 ? 'text-green' : 'text-red'}`} style={{ color: stats.totalPnl >= 0 ? '#22c55e' : '#f87171' }}>
            {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>

          <div className="sidebar-stat-row">
            <div className="sidebar-stat">
              <div className="sidebar-stat-label">Win Rate</div>
              <div className="sidebar-stat-value" style={{ color: stats.winRate >= 50 ? '#22c55e' : '#f87171' }}>
                {stats.winRate.toFixed(0)}%
              </div>
            </div>
            <div className="sidebar-stat">
              <div className="sidebar-stat-label">Wheel</div>
              <div className="sidebar-stat-value" style={{ color: '#1a7a4a' }}>{stats.wheelTrades}</div>
            </div>
            <div className="sidebar-stat">
              <div className="sidebar-stat-label">Idle</div>
              <div className="sidebar-stat-value" style={{ color: stats.unhedgedLots > 0 ? '#b7730a' : '#60a5fa' }}>{stats.unhedgedLots}</div>
            </div>
            <div className="sidebar-stat">
              <div className="sidebar-stat-label">Solo</div>
              <div className="sidebar-stat-value" style={{ color: '#60a5fa' }}>{stats.standaloneTrades}</div>
            </div>
          </div>

          {uncoveredCount > 0 && (
            <div className="sidebar-alert" onClick={() => setView('positions')}>
              ⚠ {uncoveredCount} uncovered position{uncoveredCount !== 1 ? 's' : ''} →
            </div>
          )}
        </div>
      </aside>

      {/* ── Main content ──────────────────────────── */}
      <main className="main-content">

      {/* Historical mode warning banner — inside main so it doesn't break sidebar layout */}
      {historicalMode && (
        <div style={{ background:'#c0392b', color:'#fff', padding:'6px 20px', fontSize:12, fontFamily:'var(--font-mono)', display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexShrink:0 }}>
          <span>🕐 <strong>Historical Entry Mode is ON</strong> — date validations are relaxed. Turn off in Settings when done.</span>
          <button onClick={() => setHistoricalMode(false)} style={{ background:'rgba(255,255,255,0.2)', border:'1px solid rgba(255,255,255,0.4)', color:'#fff', borderRadius:4, padding:'2px 10px', cursor:'pointer', fontSize:11, whiteSpace:'nowrap' }}>Turn Off</button>
        </div>
      )}
        {view === 'dashboard' && (
          <ErrorBoundary name="Analytics">
            <Dashboard
              trades={enrichedTrades}
              lots={lots.map(normLot)}
              stats={stats}
              isMock={isMock}
              historicalMode={historicalMode}
              pill={pill}
              onAddTrade={handleAddTrade}
              onToggleMock={toggleMock}
              currentPrices={currentPrices}
              yahooStatus={yahooStatus}
              onFetchYahoo={fetchYahooForOpenTrades}
              pricesUpdatedAt={pricesUpdatedAt}
              liveStatus={liveStatus}
              onOpenTradesClick={() => { setPositionsFilter('all'); setView('positions'); }}
              onGoToTrades={(tickerSet) => { setTradeSearch(''); setFilterTickers(tickerSet || null); setView('trades'); }}
              onGoToPositions={() => { setFilterUnhedged(true); setView('positions'); }}
              bucketTickers={bucketTickers}
            />
          </ErrorBoundary>
        )}
        {view === 'positions' && (
          <ErrorBoundary name="Stock Positions">
            <StockPositions
              lots={lots.map(normLot)}
              trades={enrichedTrades}
              isMock={isMock}
              pill={pill}
              initialFilter={positionsFilter}
              filterUnhedged={filterUnhedged}
              onFilterConsumed={() => { setPositionsFilter(null); setFilterUnhedged(false); }}
              onAddTrade={handleAddTrade}
              onWriteCC={handleWriteCC}
              onAddLot={handleRequestAddLot}
              onEditLot={(lot) => { setEditLot(lot); setShowLotForm(true); }}
              onCloseLot={(lot) => {
                // Hard stop — cannot sell shares while an open CC or CSP is written against this lot
                const openOptions = trades.filter(t =>
                  t.lot_id === lot.id &&
                  t.status === 'open' &&
                  (t.strategy === 'Covered Call' || t.strategy === 'Cash-Secured Put')
                );
                if (openOptions.length > 0) {
                  const list = openOptions
                    .map(t => `${t.strategy}${t.expiration ? ' (exp ' + t.expiration + ')' : ''}`)
                    .join('\n  • ');
                  window.alert(
                    `Cannot sell shares — open option position${openOptions.length > 1 ? 's' : ''} must be closed first:\n\n  • ${list}\n\nGo to Trade Log and close or roll this position first, then return here to sell shares.`
                  );
                  return;
                }
                setClosingLot(lot); setShowCloseLot(true);
              }}
              onReopenLot={handleReopenLot}
              onDeleteLot={handleDeleteLot}
              onSplitLot={(lot) => { setSplittingLot(lot); setShowSplitLot(true); }}
              onAssignment={(trade) => { setAssigningTrade(trade); setShowAssignment(true); }}
              onCalledAway={(trade) => { setCalledAwayTrade(trade); setShowCalledAway(true); }}
              onCloseTrade={(trade) => { setClosingTrade(trade); setShowCloseTrade(true); }}
              onViewTrades={(ticker, lotId, isClosed) => {
                setTradeSearch(ticker);
                setFilterTickers(null);
                setTradeFilterLotId(lotId || null);
                setTradeInitialFilter(isClosed ? 'All' : 'Open');
                setView('trades');
              }}
              onViewAlerts={() => { setAlertsFrom('positions'); setView('alerts'); }}
              currentPrices={currentPrices}
            />
          </ErrorBoundary>
        )}
        {view === 'trades' && (
          <ErrorBoundary name="Trade Log">
            <TradeLog
              trades={enrichedTrades}
              lots={lots.map(normLot)}
              isMock={isMock}
              pill={pill}
              onEdit={handleEditTrade}
              onDelete={handleDeleteTrade}
              onRoll={handleRoll}
              onICAdjust={handleICAdjust}
              onCalAdjust={handleCalAdjust}
              onOpenCalAdjust={(trade, chainTrades) => setAdjustingCal({ trade, chainTrades })}
              onDeleteChain={handleDeleteChain}
              onAssignment={(trade) => { setAssigningTrade(trade); setShowAssignment(true); }}
              onCalledAway={(trade) => { setCalledAwayTrade(trade); setShowCalledAway(true); }}
              onCloseTrade={(trade) => { setClosingTrade(trade); setShowCloseTrade(true); }}
              onExpired={(trade) => { setExpiredTrade(trade); setShowExpired(true); }}
              onImport={() => setShowImport(true)}
              onAddTrade={handleAddTrade}
              currentPrices={currentPrices}
              onPriceUpdate={handlePriceUpdate}
              yahooStatus={yahooStatus}
              onFetchYahoo={fetchYahooForOpenTrades}
              pricesUpdatedAt={pricesUpdatedAt}
              liveStatus={liveStatus}
              initialSearch={tradeSearch}
              initialFilter={tradeInitialFilter}
              filterLotId={tradeFilterLotId}
              filterTickers={filterTickers}
              onClearFilterTickers={() => { setFilterTickers(null); setTradeFilterLotId(null); setTradeInitialFilter('Open'); }}
              pendingRollTrade={pendingRollTrade}
              onClearPendingRoll={() => setPendingRollTrade(null)}
            />
          </ErrorBoundary>
        )}
        {view === 'alerts' && (
          <ErrorBoundary name="Alerts">
            <Alerts
              trades={enrichedTrades}
              pill={pill}
              currentPrices={currentPrices}
              onCloseTrade={(trade) => { setClosingTrade(trade); setShowCloseTrade(true); }}
              onRoll={trade => {
                // Stage the roll trade and navigate to Trade Log where
                // RollModal will open automatically — avoids calling
                // handleRoll directly which expects a fully structured object
                setPendingRollTrade(trade);
                setAlertsFrom(null);
                setTradeSearch('');
                setFilterTickers(null);
                setView('trades');
              }}
              alertsFrom={alertsFrom}
              onBackToPositions={() => { setAlertsFrom(null); setView('positions'); }}
              onGoToTradeLog={() => { setAlertsFrom(null); setTradeSearch(''); setFilterTickers(null); setView('trades'); }}
            />
          </ErrorBoundary>
        )}
      </main>

      {/* ── Modals ────────────────────────────────── */}
      {showTradeForm && (
        <TradeForm
          initial={editTrade}
          prefill={prefillTrade}
          lots={lots.map(normLot)}
          trades={trades}
          onSave={handleSaveTrade}
          onClose={() => { setShowTradeForm(false); setEditTrade(null); setPrefillTrade(null); }}
          isBrokerConnected={isBrokerConnected}
          currentPrices={currentPrices}
          isMock={isMock}
          historicalMode={historicalMode}
          onFetchSpot={async (ticker) => {
            if (!ticker || isMock) return null;
            try {
              // Fetch spot and ATM IV in parallel — both needed for realistic recommendations
              const [price, atmIv] = await Promise.all([
                fetchStockPrice(ticker),
                fetchAtmIv(ticker, null), // spot not needed for chain fetch — uses nearest 30d expiry
              ]);
              if (price) {
                setCurrentPrices(prev => ({
                  ...prev,
                  [ticker.toUpperCase()]: {
                    ...(prev[ticker.toUpperCase()] || {}),
                    stock: price,
                    // Only write IV if Yahoo returned a real value — never overwrite live broker IV
                    ...(atmIv != null ? { iv: atmIv } : {}),
                  }
                }));
                return price; // TradeForm .then(price => ...) checks this
              }
            } catch {}
            return null;
          }}
        />
      )}

      {showLotForm && (
        <LotForm
          initial={editLot}
          defaultTicker={lotTicker}
          onSave={handleSaveLot}
          onClose={() => { setShowLotForm(false); setEditLot(null); setLotTicker(null); }}
        />
      )}

      {showSplitLot && splittingLot && (
        <StockSplitModal
          lot={normLot(splittingLot)}
          trades={trades}
          onSave={handleSplitLot}
          onClose={() => { setShowSplitLot(false); setSplittingLot(null); }}
        />
      )}

      {showCloseLot && closingLot && (
        <CloseLotModal
          lot={normLot(closingLot)}
          trades={trades}
          onSave={handleCloseLot}
          onClose={() => { setShowCloseLot(false); setClosingLot(null); }}
        />
      )}

      {showAssignment && assigningTrade && (
        <AssignmentModal
          trade={assigningTrade}
          onSave={handleAssignment}
          onClose={() => { setShowAssignment(false); setAssigningTrade(null); }}
        />
      )}

      {showCalledAway && calledAwayTrade && (
        <CalledAwayModal
          trade={calledAwayTrade}
          lots={lots.map(normLot)}
          trades={trades}
          onSave={handleCalledAway}
          onClose={() => { setShowCalledAway(false); setCalledAwayTrade(null); }}
        />
      )}

      {showCloseTrade && closingTrade && (
        <CloseTradeModal
          trade={closingTrade}
          onSave={handleCloseTrade}
          onClose={() => { setShowCloseTrade(false); setClosingTrade(null); }}
          initialPrice={closingTrade ? (currentPrices[closingTrade.id]?.option ?? null) : null}
        />
      )}

      {showExpired && expiredTrade && (
        <ExpiredWorthlessModal
          trade={expiredTrade}
          onSave={handleCloseTrade}
          onClose={() => { setShowExpired(false); setExpiredTrade(null); }}
          currentPrices={currentPrices}
        />
      )}

      {showImport && (
        <ImportModal
          isMock={isMock}
          onImport={handleImport}
          onClose={() => setShowImport(false)}
          lots={lots.map(normLot)}
          existingTrades={trades}
        />
      )}

      {(showDataConn || showFirstLaunch) && (
        <DataConnectionModal
          isFirstLaunch={showFirstLaunch}
          onSave={(provider, apiKey, schwabCreds) => {
            setShowDataConn(false);
            setShowFirstLaunch(false);
            if (provider && provider !== 'none') startPolling(provider, apiKey, schwabCreds);
            else setLiveStatus({ status: 'grey', label: 'No broker connected' });
          }}
          onClose={() => { setShowDataConn(false); setShowFirstLaunch(false); }}
        />
      )}

      {showQuickStart && <QuickStartPanel onClose={() => setShowQuickStart(false)} />}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}

      {adjustingCal && (
        <CalAdjustModal
          trade={adjustingCal.trade}
          chainTrades={adjustingCal.chainTrades}
          onAdjust={handleCalAdjust}
          historicalMode={historicalMode}
          onClose={() => setAdjustingCal(null)}
        />
      )}

      {/* Backup reminder modal */}
      {showBackupModal && (
        <BackupModal
          lastBackup={lastBackup}
          onBackup={() => {
            setLastBackup(new Date().toISOString());
            setShowBackupModal(false);
          }}
          onSkip={() => setShowBackupModal(false)}
          onDisable={() => {
            handleToggleReminder(false);
            setShowBackupModal(false);
          }}
        />
      )}
    </div>
  );
}
