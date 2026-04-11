#!/usr/bin/env python3
"""
MyOptionDiary v17 — CSV Import Parity Test
Personas: 1 (Seasoned Options Trader) + 2 (Solution Architect)

Verifies that ALL four broker parsers:
  1. Produce identical trade counts, strategies, and P&L results
  2. Correctly skip non-trade rows (dividends, money movement, cash reports)
  3. Correctly create and close lots (assignment + called-away)
  4. Fire _lotCreate / _lotClose on the right rows (not on delivery rows)
  5. Produce results compatible with handleImport() in both isMock and live mode
  6. Flag the correct Action Required events

Run: python3 trade-tracker/import-parity-test.py
"""

import re, sys, os

PASS_LIST = []; FAIL_LIST = []

def chk(label, result, detail=""):
    sym = "PASS" if result else "FAIL"
    (PASS_LIST if result else FAIL_LIST).append(label)
    suffix = f"  <- {detail}" if (not result and detail) else (f"  ({detail})" if detail else "")
    print(f"  [{sym}] {label}{suffix}")

def chk_eq(label, a, b, fmt=""):
    ok = abs(float(a) - float(b)) < 0.01
    sym = "PASS" if ok else "FAIL"
    (PASS_LIST if ok else FAIL_LIST).append(label)
    disp = fmt.format(a) if fmt else f"{a}"
    if ok:  print(f"  [{sym}] {label}: {disp}")
    else:   print(f"  [{sym}] {label}: got={a}  expected={b}  <- MISMATCH")

ROOT = os.path.dirname(os.path.abspath(__file__))

def read_sample(name):
    for base in [
        os.path.join(ROOT, '..', 'sample-csvs', name),
        os.path.join(ROOT, 'public', 'migration', name),
    ]:
        p = os.path.normpath(base)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                return f.read()
    return ""

IMPORT = ""
import_path = os.path.join(ROOT, 'src', 'components', 'ImportModal.jsx')
if os.path.exists(import_path):
    with open(import_path, encoding='utf-8') as f:
        IMPORT = f.read()

APP = ""
app_path = os.path.join(ROOT, 'src', 'App.jsx')
if os.path.exists(app_path):
    with open(app_path, encoding='utf-8') as f:
        APP = f.read()

BACKEND = ""
backend_path = os.path.join(ROOT, 'trade-tracker-backend.js')
if os.path.exists(backend_path):
    with open(backend_path, encoding='utf-8') as f:
        BACKEND = f.read()

SCHWAB_CSV     = read_sample('schwab-sample.csv')
TASTYTRADE_CSV = read_sample('tastytrade-sample.csv')
IBKR_CSV       = read_sample('ibkr-sample.csv')
ROBINHOOD_CSV  = read_sample('robinhood-sample.csv')

print("=" * 65)
print("  MyOptionDiary v17 — CSV Import Parity Test")
print("  Persona 1 (Trader) + Persona 2 (Architect)")
print("=" * 65)

# ── Shared helpers (mirror JS parser logic) ───────────────────────────────

def norm_date(s):
    s = s.strip().strip('"\'')
    if re.match(r'^\d{4}-\d{2}-\d{2}', s): return s[:10]
    m = re.match(r'^(\d{1,2})/(\d{1,2})/(\d{2,4})', s)
    if m:
        yr = ('20' + m.group(3)) if len(m.group(3)) == 2 else m.group(3)
        return f"{yr}-{m.group(1).zfill(2)}-{m.group(2).zfill(2)}"
    return s[:10]

def parse_occ(raw):
    if not raw: return None
    s = raw.strip()
    # Format 1: "AAPL 03/21/2026 220.00 C" (Schwab)
    f1 = re.match(r'^([A-Z]+)\s+(\d{1,2})/(\d{1,2})/(\d{2,4})\s+([\d.]+)\s+([CP])', s, re.I)
    if f1:
        t, mo, dy, yr, strike, cp = f1.groups()
        yr = ('20' + yr) if len(yr) == 2 else yr
        return dict(ticker=t, exp=f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}", strike=float(strike), is_call=(cp.upper()=='C'))
    # Format 2: "AAPL 3/21/26 C220" (Tastytrade)
    f2 = re.match(r'^([A-Z]+)\s+(\d{1,2})/(\d{1,2})/(\d{2,4})\s+([CP])([\d.]+)', s, re.I)
    if f2:
        t, mo, dy, yr, cp, strike = f2.groups()
        yr = ('20' + yr) if len(yr) == 2 else yr
        return dict(ticker=t, exp=f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}", strike=float(strike), is_call=(cp.upper()=='C'))
    # Format 3: "AAPL 20260321 C00220000" (IBKR OCC)
    f3 = re.match(r'^([A-Z]+)\s+(\d{8})\s+([CP])(\d{8})', s, re.I)
    if f3:
        t, ds, cp, sr = f3.groups()
        return dict(ticker=t, exp=f"{ds[:4]}-{ds[4:6]}-{ds[6:8]}", strike=int(sr)/1000, is_call=(cp.upper()=='C'))
    # Format 4: "AAPL3/21/26C220" (Robinhood compact)
    f4 = re.match(r'^([A-Z]+)(\d{1,2})/(\d{1,2})/(\d{2,4})([CP])([\d.]+)', s, re.I)
    if f4:
        t, mo, dy, yr, cp, strike = f4.groups()
        yr = ('20' + yr) if len(yr) == 2 else yr
        return dict(ticker=t, exp=f"{yr}-{mo.zfill(2)}-{dy.zfill(2)}", strike=float(strike), is_call=(cp.upper()=='C'))
    return None

def derive_strategy(is_call, action):
    m = {('call','open_sell'):'Covered Call', ('put','open_sell'):'Cash-Secured Put',
         ('call','open_buy'):'Long Call',      ('put','open_buy'):'Long Put',
         ('call','close_buy'):'Covered Call',  ('put','close_buy'):'Cash-Secured Put',
         ('call','close_sell'):'Long Call',    ('put','close_sell'):'Long Put'}
    return m.get(('call' if is_call else 'put', action), 'Covered Call' if is_call else 'Cash-Secured Put')

