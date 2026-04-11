// src/components/DataConnectionModal.jsx
import React, { useState, useEffect } from 'react';
import { testMarketDataConnection } from '../utils/marketDataQuotes';

function getBase() {
  if (typeof window === 'undefined') return '';
  const p = window.location.protocol;
  if (p === 'app:' || p === 'file:') {
    const port = window.__BACKEND_PORT__ || 3002;
    return `http://127.0.0.1:${port}`;
  }
  if (p === 'http:' || p === 'https:') return 'http://127.0.0.1:3002';
  return '';
}

const PROVIDERS = [
  {
    id:           'marketdata',
    name:         'MarketData.app',
    icon:         '📊',
    description:  'Real-time or 15-min delayed option prices, IV, and Greeks for every open position. Not a broker — data only. 30-day free trial, no card required.',
    docsUrl:      'https://marketdata.app',
    pollInterval: 'On demand',
    free:         false,
    authType:     'token',
    pricing:      'Starter $12/mo (15-min delayed) · Trader $30/mo (real-time)',
    trialUrl:     'https://marketdata.app/register',
  },
  {
    id:           'tradier',
    name:         'Tradier',
    icon:         '📈',
    description:  'Real-time quotes + option greeks. Free sandbox account available.',
    docsUrl:      'https://developer.tradier.com',
    pollInterval: '30 seconds',
    free:         true,
    authType:     'apikey',
  },
  {
    id:           'schwab',
    name:         'Charles Schwab',
    icon:         '🏦',
    description:  'Real-time quotes via Schwab Developer API. Requires a Schwab account.',
    docsUrl:      'https://developer.schwab.com',
    pollInterval: '30 seconds',
    free:         true,
    authType:     'oauth',
  },
  {
    id:           'polygon',
    name:         'Polygon.io',
    icon:         '⬡',
    description:  'Real-time data with paid plan; end-of-day only on free tier.',
    docsUrl:      'https://polygon.io',
    pollInterval: '60 seconds (paid) / end-of-day (free)',
    free:         false,
    authType:     'apikey',
  },
  {
    id:           'none',
    name:         'No live data',
    icon:         '○',
    description:  'Enter prices manually in the Trade Log.',
    pollInterval: '—',
    free:         true,
    authType:     'none',
  },
];

