// ExpiryDatePicker.jsx
// Custom calendar for option expiry dates.
// Valid days: Fridays only, except when Friday is a market holiday → Thursday.
// Uses tradingCalendar.js holiday logic (Good Friday, holiday-on-Friday rules).
// Drop-in replacement for <input type="date"> on expiration fields.
// Props:
//   value        — ISO string 'YYYY-MM-DD' or ''
//   onChange     — fn(isoString) called when user picks a valid date
//   min          — ISO string — dates before this are also disabled
//   hasError     — boolean — red border
//   placeholder  — string
//   id           — string (for label htmlFor)

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { isMarketHoliday } from '../utils/tradingCalendar';

// ── Helpers ──────────────────────────────────────────────────────────────────

const toISO = d => { const yr=d.getFullYear(),mo=String(d.getMonth()+1).padStart(2,'0'),dy=String(d.getDate()).padStart(2,'0'); return `${yr}-${mo}-${dy}`; };

// Is this calendar date a valid option expiry?
// Returns: 'friday' | 'thursday-holiday' | false
function expiryType(year, month, day) {
  const d = new Date(year, month, day);
  const dow = d.getDay();       // 0=Sun … 5=Fri … 4=Thu
  const iso = toISO(d);

  if (dow === 5) {
    // Friday — valid unless it's a market holiday
    return isMarketHoliday(iso) ? false : 'friday';
  }
  if (dow === 4) {
    // Thursday — valid only if NEXT day (Friday) is a market holiday
    const fri = new Date(year, month, day + 1);
    const friISO = toISO(fri);
    return (fri.getDay() === 5 && isMarketHoliday(friISO)) ? 'thursday-holiday' : false;
  }
  return false;
}

// Parse 'YYYY-MM-DD' → { year, month, day } (local, no UTC shift)
function parseISO(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return { year: y, month: m - 1, day: d };
}

// Format display e.g. "Apr 18, 2026"
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const SHORT_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun',
                      'Jul','Aug','Sep','Oct','Nov','Dec'];

function formatDisplay(iso) {
  if (!iso) return '';
  const p = parseISO(iso);
  if (!p) return iso;
  const type = expiryType(p.year, p.month, p.day);
  const suffix = type === 'thursday-holiday' ? ' (Thu)' : '';
  const mm = String(p.month + 1).padStart(2, '0');
  const dd = String(p.day).padStart(2, '0');
  return `${mm}/${dd}/${p.year}${suffix}`;
}

// Days in month
function daysInMonth(year, month) {
  return new Date(year, month + 1, 0).getDate();
}