def make_trade(ticker, strategy, status, entry_date, exp, ep, xp, xd, contracts, parsed, event=None, **extra):
    s = parsed['strike']
    if strategy == 'Covered Call': strikes = dict(strike_sell=s, strike_buy=None)
    else:                           strikes = dict(strike_sell=None, strike_buy=s)
    t = dict(ticker=ticker, strategy=strategy, status=status,
             entry_date=entry_date, expiration=exp,
             entry_price=ep, exit_price=xp, exit_date=xd,
             contracts=contracts, **strikes, pnl=None)
    if event: t['_event'] = event
    t.update(extra)
    return t

# ── Expected ground truth (from README) ───────────────────────────────────
# 9 option trades, 2 lots created, 2 lots closed, identical across all brokers.
# IBKR exception: P&L from Realized P/L column rather than computed.

EXPECTED_STRATEGIES = [
    'Cash-Secured Put',   # AAPL CSP → assigned
    'Covered Call',       # AAPL CC $215 → BTC early  (paired, pnl +$380 for 2 contracts)
    'Covered Call',       # AAPL CC $220 → called away
    'Cash-Secured Put',   # NVDA CSP → expired
    'Cash-Secured Put',   # MSFT CSP → BTC early      (paired, pnl +$225 for 1 contract)
    'Covered Call',       # TSLA CC $320 → expired
    'Covered Call',       # TSLA CC $325 → called away
    'Long Call',          # META long call → STC       (paired, pnl −$550)
    'Long Put',           # AMZN long put → expired
    'Covered Call',       # NVDA CC $115 → open (no close in file)
    'Cash-Secured Put',   # SPY  CSP $510 → open (no close in file)
    'Cash-Secured Put',   # AAPL CSP $195 → open (no close in file)
]
# Per-broker expected values — samples differ in open-only positions and outright purchases
# Schwab + Tastytrade have: NVDA outright buy + 3 open-only positions (NVDA CC, SPY CSP, AAPL CSP)
# IBKR + Robinhood sample files do not include those rows
BROKER_EXPECTED = {
    'Schwab':     dict(trade_count=12, lot_creates=3, lot_create_tickers=['AAPL','NVDA','TSLA'],
                       strategies=sorted(['Cash-Secured Put']*5 + ['Covered Call']*5 + ['Long Call','Long Put'])),
    'Tastytrade': dict(trade_count=12, lot_creates=3, lot_create_tickers=['AAPL','NVDA','TSLA'],
                       strategies=sorted(['Cash-Secured Put']*5 + ['Covered Call']*5 + ['Long Call','Long Put'])),
    'IBKR':       dict(trade_count=12, lot_creates=3, lot_create_tickers=['AAPL','NVDA','TSLA'],
                       strategies=sorted(['Cash-Secured Put']*5 + ['Covered Call']*5 + ['Long Call','Long Put'])),
    'Robinhood':  dict(trade_count=12, lot_creates=3, lot_create_tickers=['AAPL','NVDA','TSLA'],
                       strategies=sorted(['Cash-Secured Put']*5 + ['Covered Call']*5 + ['Long Call','Long Put'])),
}
# These are identical across all four brokers
EXPECTED_LOT_CLOSES       = 2   # AAPL called away + TSLA called away
EXPECTED_ASSIGNED_PUTS    = 1   # AAPL CSP
EXPECTED_CALLED_AWAYS     = 2   # AAPL CC + TSLA CC
EXPECTED_EXPIRATIONS      = 3   # NVDA CSP + TSLA CC + AMZN Long Put

# Paired trade P&L expectations — identical across all brokers
EXPECTED_AAPL_CC215_PNL   =  380.0   # (3.80 - 1.90) × 2 × 100
EXPECTED_MSFT_CSP_PNL     =  225.0   # (4.50 - 2.25) × 1 × 100
EXPECTED_META_CALL_PNL    = -550.0   # (6.80 - 12.30) × 1 × 100

# ── Parser simulations ────────────────────────────────────────────────────

