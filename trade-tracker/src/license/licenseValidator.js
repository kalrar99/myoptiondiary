// src/license/licenseValidator.js
// Frontend license validator — SECURITY NOTE:
// All authoritative decisions are made by the backend.
// This file is UI glue only — it calls backend endpoints
// and renders the result. It does NOT make access decisions.

export const GUMROAD_BUY_URL = 'https://optiondiary.gumroad.com/l/rdmiu'; // Replace with your Gumroad checkout URL after setup

export const TRIAL_DAYS = 14;

// Dev mode — only active when running via npm start on port 3000
// Dev mode — active whenever running via react-scripts start (npm start).
// Uses NODE_ENV which react-scripts sets to 'development' unconditionally —
// no .env file required, immune to cache issues and env var loading order.
// Production builds always have NODE_ENV='production' so this is never true in a .exe.
export const IS_DEV_MODE =
  process.env.NODE_ENV === 'development' &&
  typeof window !== 'undefined' &&
  window.location.port === '3000';

function getBase() {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol;
  if (proto === 'app:' || proto === 'file:') { const port = window.__BACKEND_PORT__ || 3002; return `http://127.0.0.1:${port}`; }
  if (proto === 'http:' || proto === 'https:') return 'http://127.0.0.1:3002';
  return '';
}

// ── License storage ───────────────────────────────────────
// localStorage is used ONLY as a UI cache for plan/display info.
// The backend is the sole authority on whether access is granted.
export function saveLicense(key, plan, expires) {
  try {
    // Only cache non-sensitive display info — NOT used for access decisions
    sessionStorage.setItem('ott_license_display', JSON.stringify({ plan, expires }));
  } catch {}
}

export function loadLicense() {
  // Always defer to backend — this is UI-only
  try {
    const raw = sessionStorage.getItem('ott_license_display');
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearLicense() {
  try {
    sessionStorage.removeItem('ott_license_display');
  } catch {}
}

export function daysUntilExpiry(expires) {
  if (!expires) return null;
  const ms = new Date(expires).getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

// ── Trial management ──────────────────────────────────────
// Backend is authoritative — we only read, never write trial state from frontend.
export async function initTrial() {
  try {
    const res = await fetch(getBase() + '/api/license/trial');
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch {}
  // If backend is unreachable, deny access — do not fall back to localStorage
  return { trial_start: null, days_used: 14, days_remaining: 0, expired: true };
}

// ── License key validation ────────────────────────────────
// The backend validates with Paddle server-side.
// This function just passes the key to the backend endpoint.
export async function validateLicenseKey(key) {
  if (!key || key.trim() === '') return { valid: false, error: 'Please enter a license key.' };

  try {
    const res = await fetch(getBase() + '/api/license/activate', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ key: key.trim() }),
    });

    const data = await res.json();

    if (res.ok && data.ok) {
      return { valid: true, plan: data.plan || 'Licensed', expires: data.expires || null };
    }

    // Backend returned an error
    if (res.status === 503) {
      return { valid: false, error: 'Cannot reach the Paddle activation server. Please check your internet connection and try again.' };
    }

    const errorMap = {
      'invalid_key':       'Key not found. Check the key and try again.',
      'expired':           'This key has expired. Please purchase a renewal.',
      'disabled':          'This key has been disabled. Contact support.',
      'key_limit_reached': 'This key has been activated on too many devices.',
    };
    return { valid: false, error: errorMap[data.error] || data.message || 'Validation failed. Please try again.' };

  } catch {
    return { valid: false, error: 'Could not reach the activation server. Check your internet connection.' };
  }
}