export default function DataConnectionModal({ isFirstLaunch, onSave, onClose }) {
  const [provider,      setProvider]      = useState('none');
  const [apiKey,        setApiKey]        = useState('');
  const [schwabId,      setSchwabId]      = useState('');
  const [schwabSecret,  setSchwabSecret]  = useState('');
  const [schwabStatus,  setSchwabStatus]  = useState(null); // null | 'connected' | 'pending' | 'error'
  const [testing,       setTesting]       = useState(false);
  const [testResult,    setTestResult]    = useState(null);
  const [saving,        setSaving]        = useState(false);

  // Load existing settings and Schwab connection status
  useEffect(() => {
    fetch(getBase() + '/api/settings')
      .then(r => r.ok ? r.json() : null)
      .then(s => {
        if (s) {
          setProvider(s.provider || 'none');
          // Show masked placeholder if a key is already saved, empty if not
          setApiKey(s._hasKey ? s.apiKey : '');  // s.apiKey is already masked ABCD****WXYZ
          setSchwabId(s.schwabClientId || '');
          setSchwabSecret(s.schwabClientSecret || '');
        }
      })
      .catch(() => {});

    // Check if Schwab tokens already exist
    fetch(getBase() + '/api/schwab/status')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.connected) setSchwabStatus('connected'); })
      .catch(() => {});
  }, []);

  // ── Schwab OAuth flow ─────────────────────────────────
  async function startSchwabAuth() {
    if (!schwabId.trim() || !schwabSecret.trim()) {
      setTestResult({ ok: false, msg: 'Enter your Client ID and Client Secret first.' });
      return;
    }

    // Save credentials first so the callback handler can use them
    await fetch(getBase() + '/api/settings', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ schwabClientId: schwabId.trim(), schwabClientSecret: schwabSecret.trim() }),
    }).catch(() => {});

    // Get the auth URL from backend
    const res  = await fetch(getBase() + '/api/schwab/auth-url', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientId: schwabId.trim() }),
    });
    const data = await res.json();
    if (!data.url) { setTestResult({ ok: false, msg: 'Could not generate auth URL.' }); return; }

    // Open Schwab login in system browser
    window.open(data.url, '_blank');
    setSchwabStatus('pending');
    setTestResult({ ok: true, msg: 'Schwab login opened in your browser. After authorizing, come back and click "Check Connection".' });
  }

  async function checkSchwabConnection() {
    setTesting(true);
    try {
      const res  = await fetch(getBase() + '/api/schwab/status');
      const data = await res.json();
      if (data.connected) {
        setSchwabStatus('connected');
        setTestResult({ ok: true, msg: 'Schwab connected successfully! Live prices will start on next poll.' });
      } else {
        setSchwabStatus('error');
        setTestResult({ ok: false, msg: 'Not connected yet. Complete the Schwab authorization in your browser first.' });
      }
    } catch {
      setTestResult({ ok: false, msg: 'Could not reach backend.' });
    }
    setTesting(false);
  }

  async function disconnectSchwab() {
    await fetch(getBase() + '/api/schwab/disconnect', { method: 'POST' }).catch(() => {});
    setSchwabStatus(null);
    setTestResult(null);
  }

  // ── Standard API key test ─────────────────────────────
  async function testConnection() {
    if (provider === 'schwab') { await checkSchwabConnection(); return; }
    if (!apiKey.trim() || provider === 'none') return;
    setTesting(true); setTestResult(null);

    // MarketData.app: test directly from browser (no backend needed)
    if (provider === 'marketdata') {
      const result = await testMarketDataConnection(apiKey.trim());
      setTestResult(result);
      setTesting(false);
      return;
    }

    try {
      const res  = await fetch(getBase() + '/api/live/test', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      const data = await res.json();
      setTestResult(res.ok ? { ok: true, msg: data.message || 'Connection successful!' } : { ok: false, msg: data.error || 'Connection failed.' });
    } catch {
      setTestResult({ ok: false, msg: 'Could not reach backend.' });
    }
    setTesting(false);
  }

  // ── Save ──────────────────────────────────────────────
  async function save() {
    setSaving(true);
    try {
      await fetch(getBase() + '/api/settings', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          provider,
          apiKey:             apiKey.trim(),
          schwabClientId:     schwabId.trim(),
          schwabClientSecret: schwabSecret.trim(),
          firstLaunchDone:    true,
        }),
      });
    } catch {}
    setSaving(false);
    onSave(provider, apiKey.trim(), { schwabClientId: schwabId.trim(), schwabClientSecret: schwabSecret.trim() });
  }

  const selectedProvider = PROVIDERS.find(p => p.id === provider);

  return (
    <div className="modal-backdrop" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <div>
            <h3>{isFirstLaunch ? '👋 Welcome to MyOptionDiary' : '⚙️ Live Data Settings'}</h3>
            {isFirstLaunch && (
              <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 4 }}>
                Connect a live data provider to see real-time prices in your Trade Log and Dashboard. You can skip this and set it up later.
              </p>
            )}
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="modal-section-title">Select Data Provider</div>
        {PROVIDERS.map(p => (
          <div
            key={p.id}
            className={`provider-card ${provider === p.id ? 'active' : ''}`}
            onClick={() => { setProvider(p.id); setTestResult(null); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 22 }}>{p.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                  {p.name}
                  {p.free && <span className="badge badge-green" style={{ fontSize: 10 }}>Free tier</span>}
                  {p.id === 'schwab' && schwabStatus === 'connected' && (
                    <span className="badge badge-green" style={{ fontSize: 10 }}>● Connected</span>
                  )}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 2 }}>{p.description}</div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Poll interval: {p.pollInterval}</div>
              </div>
              {provider === p.id && <span style={{ color: 'var(--accent)', fontSize: 18 }}>✓</span>}
            </div>
          </div>
        ))}

        {/* ── MarketData.app: API token ── */}
        {provider === 'marketdata' && (
          <>
            <div style={{ background:'var(--blue-bg)', border:'1px solid var(--blue-border)', borderRadius:8, padding:'12px 14px', marginBottom:12 }}>
              <div style={{ fontWeight:700, fontSize:13, color:'var(--blue)', marginBottom:4 }}>
                📊 Why MarketData.app?
              </div>
              <div style={{ fontSize:12, color:'var(--text-secondary)', lineHeight:1.6 }}>
                Yahoo Finance (the default) works for stock prices but option prices and Greeks are often unavailable,
                meaning P&amp;L calculations fall back to estimates. MarketData.app gives you <strong>exact option prices,
                live IV, and real Greeks</strong> for every open position — so every alert, roll scenario, and P&amp;L
                figure uses real market data.
              </div>
              <div style={{ marginTop:8, fontSize:12 }}>
                <strong>Starter $12/mo</strong> (15-min delayed — sufficient for most wheel traders) &nbsp;·&nbsp;
                <strong>Trader $30/mo</strong> (real-time) &nbsp;·&nbsp;
                <a href="https://marketdata.app/register" target="_blank" rel="noopener noreferrer" style={{ color:'var(--accent)', fontWeight:700 }}>
                  30-day free trial →
                </a>
              </div>
            </div>
            <div className="modal-section-title">API Token</div>
            <div className="form-group">
              <input
                type="password"
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setTestResult(null); }}
                placeholder="Paste your MarketData.app API token here"
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
                Get your free token at{' '}
                <a href="https://marketdata.app" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                  marketdata.app
                </a>
                {' '}→ Dashboard → API Token. Your token never leaves this device.
              </div>
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={testConnection}
              disabled={testing || !apiKey.trim()}
              style={{ marginBottom: 10 }}
            >
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <div className={`alert ${testResult.ok ? 'alert-green' : 'alert-red'}`} style={{ fontSize: 12, marginBottom: 8 }}>
                {testResult.ok ? '✓ ' : '✗ '}{testResult.msg}
              </div>
            )}
          </>
        )}

        {/* ── Tradier / Polygon: plain API key ── */}
        {(provider === 'tradier' || provider === 'polygon') && (
          <>
            <div className="modal-section-title">API Key</div>
            <div className="form-group">
              <input
                type="password"
                value={apiKey}
                onChange={e => { setApiKey(e.target.value); setTestResult(null); }}
                placeholder={`Paste your ${provider === 'tradier' ? 'Tradier' : 'Polygon.io'} API key here`}
                style={{ fontFamily: 'var(--font-mono)' }}
              />
              <div style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 5 }}>
                Get your free key at{' '}
                <a href={selectedProvider?.docsUrl} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                  {selectedProvider?.docsUrl}
                </a>
              </div>
            </div>
            <button
              className="btn btn-outline btn-sm"
              onClick={testConnection}
              disabled={testing || !apiKey.trim()}
              style={{ marginBottom: 10 }}
            >
              {testing ? 'Testing...' : '🔌 Test Connection'}
            </button>
          </>
        )}

        {/* ── Schwab: OAuth 2.0 flow ── */}
        {provider === 'schwab' && (
          <>
            <div className="modal-section-title">Schwab Developer Credentials</div>
            <div className="alert alert-blue" style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
                <strong>One-time setup at{' '}
                <a href="https://developer.schwab.com" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>developer.schwab.com</a>:</strong>
                <ol style={{ margin: '6px 0 0 16px', padding: 0 }}>
                  <li>Sign in with your regular Schwab credentials → <strong>Dashboard → Apps → Create App</strong></li>
                  <li>App Name: anything (e.g. MyOptionDiary) · Products: <strong>Accounts and Trading Production</strong></li>
                  <li>Callback URL — register <strong>all three</strong> of these (Schwab allows multiple):
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, background: 'var(--bg-hover)', borderRadius: 4, padding: '4px 8px', margin: '4px 0', lineHeight: 1.9 }}>
                      https://127.0.0.1:3002/api/schwab/callback<br/>
                      https://127.0.0.1:3003/api/schwab/callback<br/>
                      https://127.0.0.1:3004/api/schwab/callback
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                      The app picks port 3002 first — 3003/3004 are fallbacks if 3002 is in use on your machine.
                      Registering all three means it works regardless of which port wins.
                    </span>
                  </li>
                  <li>Copy your <strong>App Key</strong> (Client ID) and <strong>Secret</strong> — paste them below</li>
                </ol>
              </div>
            </div>

            <div className="form-grid-2" style={{ marginBottom: 10 }}>
              <div className="form-group">
                <label className="form-label">App Key (Client ID)</label>
                <input
                  type="password"
                  value={schwabId}
                  onChange={e => { setSchwabId(e.target.value); setTestResult(null); }}
                  placeholder="Your Schwab App Key"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Client Secret</label>
                <input
                  type="password"
                  value={schwabSecret}
                  onChange={e => { setSchwabSecret(e.target.value); setTestResult(null); }}
                  placeholder="Your Schwab Client Secret"
                  style={{ fontFamily: 'var(--font-mono)' }}
                />
              </div>
            </div>

            {schwabStatus !== 'connected' ? (
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={startSchwabAuth}
                  disabled={!schwabId.trim() || !schwabSecret.trim()}
                >
                  🔑 Authorize with Schwab
                </button>
                {schwabStatus === 'pending' && (
                  <button className="btn btn-outline btn-sm" onClick={checkSchwabConnection} disabled={testing}>
                    {testing ? 'Checking...' : '↻ Check Connection'}
                  </button>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <div className="alert alert-green" style={{ flex: 1, margin: 0 }}>
                  ✓ Schwab is authorized and connected.
                </div>
                <button className="btn btn-outline btn-sm" onClick={disconnectSchwab} style={{ flexShrink: 0 }}>
                  Disconnect
                </button>
              </div>
            )}
          </>
        )}

        {testResult && (
          <div className={`alert ${testResult.ok ? 'alert-green' : 'alert-red'}`} style={{ marginBottom: 10 }}>
            {testResult.ok ? '✓ ' : '✕ '}{testResult.msg}
          </div>
        )}

        <div className="alert alert-blue" style={{ marginTop: 4 }}>
          <div>
            <strong>Note:</strong> Live prices are fetched only during market hours (9:30am–4:00pm ET, Mon–Fri).
          </div>
        </div>

        <div className="modal-footer">
          {isFirstLaunch && (
            <button className="btn btn-outline" onClick={async () => {
              try {
                await fetch(getBase() + '/api/settings', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ provider: 'none', apiKey: '', firstLaunchDone: true }),
                });
              } catch {}
              onSave('none', '');
            }}>Skip for now</button>
          )}
          {!isFirstLaunch && (
            <button className="btn btn-outline" onClick={onClose}>Cancel</button>
          )}
          <button className="btn btn-primary" onClick={save} disabled={saving}>
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}