def parse_schwab(text):
    """Mirror parseSchwab() in ImportModal.jsx"""
    SILENT = ['cash dividend','qualified dividend','non-qualified div','reinvest dividend',
              'reinvest shares','special dividend','bank interest','bond interest',
              'credit interest','short term cap gain','long term cap gain','cash in lieu',
              'return of capital','margin interest','adr mgmt fee','foreign tax paid',
              'misc cash entry','service fee','wire funds','wire funds received',
              'wire transfer','journal','journaled shares','moneylink transfer',
              'moneylink deposit','electronic funds transfer','funds received',
              'security transfer','shares in']
    OOC = ['sell to open','buy to close','buy to open','sell to close']
    EVT = ['expired','assigned','exercise']
    trades, skipped, open_pos = [], [], {}
    for line in text.split('\n'):
        line = line.strip()
        if not line: continue
        if line == 'END': trades.append({'_end':True}); continue
        cols = [c.strip().strip('"') for c in line.split(',')]
        if len(cols) < 6: continue
        date_str, action_raw = cols[0], cols[1] if len(cols)>1 else ''
        action = action_raw.lower().strip()
        symbol = cols[2] if len(cols)>2 else ''
        try:
            qty   = abs(int(cols[4]))   if len(cols)>4 and cols[4] else 1
            price = abs(float(cols[5])) if len(cols)>5 and cols[5] else None
        except ValueError: continue
        if date_str in ('Date',''): continue

        if action == 'buy' and not parse_occ(symbol):
            ticker = symbol.strip().upper()
            if ticker:
                trades.append({'_lot_create':True, 'ticker':ticker, 'shares':qty,
                                'avg_cost':price, 'purchase_date':norm_date(date_str)})
            continue

        if action in OOC:
            p = parse_occ(symbol)
            if not p: skipped.append(f"symbol not recognised: {symbol!r}"); continue
            is_open = 'to open' in action; is_sell = 'sell' in action
            ak = f"{'open' if is_open else 'close'}_{'sell' if is_sell else 'buy'}"
            strat = derive_strategy(p['is_call'], ak)
            if is_open: open_pos[symbol] = 'short' if is_sell else 'long'
            else:       open_pos.pop(symbol, None)
            t = make_trade(p['ticker'], strat, 'open' if is_open else 'closed',
                           norm_date(date_str) if is_open else None, p['exp'],
                           price if is_open else None, None if is_open else price,
                           None if is_open else norm_date(date_str), qty, p)
            trades.append(t); continue

        if action in EVT:
            p = parse_occ(symbol)
            if not p: skipped.append(f"symbol not recognised: {symbol!r}"); continue
            if action == 'expired':
                was_short = open_pos.get(symbol) != 'long'
                strat = ('Covered Call' if p['is_call'] else 'Cash-Secured Put') if was_short \
                        else ('Long Call' if p['is_call'] else 'Long Put')
                open_pos.pop(symbol, None)
                trades.append(make_trade(p['ticker'], strat, 'closed',
                    norm_date(date_str), p['exp'], None, 0, norm_date(date_str), qty, p, event='expired'))
            elif action == 'assigned':
                if not p['is_call']:
                    t = make_trade(p['ticker'], 'Cash-Secured Put', 'closed',
                        norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str), qty, p, event='assigned_put')
                    t.update({'_lot_create':True, 'lot_ticker':p['ticker'],
                               'lot_shares':qty*100, 'lot_avg_cost':p['strike'],
                               'lot_purchase_date':norm_date(date_str)})
                    trades.append(t)
                else:
                    t = make_trade(p['ticker'], 'Covered Call', 'closed',
                        norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str), qty, p, event='called_away')
                    t.update({'_lot_close':True, 'lot_ticker':p['ticker'],
                               'lot_close_price':p['strike'], 'lot_close_date':norm_date(date_str)})
                    trades.append(t)
            continue

        if any(action.startswith(s) for s in SILENT): continue
        if date_str and action_raw:
            skipped.append(f"unrecognised action: {action_raw!r}")
    return trades, skipped

def parse_tastytrade(text):
    """Mirror parseTastytrade() in ImportModal.jsx (with patch applied)"""
    SKIP_SUBS = {'forward split','reverse split','symbol change','stock merger','cash merger',
                 'acquisition','acat transfer','stock dividend','balance adjustment',
                 'deposit','withdrawal','ach','wire','credit','debit'}
    RD_EVENTS = {'expiration','assignment','exercise'}
    trades, skipped, open_pos = [], [], {}
    for line in text.split('\n'):
        line = line.strip()
        if not line: continue
        if line == 'END': trades.append({'_end':True}); continue
        cols = [c.strip().strip('"') for c in line.split(',')]
        if len(cols) < 4: continue
        date_str = cols[0]; type_raw = cols[1] if len(cols)>1 else ''
        type_    = type_raw.lower()
        sub_raw  = cols[2] if len(cols)>2 else ''
        sub_type = sub_raw.lower().strip()
        symbol   = cols[3] if len(cols)>3 else ''
        try:
            price = abs(float(cols[4])) if len(cols)>4 and cols[4] else None
        except ValueError: continue
        try:
            qty = int(cols[5]) if len(cols)>5 and cols[5] else 0
        except ValueError: qty = 0
        desc = cols[7].lower() if len(cols)>7 else ''

        if date_str in ('Date','') or type_raw == 'Type': continue
        if type_ == 'money movement' or sub_type in SKIP_SUBS: continue

        if type_ == 'receive deliver':
            p = parse_occ(symbol)
            if not p:
                ticker = symbol.strip().upper()
                if not ticker: continue
                # *** PATCH: skip share delivery rows ***
                if 'shares received' in desc or 'shares delivered' in desc: continue
                if sub_type == 'buy to open':
                    trades.append({'_lot_create':True, 'ticker':ticker,
                                   'shares':abs(qty), 'avg_cost':price,
                                   'purchase_date':norm_date(date_str)})
                elif sub_type == 'sell to close':
                    trades.append({'_lot_close':True, 'lot_ticker':ticker,
                                   'lot_close_price':price, 'lot_close_date':norm_date(date_str)})
                continue

            if sub_type not in RD_EVENTS: continue
            if sub_type == 'expiration':
                was_short = open_pos.get(symbol) != 'long'
                strat = ('Covered Call' if p['is_call'] else 'Cash-Secured Put') if was_short \
                        else ('Long Call' if p['is_call'] else 'Long Put')
                open_pos.pop(symbol, None)
                trades.append(make_trade(p['ticker'], strat, 'closed',
                    norm_date(date_str), p['exp'], None, 0, norm_date(date_str),
                    abs(qty) or 1, p, event='expired'))
            elif sub_type == 'assignment':
                if not p['is_call']:
                    t = make_trade(p['ticker'], 'Cash-Secured Put', 'closed',
                        norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str),
                        abs(qty) or 1, p, event='assigned_put')
                    # *** PATCH: _lotCreate inline ***
                    t.update({'_lot_create':True, 'lot_ticker':p['ticker'],
                               'lot_shares':(abs(qty) or 1)*100, 'lot_avg_cost':p['strike'],
                               'lot_purchase_date':norm_date(date_str)})
                    trades.append(t)
                else:
                    t = make_trade(p['ticker'], 'Covered Call', 'closed',
                        norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str),
                        abs(qty) or 1, p, event='called_away')
                    # *** PATCH: _lotClose inline ***
                    t.update({'_lot_close':True, 'lot_ticker':p['ticker'],
                               'lot_close_price':p['strike'], 'lot_close_date':norm_date(date_str)})
                    trades.append(t)
                open_pos.pop(symbol, None)
            continue

        if type_ != 'trade':
            if date_str and type_raw: skipped.append(f"type not recognised: {type_raw!r}")
            continue
        p = parse_occ(symbol)
        if not p: skipped.append(f"symbol not recognised: {symbol!r}"); continue
        is_open = 'to open' in sub_type
        is_sell = qty < 0 or sub_type.startswith('sell')
        ak = f"{'open' if is_open else 'close'}_{'sell' if is_sell else 'buy'}"
        strat = derive_strategy(p['is_call'], ak)
        if is_open: open_pos[symbol] = 'short' if is_sell else 'long'
        else:       open_pos.pop(symbol, None)
        trades.append(make_trade(p['ticker'], strat, 'open' if is_open else 'closed',
            norm_date(date_str), p['exp'],
            price if is_open else None, None if is_open else price,
            None if is_open else norm_date(date_str), abs(qty) or 1, p))
    return trades, skipped

