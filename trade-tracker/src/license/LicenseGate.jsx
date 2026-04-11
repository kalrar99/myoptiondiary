// src/license/LicenseGate.jsx
import React, { useState, useEffect } from 'react';
import {
  IS_DEV_MODE,
  validateLicenseKey,
  saveLicense,
  loadLicense,
  clearLicense,
  daysUntilExpiry,
  initTrial,
  TRIAL_DAYS,
  GUMROAD_BUY_URL,
} from './licenseValidator';

const font     = "'DM Sans', sans-serif";
const fontMono = "'DM Mono', monospace";
const accent   = '#2a5cff';
const green    = '#1a7a4a';
const red      = '#c0392b';
const amber    = '#92600a';

// ── BuyButton ────────────────────────────────────────────
function BuyButton({ label, onClick }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', padding: '11px 16px', borderRadius: 8, border: 'none',
      background: green, color: '#fff', fontFamily: font, fontSize: 14,
      fontWeight: 700, cursor: 'pointer', marginBottom: 8,
    }}>
      {label}
    </button>
  );
}

// ── ActivateScreen ───────────────────────────────────────
function ActivateScreen({ mode, onActivated }) {
  const [key, setKey]           = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [showBuy, setShowBuy]   = useState(mode !== 'activate');

  async function activate() {
    if (!key.trim()) { setError('Please enter a license key.'); return; }
    setLoading(true); setError('');
    const result = await validateLicenseKey(key);
    setLoading(false);
    if (result.valid) {
      saveLicense(key.trim(), result.plan, result.expires);
      onActivated();
    } else {
      setError(result.error || 'Activation failed.');
      setShowBuy(true);
    }
  }

  const modeMsg = {
    trial_expired:   { bg: '#fdf0ee', border: '#f0c4be', color: red, text: 'Your 14-day free trial has ended. Purchase a license or enter a key.' },
    license_expired: { bg: '#fdf0ee', border: '#f0c4be', color: red, text: 'Your license has expired. Purchase a renewal or enter a new key.' },
    activate:        null,
  }[mode];

  const buyLabel = mode === 'license_expired' ? '🛒 Renew My License' : '🛒 Buy a License — from $19.99';

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#f5f4f0', fontFamily: font, padding: 20,
    }}>
      <div style={{ background: '#fff', borderRadius: 16, padding: 36, width: '100%', maxWidth: 420, boxShadow: '0 8px 32px rgba(0,0,0,0.12)' }}>
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>📈</div>
          <h1 style={{ fontSize: 22, fontWeight: 800, color: '#1a1a18', marginBottom: 4 }}>MyOptionDiary</h1>
        </div>

        {modeMsg && (
          <div style={{ background: modeMsg.bg, border: `1px solid ${modeMsg.border}`, color: modeMsg.color, borderRadius: 8, padding: '10px 14px', fontSize: 13, marginBottom: 16 }}>
            {modeMsg.text}
          </div>
        )}

        {!modeMsg && (
          <p style={{ fontSize: 13, color: '#6b6860', marginBottom: 16, textAlign: 'center' }}>Enter your license key to unlock full access.</p>
        )}

        {showBuy && (
          <>
            <BuyButton label={buyLabel} onClick={() => window.open(GUMROAD_BUY_URL, '_blank')} />
            <div style={{ textAlign: 'center', fontSize: 12, color: '#a8a49c', margin: '12px 0' }}>Already have a key? Enter it below</div>
          </>
        )}

        <input
          type="text"
          placeholder="XXXX-XXXX-XXXX-XXXX"
          value={key}
          onChange={e => { setKey(e.target.value.toUpperCase()); setError(''); }}
          onKeyDown={e => e.key === 'Enter' && activate()}
          style={{
            width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid #d0cec8',
            fontFamily: fontMono, fontSize: 15, letterSpacing: 2, marginBottom: 10, outline: 'none',
            boxSizing: 'border-box',
          }}
        />

        {error && <div style={{ color: red, fontSize: 12.5, marginBottom: 10 }}>{error}</div>}

        <button
          onClick={activate}
          disabled={loading}
          style={{
            width: '100%', padding: '11px', borderRadius: 8, border: 'none',
            background: loading ? '#a0aec0' : accent, color: '#fff',
            fontFamily: font, fontSize: 14, fontWeight: 700, cursor: loading ? 'not-allowed' : 'pointer',
            opacity: loading ? 0.7 : 1,
          }}
        >
          {loading ? 'Validating...' : 'Activate License'}
        </button>

        {mode === 'license_expired' && (
          <button onClick={clearLicense} style={{ background: 'none', border: 'none', color: '#6b6860', fontSize: 12, cursor: 'pointer', marginTop: 12, width: '100%' }}>
            Use a different key
          </button>
        )}

        <p style={{ fontSize: 11.5, color: '#a8a49c', textAlign: 'center', marginTop: 16, lineHeight: 1.5 }}>
          After purchase, Paddle will email you your license key automatically. Check your spam folder if you do not see it within a few minutes.
        </p>
      </div>
    </div>
  );
}