// First weekday of month (0=Sun)
function firstDow(year, month) {
  return new Date(year, month, 1).getDay();
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ExpiryDatePicker({ value, onChange, min, hasError, placeholder = 'Select expiry', id }) {
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() => {
    if (value) { const p = parseISO(value); return p ? p.year : new Date().getFullYear(); }
    return new Date().getFullYear();
  });
  const [viewMonth, setViewMonth] = useState(() => {
    if (value) { const p = parseISO(value); return p ? p.month : new Date().getMonth(); }
    return new Date().getMonth();
  });

  const containerRef = useRef(null);
  // Allow past dates when no min is passed — traders need to enter historical trades
  const minISO = min || null;
  const minParsed = minISO ? parseISO(minISO) : null;

  // Sync view to value when value changes externally
  useEffect(() => {
    if (value) {
      const p = parseISO(value);
      if (p) { setViewYear(p.year); setViewMonth(p.month); }
    }
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const prevMonth = useCallback(() => {
    setViewMonth(m => { if (m === 0) { setViewYear(y => y - 1); return 11; } return m - 1; });
  }, []);
  const nextMonth = useCallback(() => {
    setViewMonth(m => { if (m === 11) { setViewYear(y => y + 1); return 0; } return m + 1; });
  }, []);

  function pickDate(year, month, day) {
    const iso = `${year}-${String(month + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    onChange(iso);
    setOpen(false);
  }

  function isBeforeMin(year, month, day) {
    if (!minParsed) return false;
    if (year < minParsed.year) return true;
    if (year > minParsed.year) return false;
    if (month < minParsed.month) return true;
    if (month > minParsed.month) return false;
    return day < minParsed.day;
  }

  // Build calendar grid
  const totalDays = daysInMonth(viewYear, viewMonth);
  const startDow  = firstDow(viewYear, viewMonth);   // 0=Sun
  // Pad start with empty cells
  const cells = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= totalDays; d++) cells.push(d);
  // Pad end to complete last row
  while (cells.length % 7 !== 0) cells.push(null);

  const selected = parseISO(value);

  // ── Styles ────────────────────────────────────────────────────────────────
  const inputStyle = {
    fontFamily: 'var(--font-sans)',
    fontSize: 13.5,
    color: value ? 'var(--text-primary)' : 'var(--text-muted)',
    background: 'var(--bg-card)',
    border: `1px solid ${hasError ? 'var(--red,#c0392b)' : 'var(--border-strong)'}`,
    borderRadius: 'var(--radius-md)',
    padding: '8px 11px',
    width: '100%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    userSelect: 'none',
    outline: open ? '3px solid rgba(42,92,255,0.12)' : 'none',
    boxShadow: open ? '0 0 0 3px rgba(42,92,255,0.1)' : 'none',
    borderColor: open ? 'var(--accent)' : hasError ? 'var(--red,#c0392b)' : 'var(--border-strong)',
    transition: 'border-color 0.12s, box-shadow 0.12s',
  };

  const dropdownStyle = {
    position: 'fixed',
    zIndex: 99999,
    background: 'var(--bg-card)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius-lg)',
    boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
    width: 272,
    padding: '12px',
  };

  const DOW_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Trigger */}
      <div
        id={id}
        style={inputStyle}
        onClick={() => setOpen(o => !o)}
        role="button"
        tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setOpen(o => !o); }}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span>{value ? formatDisplay(value) : placeholder}</span>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>▾</span>
      </div>

      {/* Calendar dropdown */}
      {open && (() => {
        const rect = containerRef.current?.getBoundingClientRect();
        const CAL_H = 320; // calendar height in px
        const posStyle = rect ? (() => {
          const spaceBelow = window.innerHeight - rect.bottom;
          const spaceAbove = rect.top;
          // Prefer below; flip up only if not enough space below AND more space above
          const goUp = spaceBelow < CAL_H && spaceAbove > spaceBelow;
          const left = Math.min(rect.left, window.innerWidth - 280); // keep within viewport
          if (goUp) {
            // Anchor top of calendar — clamp so it doesn't go above viewport
            const topPos = Math.max(8, rect.top - CAL_H - 4);
            return { left, top: topPos };
          }
          return { left, top: rect.bottom + 4 };
        })() : {};
        return (
        <div style={{ ...dropdownStyle, ...posStyle }}>

          {/* Month nav header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:10 }}>
            <button
              type="button"
              onClick={prevMonth}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-secondary)', fontSize:16, padding:'2px 6px', borderRadius:'var(--radius-sm)' }}
              aria-label="Previous month"
            >‹</button>
            <span style={{ fontWeight:600, fontSize:13, color:'var(--text-primary)' }}>
              {MONTHS[viewMonth]} {viewYear}
            </span>
            <button
              type="button"
              onClick={nextMonth}
              style={{ background:'none', border:'none', cursor:'pointer', color:'var(--text-secondary)', fontSize:16, padding:'2px 6px', borderRadius:'var(--radius-sm)' }}
              aria-label="Next month"
            >›</button>
          </div>

          {/* Hint */}
          <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:8, textAlign:'center', letterSpacing:'0.02em' }}>
            Options expire on Fridays · holidays shift to Thursday
          </div>

          {/* Day-of-week header */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:2, marginBottom:4 }}>
            {DOW_LABELS.map(d => (
              <div key={d} style={{ textAlign:'center', fontSize:10, fontWeight:600,
                color: d === 'Fr' ? 'var(--accent)' : d === 'Th' ? 'var(--amber,#92600a)' : 'var(--text-muted)',
                padding: '2px 0' }}>
                {d}
              </div>
            ))}
          </div>

          {/* Day cells */}
          <div style={{ display:'grid', gridTemplateColumns:'repeat(7, 1fr)', gap:2 }}>
            {cells.map((day, idx) => {
              if (!day) return <div key={`e-${idx}`} />;

              const type = expiryType(viewYear, viewMonth, day);
              const isPast = isBeforeMin(viewYear, viewMonth, day);
              const isValid = type && !isPast;
              const isSelected = selected &&
                selected.year === viewYear &&
                selected.month === viewMonth &&
                selected.day === day;
              const isToday = (() => {
                const t = new Date();
                return t.getFullYear() === viewYear && t.getMonth() === viewMonth && t.getDate() === day;
              })();

              // Visual state
              let bg = 'transparent';
              let color = 'var(--text-muted)';
              let fontWeight = 400;
              let cursor = 'not-allowed';
              let opacity = 0.28;
              let border = 'none';
              let borderRadius = 'var(--radius-sm)';
              let title = '';

              if (isValid) {
                opacity = 1;
                cursor = 'pointer';
                if (type === 'friday') {
                  color = 'var(--accent)';
                  fontWeight = 600;
                  title = 'Valid expiry (Friday)';
                } else {
                  color = 'var(--amber,#92600a)';
                  fontWeight = 600;
                  title = 'Valid expiry — Friday is a market holiday, expires Thursday';
                }
              }
              if (isToday && !isSelected) {
                border = '1px solid var(--border-strong)';
              }
              if (isSelected) {
                bg = 'var(--accent)';
                color = '#fff';
                fontWeight = 700;
                border = 'none';
              }

              return (
                <div
                  key={`d-${day}`}
                  title={title}
                  onClick={() => isValid && pickDate(viewYear, viewMonth, day)}
                  style={{
                    textAlign: 'center',
                    fontSize: 12,
                    fontWeight,
                    color,
                    background: bg,
                    border,
                    borderRadius,
                    padding: '5px 2px',
                    cursor,
                    opacity,
                    transition: 'background 0.1s',
                    position: 'relative',
                  }}
                  onMouseEnter={e => { if (isValid && !isSelected) e.currentTarget.style.background = 'var(--accent-light,#eef1ff)'; }}
                  onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                >
                  {day}
                  {/* Dot indicator for Thu-holiday days */}
                  {type === 'thursday-holiday' && !isSelected && (
                    <span style={{ position:'absolute', bottom:1, left:'50%', transform:'translateX(-50%)',
                      width:3, height:3, borderRadius:'50%', background:'var(--amber,#92600a)', display:'block' }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Legend */}
          <div style={{ display:'flex', gap:12, marginTop:10, paddingTop:8,
            borderTop:'1px solid var(--border)', fontSize:10, color:'var(--text-muted)' }}>
            <span><span style={{ color:'var(--accent)', fontWeight:600 }}>Fri</span> — standard expiry</span>
            <span><span style={{ color:'var(--amber,#92600a)', fontWeight:600 }}>Thu</span> — holiday shift</span>
            <span style={{ opacity:0.4 }}>grey — invalid</span>
          </div>

          {/* Quick-jump: nearest Fridays */}
          <QuickJump minISO={minISO} onPick={iso => { onChange(iso); setOpen(false); }} />
        </div>
      );
      })()}
    </div>
  );
}

// ── Quick-jump strip ──────────────────────────────────────────────────────────
// Shows the next 4 valid expiries as clickable pills

function getNextExpiries(fromISO, count = 4) {
  const results = [];
  const d = new Date(fromISO);
  d.setDate(d.getDate() + 1); // start from tomorrow
  let safetyLimit = 180;
  while (results.length < count && safetyLimit-- > 0) {
    const iso = toISO(d);
    const p = parseISO(iso);
    const type = expiryType(p.year, p.month, p.day);
    if (type) results.push({ iso, type });
    d.setDate(d.getDate() + 1);
  }
  return results;
}

function QuickJump({ minISO, onPick }) {
  const expiries = getNextExpiries(minISO, 4);
  if (!expiries.length) return null;

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize:10, color:'var(--text-muted)', marginBottom:4 }}>Quick jump</div>
      <div style={{ display:'flex', flexWrap:'wrap', gap:4 }}>
        {expiries.map(({ iso, type }) => {
          const p = parseISO(iso);
          const label = `${SHORT_MONTHS[p.month]} ${p.day}`;
          const isHoliday = type === 'thursday-holiday';
          return (
            <button
              key={iso}
              type="button"
              onClick={() => onPick(iso)}
              title={isHoliday ? `${iso} — Thursday (Friday is a market holiday)` : `${iso}`}
              style={{
                fontSize: 11,
                padding: '3px 7px',
                borderRadius: 'var(--radius-sm)',
                border: `1px solid ${isHoliday ? 'var(--amber-border,#f0d898)' : 'var(--border-strong)'}`,
                background: isHoliday ? 'var(--amber-bg,#fffbe6)' : 'var(--bg-hover)',
                color: isHoliday ? 'var(--amber,#92600a)' : 'var(--text-primary)',
                cursor: 'pointer',
                fontWeight: 500,
              }}
            >
              {label}{isHoliday ? ' ⚠' : ''}
            </button>
          );
        })}
      </div>
    </div>
  );
}