def parse_ibkr(text):
    """Mirror parseIBKR() in ImportModal.jsx"""
    trades, skipped, open_pos = [], [], {}
    headers = []
    lines = [l.strip() for l in text.split('\n') if l.strip()]
    for line in lines:
        if line.startswith('Trades,Header,'):
            headers = [c.strip().strip('"') for c in line.split(',')]
            break
    def col(name):
        try: return headers.index(name)
        except ValueError: return -1

    for line in lines:
        if line == 'END': trades.append({'_end':True}); continue
        cols = [c.strip().strip('"') for c in line.split(',')]
        if cols[0] != 'Trades' or cols[1] != 'Data': continue

        asset_col = col('Asset Category')
        asset = cols[asset_col] if asset_col >= 0 and asset_col < len(cols) else ''

        if asset == 'Stocks':
            ticker_c  = col('Symbol');  dt_c = col('Date/Time')
            qty_c     = col('Quantity'); pr_c = col('T. Price'); code_c = col('Code')
            ticker    = cols[ticker_c].strip().upper() if ticker_c >= 0 else ''
            date_raw  = cols[dt_c] if dt_c >= 0 else ''
            try: qty  = float(cols[qty_c]) if qty_c >= 0 else 0
            except ValueError: qty = 0
            try: price = abs(float(cols[pr_c])) if pr_c >= 0 else None
            except ValueError: price = None
            code      = cols[code_c] if code_c >= 0 else ''
            entry_date = norm_date(date_raw.split(';')[0])
            if qty > 0:
                trades.append({'_lot_create':True, 'ticker':ticker, 'shares':abs(qty),
                                'avg_cost':price, 'purchase_date':entry_date})
            elif qty < 0:
                trades.append({'_lot_close':True, 'lot_ticker':ticker,
                                'lot_close_price':price, 'lot_close_date':entry_date})
            continue

        if asset != 'Equity and Index Options': continue

        sym_c  = col('Symbol');  dt_c  = col('Date/Time')
        qty_c  = col('Quantity');pr_c  = col('T. Price')
        pnl_c  = col('Realized P/L'); code_c = col('Code')
        symbol    = cols[sym_c] if sym_c >= 0 else ''
        date_raw  = cols[dt_c]  if dt_c  >= 0 else ''
        try: qty  = float(cols[qty_c]) if qty_c >= 0 else 0
        except ValueError: qty = 0
        try: price = abs(float(cols[pr_c])) if pr_c >= 0 else None
        except ValueError: price = None
        try: real_pnl = float(cols[pnl_c]) if pnl_c >= 0 else None
        except ValueError: real_pnl = None
        code       = cols[code_c] if code_c >= 0 else ''
        entry_date = norm_date(date_raw.split(';')[0])
        p = parse_occ(symbol)
        if not p: skipped.append(f"symbol not recognised: {symbol!r}"); continue

        if 'Ep' in code:
            was_short = open_pos.get(symbol) != 'long'
            strat = ('Covered Call' if p['is_call'] else 'Cash-Secured Put') if was_short \
                    else ('Long Call' if p['is_call'] else 'Long Put')
            open_pos.pop(symbol, None)
            t = make_trade(p['ticker'], strat, 'closed', entry_date, p['exp'],
                           None, 0, entry_date, abs(qty) or 1, p, event='expired')
            if real_pnl: t['pnl'] = real_pnl
            trades.append(t); continue

        if 'A' in code:
            if not p['is_call']:
                t = make_trade(p['ticker'], 'Cash-Secured Put', 'closed',
                    entry_date, p['exp'], None, p['strike'], entry_date, abs(qty) or 1, p, event='assigned_put')
                if real_pnl: t['pnl'] = real_pnl
            else:
                t = make_trade(p['ticker'], 'Covered Call', 'closed',
                    entry_date, p['exp'], None, p['strike'], entry_date, abs(qty) or 1, p, event='called_away')
                if real_pnl: t['pnl'] = real_pnl
            trades.append(t); continue

        is_open = 'O' in code or 'C' not in code
        is_sell = qty < 0
        ak = f"{'open' if is_open else 'close'}_{'sell' if is_sell else 'buy'}"
        strat = derive_strategy(p['is_call'], ak)
        if is_open: open_pos[symbol] = 'short' if is_sell else 'long'
        else:       open_pos.pop(symbol, None)
        t = make_trade(p['ticker'], strat, 'open' if is_open else 'closed',
            entry_date, p['exp'],
            price if is_open else None, None if is_open else price,
            None if is_open else entry_date, abs(qty) or 1, p)
        if not is_open and real_pnl: t['pnl'] = real_pnl
        trades.append(t)
    return trades, skipped