// ── TrialBanner ──────────────────────────────────────────
function TrialBanner({ daysRemaining, onActivate }) {
  let bg, color, icon, urgency = '';
  if (daysRemaining > 7)        { bg = '#eef4ff'; color = '#1a5fa8'; icon = '🕐'; }
  else if (daysRemaining >= 4)  { bg = '#fdf5e6'; color = amber;     icon = '⚠️'; }
  else if (daysRemaining >= 1)  { bg = '#fdf0ee'; color = red;       icon = '🚨'; urgency = ' Act now to keep your data.'; }
  else                          { bg = '#fdf0ee'; color = red;       icon = '🚨'; urgency = ' Last day! Trial ends today.'; }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: bg, padding: '8px 16px', fontSize: 13, color,
      borderBottom: `1px solid ${color}22`,
    }}>
      <span>{icon} Free trial: {daysRemaining} day{daysRemaining !== 1 ? 's' : ''} remaining.{urgency}</span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={() => window.open(GUMROAD_BUY_URL, '_blank')} style={{
          padding: '4px 12px', borderRadius: 6, border: 'none', background: green, color: '#fff',
          fontFamily: font, fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>🛒 Buy Now</button>
        <button onClick={onActivate} style={{
          padding: '4px 12px', borderRadius: 6, border: `1px solid ${color}`, background: 'transparent', color,
          fontFamily: font, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>Enter Key</button>
      </div>
    </div>
  );
}

// ── ExpiryBanner ─────────────────────────────────────────
function ExpiryBanner({ daysRemaining, onRenew }) {
  const urgent = daysRemaining <= 7;
  const bg     = urgent ? '#fdf0ee' : '#fffbe6';
  const color  = urgent ? red : amber;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: bg, padding: '8px 16px', fontSize: 13, color,
      borderBottom: `1px solid ${color}33`,
    }}>
      <span>⚠️ License expires in {daysRemaining} day{daysRemaining !== 1 ? 's' : ''}.{urgent ? ' Renew to keep access.' : ''}</span>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <button onClick={() => window.open(GUMROAD_BUY_URL, '_blank')} style={{
          padding: '4px 12px', borderRadius: 6, border: 'none', background: color, color: '#fff',
          fontFamily: font, fontSize: 12, fontWeight: 700, cursor: 'pointer',
        }}>🛒 Renew Now</button>
        <button onClick={onRenew} style={{
          padding: '4px 12px', borderRadius: 6, border: `1px solid ${color}`, background: 'transparent', color,
          fontFamily: font, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        }}>Enter Key</button>
      </div>
    </div>
  );
}

// ── LicenseGate ──────────────────────────────────────────
export default function LicenseGate({ children }) {
  const [screen, setScreen]           = useState('checking');
  const [expiryDays, setExpiryDays]   = useState(null);
  const [trialDays, setTrialDays]     = useState(TRIAL_DAYS);
  const [showActivate, setShowActivate] = useState(false);

  useEffect(() => {
    async function check() {
      if (IS_DEV_MODE) { setScreen('licensed'); return; }

      // Always verify with backend — sessionStorage is UI cache only, not authoritative
      // This prevents a DevTools sessionStorage manipulation from bypassing the gate
      try {
        const statusRes = await fetch('/api/license/status');
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (!status.allowed) {
            setScreen(status.reason === 'license_expired' ? 'license_expired' : 'trial_expired');
            return;
          }
          if (status.mode === 'licensed') {
            const lic = loadLicense();
            const days = lic ? daysUntilExpiry(lic.expires) : null;
            setExpiryDays(days);
            setScreen('licensed');
            return;
          }
          if (status.mode === 'trial') {
            setTrialDays(status.daysRemaining ?? TRIAL_DAYS);
            setScreen('trial');
            return;
          }
        }
      } catch {
        // Backend unreachable — fall back to cached check
      }

      const lic = loadLicense();
      if (lic) {
        const days = daysUntilExpiry(lic.expires);
        if (days !== null && days <= 0) { setScreen('license_expired'); return; }
        setExpiryDays(days);
        setScreen('licensed');
        return;
      }

      const trial = await initTrial();
      if (trial.expired) { setScreen('trial_expired'); return; }
      setTrialDays(trial.days_remaining);
      setScreen('trial');
    }
    check();
  }, []);

  if (screen === 'checking') {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', fontFamily: font, color: '#f0efe9', background: '#1c1c1a', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 32 }}>📈</div>
        <p style={{ margin: 0 }}>Checking access...</p>
      </div>
    );
  }

  if (screen === 'trial_expired')   return <ActivateScreen mode="trial_expired"   onActivated={() => setScreen('licensed')} />;
  if (screen === 'license_expired') return <ActivateScreen mode="license_expired" onActivated={() => { clearLicense(); setScreen('licensed'); }} />;

  if (showActivate) return <ActivateScreen mode="activate" onActivated={() => { setShowActivate(false); setScreen('licensed'); }} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {screen === 'trial' && (
        <TrialBanner daysRemaining={trialDays} onActivate={() => setShowActivate(true)} />
      )}
      {screen === 'licensed' && expiryDays !== null && expiryDays <= 14 && expiryDays > 0 && (
        <ExpiryBanner daysRemaining={expiryDays} onRenew={() => { clearLicense(); setScreen('license_expired'); }} />
      )}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  );
}