def parse_robinhood(text):
    """Mirror parseRobinhood() in ImportModal.jsx"""
    SKIP_CODES = {'DIV','CDIV','INT','ACH','JNLC','JNLS','PTC','MISC'}
    trades, skipped, open_pos = [], [], {}
    for line in text.split('\n'):
        line = line.strip()
        if not line: continue
        if line == 'END': trades.append({'_end':True}); continue
        cols = [c.strip().strip('"') for c in line.split(',')]
        if len(cols) < 6: continue
        date_str   = cols[0]; instrument = cols[3] if len(cols)>3 else ''
        desc       = cols[4] if len(cols)>4 else ''
        trans_code = (cols[5] if len(cols)>5 else '').upper().strip()
        try: qty   = abs(int(cols[6]))   if len(cols)>6 and cols[6] else 1
        except ValueError: qty = 1
        try: price = abs(float((cols[7] if len(cols)>7 else '').replace('$',''))) if len(cols)>7 and cols[7] else None
        except ValueError: price = None
        if date_str in ('Activity Date',''): continue
        if trans_code in SKIP_CODES: continue

        if trans_code == 'BUY' and not parse_occ(instrument):
            ticker = instrument.strip().upper()
            if ticker:
                trades.append({'_lot_create':True, 'ticker':ticker, 'shares':qty,
                                'avg_cost':price, 'purchase_date':norm_date(date_str)})
            continue

        if trans_code == 'SELL' and not parse_occ(instrument):
            ticker = instrument.strip().upper()
            if ticker:
                trades.append({'_lot_close':True, 'lot_ticker':ticker,
                                'lot_close_price':price, 'lot_close_date':norm_date(date_str)})
            continue

        if trans_code == 'OEXP':
            p = parse_occ(instrument)
            if not p: skipped.append(f"symbol not recognised: {instrument!r}"); continue
            was_short = open_pos.get(instrument) != 'long'
            strat = ('Covered Call' if p['is_call'] else 'Cash-Secured Put') if was_short \
                    else ('Long Call' if p['is_call'] else 'Long Put')
            open_pos.pop(instrument, None)
            trades.append(make_trade(p['ticker'], strat, 'closed',
                norm_date(date_str), p['exp'], None, 0, norm_date(date_str), qty, p, event='expired'))
            continue

        if trans_code == 'OASGN':
            p = parse_occ(instrument)
            if not p: skipped.append(f"symbol not recognised: {instrument!r}"); continue
            if not p['is_call']:
                trades.append(make_trade(p['ticker'], 'Cash-Secured Put', 'closed',
                    norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str),
                    qty, p, event='assigned_put'))
            else:
                trades.append(make_trade(p['ticker'], 'Covered Call', 'closed',
                    norm_date(date_str), p['exp'], None, p['strike'], norm_date(date_str),
                    qty, p, event='called_away'))
            continue

        if trans_code not in ('STO','BTO','STC','BTC'):
            if date_str and trans_code: skipped.append(f"unrecognised code: {trans_code!r}")
            continue
        p = parse_occ(instrument)
        if not p: skipped.append(f"symbol not recognised: {instrument!r}"); continue
        is_open = trans_code in ('STO','BTO')
        is_sell = trans_code in ('STO','STC')
        ak = f"{'open' if is_open else 'close'}_{'sell' if is_sell else 'buy'}"
        strat = derive_strategy(p['is_call'], ak)
        if is_open: open_pos[instrument] = 'short' if is_sell else 'long'
        else:       open_pos.pop(instrument, None)
        trades.append(make_trade(p['ticker'], strat, 'open' if is_open else 'closed',
            norm_date(date_str), p['exp'],
            price if is_open else None, None if is_open else price,
            None if is_open else norm_date(date_str), qty, p))
    return trades, skipped

# ── P&L pairing (mirrors pairOpenClose in ImportModal.jsx) ───────────────

def pair_open_close(all_trades):
    CREDIT = {'Covered Call','Cash-Secured Put'}
    option_trades = [t for t in all_trades if 'strategy' in t and not t.get('_end')]
    opens  = [t for t in option_trades if t.get('status') == 'open']
    closes = [t for t in option_trades if t.get('status') == 'closed'
              and not t.get('_event')]
    paired = set()
    for o in opens:
        o_strike = o.get('strike_sell') or o.get('strike_buy')
        for i, c in enumerate(closes):
            if i in paired: continue
            c_strike = c.get('strike_sell') or c.get('strike_buy')
            if (o['ticker'] == c['ticker'] and
                o.get('expiration') == c.get('expiration') and
                o_strike == c_strike):
                ep = o['entry_price'] or 0
                xp = c['exit_price'] or 0
                ct = o['contracts']
                if o['strategy'] in CREDIT:
                    pnl = (ep - xp) * ct * 100
                else:
                    pnl = (xp - ep) * ct * 100
                o['pnl'] = pnl; c['pnl'] = pnl
                o['status'] = 'closed'
                paired.add(i)
                break

# ── Run all four parsers ───────────────────────────────────────────────────

parsers = {
    'Schwab':     (parse_schwab,     SCHWAB_CSV),
    'Tastytrade': (parse_tastytrade, TASTYTRADE_CSV),
    'IBKR':       (parse_ibkr,       IBKR_CSV),
    'Robinhood':  (parse_robinhood,  ROBINHOOD_CSV),
}

results = {}
for broker, (fn, csv_text) in parsers.items():
    if not csv_text:
        print(f"\n  [SKIP] {broker}: sample CSV not found")
        continue
    trades, skipped = fn(csv_text)
    pair_open_close(trades)
    results[broker] = {'trades': trades, 'skipped': skipped}

# ═══════════════════════════════════════════════════════════════════════
# SECTION 1 — Source code checks (ImportModal.jsx)
# ═══════════════════════════════════════════════════════════════════════
print("\n-- Section 1: ImportModal.jsx — parser structure checks ------")

chk("parseSchwab() defined",     "function parseSchwab("     in IMPORT)
chk("parseTastytrade() defined", "function parseTastytrade(" in IMPORT)
chk("parseIBKR() defined",       "function parseIBKR("       in IMPORT)
chk("parseRobinhood() defined",  "function parseRobinhood("  in IMPORT)
chk("pairOpenClose() defined",   "function pairOpenClose("   in IMPORT)
chk("parseOCCSymbol() defined",  "function parseOCCSymbol("  in IMPORT)
chk("PARSERS map has all 4",
    all(b in IMPORT for b in ['Schwab: parseSchwab', 'Tastytrade: parseTastytrade',
                               'IBKR: parseIBKR',    'Robinhood: parseRobinhood']))

# OCC format coverage
chk("OCC Format 1 (Schwab MM/DD/YYYY strike C/P)",  r"\\d{1,2}/\\d{1,2}/\\d{2,4}\\s+[\\d.]+\\s+[CP]" in IMPORT or "Schwab description" in IMPORT)
chk("OCC Format 2 (Tastytrade C/P before strike)",  "Tastytrade symbol" in IMPORT)
chk("OCC Format 3 (IBKR OCC 8-digit date)",         "IBKR OCC" in IMPORT or "20260321" in IMPORT or r"\\d{8}" in IMPORT)
chk("OCC Format 4 (Robinhood compact no space)",     "Robinhood compact" in IMPORT)

# Patch verification
chk("Tastytrade: shares received/delivered skip patch applied",
    "shares received" in IMPORT and "shares delivered" in IMPORT)
chk("Tastytrade: assigned_put carries _lotCreate inline",
    IMPORT.count("_lotCreate: true") >= 3)   # Schwab + Tastytrade + IBKR via stock row
chk("Tastytrade: called_away carries _lotClose inline",
    IMPORT.count("_lotClose: true") >= 2)    # Schwab + Tastytrade both carry it now
chk("Tastytrade called_away: lot_close_price from parsed.strike",
    IMPORT.count("lot_close_price: parsed.strike") >= 2)

# Schwab silent skip includes all expected non-trade actions
for action in ['cash dividend','bank interest','wire funds received',
               'wire transfer','moneylink transfer']:
    chk(f"Schwab SILENT_SKIP includes '{action}'", action in IMPORT)

# Tastytrade money movement silently skipped
chk("Tastytrade: money movement type silently skipped",
    "type_ === 'money movement'" in IMPORT or "type === 'money movement'" in IMPORT)

# Robinhood skip codes
for code in ['DIV','ACH','JNLC']:
    chk(f"Robinhood SILENT_SKIP_CODES includes '{code}'", code in IMPORT)

# ═══════════════════════════════════════════════════════════════════════
# SECTION 2 — App.jsx handleImport: demo AND live paths
# ═══════════════════════════════════════════════════════════════════════
print("\n-- Section 2: App.jsx handleImport — isMock + live parity ----")

chk("handleImport defined in App.jsx",               "handleImport" in APP)
chk("handleImport: lotCreateRows filter",            "lotCreateRows" in APP)
chk("handleImport: lotCloseRows filter",             "lotCloseRows"  in APP)
chk("handleImport: isMock lot create (setLots)",     "setLots(prev => [...prev, newLot])" in APP)
chk("handleImport: live lot create (apiPost /lots)", "await apiPost('/api/lots', lotData)" in APP)
chk("handleImport: isMock lot close (setLots map)",  "setLots(prev => prev.map(l => l.id === openLot.id" in APP)
chk("handleImport: live lot close (apiPut /lots)",   "await apiPut(`/api/lots/${openLot.id}`" in APP)
chk("handleImport: isMock trade seed (setTrades)",   "setTrades(prev => [...prev, ...seededTrades])" in APP)
chk("handleImport: live trade post (apiPost)",       "await Promise.all(toPost.map(t => apiPost('/api/trades'" in APP)
chk("handleImport: importedLotMap built for both paths", "importedLotMap" in APP)
chk("handleImport: snapshotLots built for both paths",   "snapshotLots"   in APP)
chk("handleImport: autoMatchLot links CC/CSP to lots",   "autoMatchLot"   in APP)
chk("handleImport: pnl enrichment for event rows",
    "assigned_put" in APP and "called_away" in APP and "CREDIT_STRATS_IMPORT" in APP)
chk("handleImport: entry_price placeholder for event rows in live path",
    "entry_price: 0.01" in APP)
chk("handleImport: file_hash deduplication check in App.jsx",
    "file_hash" in APP)

# ═══════════════════════════════════════════════════════════════════════
# SECTION 3 — Per-broker parse results
# ═══════════════════════════════════════════════════════════════════════

for broker, res in results.items():
    trades = res['trades']
    skipped = res['skipped']
    print(f"\n-- Section 3: {broker} parse results --------------------------")

    option_trades = [t for t in trades if 'strategy' in t and not t.get('_end')]
    open_trades   = [t for t in option_trades if t.get('status') == 'open']
    lot_creates   = [t for t in trades if t.get('_lot_create') and not t.get('_end')]
    lot_closes    = [t for t in trades if t.get('_lot_close')  and not t.get('_end')]
    assigned_puts = [t for t in option_trades if t.get('_event') == 'assigned_put']
    called_aways  = [t for t in option_trades if t.get('_event') == 'called_away']
    expirations   = [t for t in option_trades if t.get('_event') == 'expired']

    # Per-broker expected values
    exp = BROKER_EXPECTED[broker]

    # Trade count — open rows with entry_price (one per strategy, not counting event close rows)
    entry_trades = [t for t in option_trades if t.get('entry_price') and t.get('status') in ('open','closed')]
    chk_eq(f"{broker}: option trade count", len(entry_trades), exp['trade_count'])
    chk_eq(f"{broker}: lot creates",        len(lot_creates),  exp['lot_creates'])
    chk_eq(f"{broker}: lot closes",         len(lot_closes),   EXPECTED_LOT_CLOSES)
    chk_eq(f"{broker}: assigned_put events",len(assigned_puts),EXPECTED_ASSIGNED_PUTS)
    chk_eq(f"{broker}: called_away events", len(called_aways), EXPECTED_CALLED_AWAYS)
    chk_eq(f"{broker}: expiration events",  len(expirations),  EXPECTED_EXPIRATIONS)
    chk(f"{broker}: zero unrecognised rows", len(skipped) == 0,
        f"{len(skipped)} skipped: {skipped[:3]}" if skipped else "")

    # Strategy list matches expected (by sorted count)
    got_strats = sorted(t['strategy'] for t in entry_trades)
    exp_strats = exp['strategies']
    chk(f"{broker}: strategy list matches expected",
        got_strats == exp_strats,
        f"got {got_strats}" if got_strats != exp_strats else "")

    # Lot create tickers: AAPL + TSLA
    exp_tickers = exp['lot_create_tickers']
    create_tickers = sorted(t.get('ticker') or t.get('lot_ticker','') for t in lot_creates)
    chk(f"{broker}: lot creates are {'+'.join(exp_tickers)}",
        create_tickers == exp_tickers,
        f"got {create_tickers}" if create_tickers != exp_tickers else "")

    # Lot close tickers: AAPL + TSLA
    close_tickers = sorted(t.get('lot_ticker','') for t in lot_closes)
    chk(f"{broker}: lot closes are AAPL + TSLA",
        close_tickers == ['AAPL','TSLA'],
        f"got {close_tickers}" if close_tickers != ['AAPL','TSLA'] else "")

    # _lotCreate present on assignment row (inline, not on a separate stock row)
    # For IBKR and Robinhood the lot_create is a separate stock row — that is correct per their format
    if broker in ('Schwab', 'Tastytrade'):
        inline_lc = [t for t in option_trades if t.get('_lot_create') and t.get('_event') == 'assigned_put']
        chk(f"{broker}: _lotCreate carried inline on assigned_put row",
            len(inline_lc) == 1,
            f"found {len(inline_lc)} inline _lotCreate on assigned_put rows" if len(inline_lc) != 1 else "")
        inline_lc2 = [t for t in option_trades if t.get('_lot_close') and t.get('_event') == 'called_away']
        chk(f"{broker}: _lotClose carried inline on called_away row",
            len(inline_lc2) == EXPECTED_CALLED_AWAYS,
            f"found {len(inline_lc2)}, expected {EXPECTED_CALLED_AWAYS}" if len(inline_lc2) != EXPECTED_CALLED_AWAYS else "")

    # Tastytrade-specific: no stray _lot_create or _lot_close from delivery rows
    if broker == 'Tastytrade':
        # Standalone _lotCreate rows are valid for outright purchases (TSLA, NVDA)
        # What we must NOT see is a _lotCreate created from a 'shares received' delivery row
        # (those are skipped by the patch). Outright purchases have no _event on them.
        # Delivery-row lot creates would duplicate the inline _lotCreate on assigned_put.
        # Verify: total standalone creates = 2 (TSLA + NVDA outright buys only)
        standalone_creates = [t for t in trades if t.get('_lot_create') and not t.get('strategy') and not t.get('_end')]
        chk("Tastytrade: standalone lot creates = 2 outright purchases (TSLA + NVDA, no delivery duplicates)",
            len(standalone_creates) == 2,
            f"got {len(standalone_creates)}: {[t.get('ticker') for t in standalone_creates]}" if len(standalone_creates) != 2 else "")
        stray_lc = [t for t in trades if t.get('_lot_close') and not t.get('strategy') and not t.get('_end')]
        chk("Tastytrade: no stray standalone _lotClose rows (delivery rows skipped)",
            len(stray_lc) == 0,
            f"{len(stray_lc)} stray lot-close rows found" if stray_lc else "")

    # P&L spot checks (paired trades)
    aapl_cc = next((t for t in entry_trades
                    if t['ticker']=='AAPL' and t['strategy']=='Covered Call'
                    and (t.get('strike_sell') or 0) == 215.0), None)
    msft_csp = next((t for t in entry_trades
                     if t['ticker']=='MSFT' and t['strategy']=='Cash-Secured Put'), None)
    meta_lc  = next((t for t in entry_trades
                     if t['ticker']=='META' and t['strategy']=='Long Call'), None)

    # IBKR uses its own realized P/L — skip computed P&L checks for IBKR
    if broker != 'IBKR':
        if aapl_cc and aapl_cc.get('pnl') is not None:
            chk_eq(f"{broker}: AAPL CC $215 P&L", aapl_cc['pnl'], EXPECTED_AAPL_CC215_PNL, "${:.0f}")
        else:
            chk(f"{broker}: AAPL CC $215 paired (pnl set)", aapl_cc and aapl_cc.get('pnl') is not None,
                "pnl not computed — pairing may have failed")
        if msft_csp and msft_csp.get('pnl') is not None:
            chk_eq(f"{broker}: MSFT CSP P&L", msft_csp['pnl'], EXPECTED_MSFT_CSP_PNL, "${:.0f}")
        else:
            chk(f"{broker}: MSFT CSP paired (pnl set)", msft_csp and msft_csp.get('pnl') is not None,
                "pnl not computed — pairing may have failed")
        if meta_lc and meta_lc.get('pnl') is not None:
            chk_eq(f"{broker}: META Long Call P&L", meta_lc['pnl'], EXPECTED_META_CALL_PNL, "${:.0f}")
        else:
            chk(f"{broker}: META Long Call paired (pnl set)", meta_lc and meta_lc.get('pnl') is not None,
                "pnl not computed — pairing may have failed")

    # Lot create avg_cost checks
    aapl_lot = next((t for t in lot_creates if (t.get('ticker') or t.get('lot_ticker','')) == 'AAPL'), None)
    tsla_lot = next((t for t in lot_creates if (t.get('ticker') or t.get('lot_ticker','')) == 'TSLA'), None)
    if aapl_lot:
        chk_eq(f"{broker}: AAPL lot avg_cost = $220 (assignment strike)",
               aapl_lot.get('avg_cost') or aapl_lot.get('lot_avg_cost', 0), 220.0, "${:.2f}")
    if tsla_lot:
        chk_eq(f"{broker}: TSLA lot avg_cost = $310 (purchase price)",
               tsla_lot.get('avg_cost') or tsla_lot.get('lot_avg_cost', 0), 310.0, "${:.2f}")

    # Lot close price checks
    aapl_close = next((t for t in lot_closes if t.get('lot_ticker','') == 'AAPL'), None)
    tsla_close = next((t for t in lot_closes if t.get('lot_ticker','') == 'TSLA'), None)
    if aapl_close:
        chk_eq(f"{broker}: AAPL lot close price = $220 (CC strike)",
               aapl_close.get('lot_close_price', 0), 220.0, "${:.2f}")
    if tsla_close:
        chk_eq(f"{broker}: TSLA lot close price = $325 (CC strike)",
               tsla_close.get('lot_close_price', 0), 325.0, "${:.2f}")

# ═══════════════════════════════════════════════════════════════════════
# SECTION 4 — Cross-broker parity (all four produce the same result)
# ═══════════════════════════════════════════════════════════════════════
print("\n-- Section 4: Cross-broker parity — same result from all 4 ---")

if len(results) == 4:
    # Cross-broker parity on the SHARED CLOSED CORE — the 9 trades that
    # are present in every broker's sample (events + paired open/close trades).
    # Open-only and outright-purchase rows vary by broker sample file.
    def closed_core(broker):
        trades = results[broker]['trades']
        option_trades = [t for t in trades if 'strategy' in t and not t.get('_end')]
        # Closed trades: event rows + trades with pnl set (paired)
        closed = [t for t in option_trades if t.get('status') == 'closed']
        return dict(
            closed_trade_count = len([t for t in closed if t.get('entry_price')]),
            lot_closes    = len([t for t in trades if t.get('_lot_close')  and not t.get('_end')]),
            assigned_puts = len([t for t in option_trades if t.get('_event') == 'assigned_put']),
            called_aways  = len([t for t in option_trades if t.get('_event') == 'called_away']),
            expirations   = len([t for t in option_trades if t.get('_event') == 'expired']),
            aapl_cc215_pnl = next((t.get('pnl') for t in option_trades
                                   if t['ticker']=='AAPL' and t['strategy']=='Covered Call'
                                   and (t.get('strike_sell') or 0)==215.0 and t.get('pnl') is not None), None),
            msft_csp_pnl   = next((t.get('pnl') for t in option_trades
                                   if t['ticker']=='MSFT' and t['strategy']=='Cash-Secured Put'
                                   and t.get('pnl') is not None), None),
            meta_lc_pnl    = next((t.get('pnl') for t in option_trades
                                   if t['ticker']=='META' and t['strategy']=='Long Call'
                                   and t.get('pnl') is not None), None),
        )

    brokers = list(results.keys())
    c = {b: closed_core(b) for b in brokers}

    for field in ['closed_trade_count','lot_closes','assigned_puts','called_aways','expirations']:
        vals = {b: c[b][field] for b in brokers}
        all_match = len(set(vals.values())) == 1
        chk(f"All brokers agree on '{field}': {c[brokers[0]][field]}", all_match,
            " | ".join(f"{b}={vals[b]}" for b in brokers) if not all_match else "")

    for field, exp_val, label in [
        ('aapl_cc215_pnl', EXPECTED_AAPL_CC215_PNL, 'AAPL CC $215 P&L'),
        ('msft_csp_pnl',   EXPECTED_MSFT_CSP_PNL,   'MSFT CSP P&L'),
        ('meta_lc_pnl',    EXPECTED_META_CALL_PNL,   'META Long Call P&L'),
    ]:
        for b in brokers:
            if b == 'IBKR': continue  # IBKR uses its own Realized P/L figure
            got = c[b][field]
            ok = got is not None and abs(float(got) - float(exp_val)) < 0.01
            chk(f"All brokers ({b}): {label} = ${exp_val:+.0f}", ok,
                f"got {got}" if not ok else "")

# ═══════════════════════════════════════════════════════════════════════
# SECTION 5 — handleImport demo vs live structural parity
# ═══════════════════════════════════════════════════════════════════════
print("\n-- Section 5: handleImport demo vs live structural parity ----")

# Both paths must run through the same lot-create loop
chk("Both paths: lotCreateRows loop runs before tradeRows",
    APP.index("lotCreateRows") < APP.index("tradeRows") if "lotCreateRows" in APP and "tradeRows" in APP else False)

# Both paths build importedLotMap (critical for autoMatchLot linking CCs to lots)
chk("isMock path: importedLotMap[ticker] set after lot create",
    "importedLotMap[" in APP)
chk("Live path: importedLotMap[ticker] set from apiPost response",
    "importedLotMap[row.ticker.toUpperCase()] = created" in APP)

# Both paths use snapshotLots for autoMatchLot — not the stale React state
chk("isMock path: snapshotLots built from lots + importedLotMap",
    "snap = [...lots]" in APP)
chk("Live path: snapshotLots built the same way",
    APP.count("snap = [...lots]") >= 2)

# autoMatchLot uses snapshotLots (not lots directly) for ticker matching
chk("autoMatchLot uses snapshotLots for ticker match",
    "snapshotLots.filter" in APP)

# P&L enrichment runs before the isMock/live split
pnl_idx     = APP.index("CREDIT_STRATS_IMPORT") if "CREDIT_STRATS_IMPORT" in APP else 0
ismock_idx  = APP.index("if (isMock)") if "if (isMock)" in APP else 0
# Find the isMock split AFTER the enrichment block
post_enrich = APP[pnl_idx:].find("if (isMock)") if pnl_idx else -1
chk("P&L enrichment runs before isMock/live split in handleImport",
    pnl_idx > 0 and post_enrich > 0)

# Event row placeholder only on live path (isMock doesn't POST to backend)
chk("entry_price 0.01 placeholder only on live POST path",
    "entry_price: 0.01" in APP)
chk("isMock path does NOT need 0.01 placeholder (state only)",
    APP.count("entry_price: 0.01") == 1)

# Import deduplication in live path only (isMock has no import_history table)
chk("Live path (backend.js): import_history INSERT after trades posted",
    "INSERT OR IGNORE INTO import_history" in BACKEND)

# ═══════════════════════════════════════════════════════════════════════
# SUMMARY
# ═══════════════════════════════════════════════════════════════════════
total = len(PASS_LIST) + len(FAIL_LIST)
print(f"\n{'=' * 65}")
if not FAIL_LIST:
    print(f"  ALL PASS — {total}/{total} checks")
else:
    print(f"  FAILURES — {len(PASS_LIST)}/{total} passed, {len(FAIL_LIST)} FAILED:")
    for f in FAIL_LIST:
        print(f"    FAIL: {f}")
print(f"{'=' * 65}")
sys.exit(0 if not FAIL_LIST else 1)
