# MyOptionDiary — PROJECT CONTEXT V17
# Single source of truth for the current codebase.
# Last updated: 2026-04-08

---

## WHAT THIS IS

Windows desktop Electron app for wheel-strategy options trading.
Stack: React 18 · Node/Express · sql.js (WASM SQLite) · Electron 28
Active zip: `myoptiondiary-v7.zip`  (folder: `options-tracker-v17/`)

---

## KEY FILES

```
src/api/demoEngine.js              65 trades · 6 lots · 14 strategies (all verified)
src/App.jsx                        All state, handlers, isMock demo/live toggle
src/components/TradeLog.jsx        Trade table · P&L curves · Roll/Close/Expired modals
src/components/Dashboard.jsx       Analytics hero card · charts · drilldowns
src/components/Alerts.jsx          3-section alert engine (15 P1+P2 alerts)
src/components/StockPositions.jsx  Lot cards · wheel summary · all lot modals
src/components/TradeForm.jsx       Entry form · 14 strategies · IC 4-strike · Cal two-field
src/components/ExpiryDatePicker.jsx  Fridays-only calendar · holiday-aware
src/components/TradeExplainModal.jsx 51 EXPLAIN entries (all verified, untouched)
src/components/ICAdjustModal.jsx   8 IC/IB adjustment types
src/components/CalAdjustModal.jsx  7 Calendar/Diagonal adjustment types
src/utils/tradingCalendar.js       BSM · DTE · nearestExpiryFriday · holiday list
src/utils/yahooQuotes.js           Yahoo stock + option chain · crumb-auth
trade-tracker-backend.js           Express · SQLite · validateTrade()
```

---

## ARCHITECTURE

```
isMock true  → demoEngine.js  (React state only, no backend)
isMock false → Express :3002  (SQLite on disk)
```

Every fix to demo logic must be mirrored to the live path. Parity checklist before every zip.

---

## ALL 14 STRATEGIES

CC · CSP · Bull Put Spread · Bear Call Spread · Iron Condor · Iron Butterfly ·
Bull Call Spread · Bear Put Spread · Long Call · Long Put · Long Straddle · Long Strangle ·
Calendar Spread · Diagonal Spread

---

## DEMO DATA — VERIFIED 2026-04-01

### Lots

| ID | Ticker | Shares | Avg Cost | Status |
|----|--------|--------|----------|--------|
| 1  | AAPL   | 200    | $210.50  | Open   |
| 2  | AAPL   | 100    | $218.00  | Open   |
| 3  | TSLA   | 100    | $250.00  | Open   |
| 4  | ABBV   | 100    | $175.00  | Open   |
| 5  | VRTX   | 100    | $450.00  | Open   |
| 6  | NVDA   | 100    | $840.00  | Closed @ $960 |

### Spot Prices (April 2026)
AAPL $248 · TSLA $250 · ABBV $208 · VRTX $458 · PLTR $152 · CRDO $103
SPY $651 · QQQ $585 · NFLX ~$93 (post 10:1 split) · IREN $41 · AXSM $165
CRSP $46 · NVDA $175 · INOD $22

**NFLX is post-split. All NFLX demo strikes are post-split levels (~$90–$95).**

### Chain IDs
IC/IB: 103(AAPL) · 119(ABBV) · 130/131(SPY closed) · 133(SPY open) · 135(QQQ closed) · 137(QQQ open) · 150(NVDA IB)
Cal/Diag: 21(ABBV Cal closed) · 214(NFLX Cal open, 1 adj) · 49(INOD Diagonal open)

---

## VERIFIED ANALYTICS NUMBERS (simulation-confirmed 2026-04-01)

### Realised P&L tile: $24,552
App.jsx `totalPnl` = optionPnl ($12,552) + sharePnl ($12,000)

**optionPnl $12,552 breakdown:**
- IC/IB chains closed:         $3,304
- Calendar chains closed:        $245
- Pure standalone closed:        $598
- Lot-linked CC/CSP pnl fields: $5,525
- Assignment premiums:          $2,880
  (TSLA CSP $650 · ABBV CSP $380 · VRTX CSP $650 · NVDA CSP $650 · NVDA CC called-away $550)

**sharePnl $12,000:**
- NVDA Lot 6: (960 − 840) × 100 shares

### Other tiles
- Win Rate: **59.3%** (16W / 27 standalone closed — excludes chain legs and pnl=0 trades)
- Profit Factor: **1.46** (avg win $515 / avg loss $353)
- Best trade: **$960** (NVDA IB chain #150)
- Worst trade: **−$740** (CRSP Long Straddle)
- Gross Premium tile: **$24,085** (allCreditPremium — one-way accumulator, never decreases)
  - Previous: $22,724 (Cal/Diagonal short legs were excluded — fixed)
  - Added: ABBV Cal shorts $445 + NFLX Cal shorts $800 + INOD Diag short $116 = +$1,361
- Open credit badge: **~$6,392**

### Wheel Premiums per Lot (StockPositions calcLotPremium)

| Lot | Ticker | Premium | Breakdown |
|-----|--------|---------|-----------|
| 1   | AAPL   | $2,035  | CC1 $830 · CC2 $285 · CC3-open $920 |
| 2   | AAPL   | $390    | CC-open $390 |
| 3   | TSLA   | $3,030  | CSP-assign $650 · CC1 $930 · CC2-open $1,450 |
| 4   | ABBV   | $940    | CSP-assign $380 · CC1 $210 · CC2-open $350 |
| 5   | VRTX   | $1,810  | CSP-assign $650 · CC1 $360 · CC2-open $800 |
| **Open total** | | **$8,205** | |
| 6   | NVDA [closed] | $3,510 | CSP $650 · CC1 $845 · CC2 $720 · CC3 $745 · called-away $550 |

### Net Cost Basis per Open Lot

| Lot | Net Cost | Per Share | % Reduced |
|-----|----------|-----------|-----------|
| 1 AAPL | $40,065 | $200.32 | 4.8% |
| 2 AAPL | $21,410 | $214.10 | 1.8% |
| 3 TSLA | $21,970 | $219.70 | 12.1% |
| 4 ABBV | $16,560 | $165.60 | 5.4% |
| 5 VRTX | $43,190 | $431.90 | 4.0% |

---

## DATA CONVENTIONS

| Situation | Demo | Live |
|-----------|------|------|
| CSP assigned pnl | 0 | full premium in t.pnl |
| CSP exit_price | entry_price | strike_buy |
| CC called-away pnl | 0 (share gain via lot) | share_gain + premium |
| CC called-away exit_price | strike_sell | lot.close_price |
| calcLotPremium CSP detect | exit===entry OR exit===strike_buy | both covered |
| calcLotPremium CC called-away | \|exit − strike_sell\| < 0.01 | same |
| IC anchor | condor_seq=0 | same |
| Calendar option_type | 'call'\|'put' on every leg | same |

---

## P&L FORMULAS

- Credit: `(entry − exit) × contracts × 100`
- Debit:  `(exit − entry) × contracts × 100`
- CSP assignment (demo): pnl=0; premium via calcLotPremium isCCCalledAway path
- CC called-away (demo): pnl=0; premium via isCCCalledAway; share gain via closedLotShareGain
- Calendar/Diagonal: entry_price = back month cost − front month credit (computed at submit)

---

## TRADEFORM — CALENDAR/DIAGONAL PRICING

Two-field model (added 2026-04-01):
- **Front Month Credit** — editable, premium received from short leg
- **Back Month Cost** — editable, premium paid for long leg
- **Net Debit** — read-only greyed, live computed as long − short

`cal_short_credit` and `cal_long_cost` are form-only state — not stored in DB.
`entry_price` stored = long − short (computed at submit).
Calendar: hard stop if long ≤ short.
Diagonal: warning if long ≤ short (credit diagonal — unusual but valid).

---

## CALADJ — 8 ADJUSTMENT TYPES + VALIDATIONS

Types: roll_short · roll_front_out · roll_long_out · convert_diagonal · convert_to_calendar ·
       widen_diagonal · close_both · reduce_position

Key validations:
- J: roll_short expiry change → WARN (should use roll_front_out)
- K: roll_front_out new expiry must be later than current front month
- L: convert_diagonal new long expiry must be > short leg expiry
- M: convert_diagonal new long strike = short strike → still a Calendar (hard stop)
- N: convert_to_calendar new short must match long anchor strike (hard stop)
- O: widen_diagonal same-strike as current = no widening (hard stop)
- P: reduce_position all contracts → use Close Position (hard stop)

---

## ICADJ — 8 ADJUSTMENT TYPES

close_position · reduce_position · roll_one_leg · roll_resize · roll_full ·
convert_spread · close_one · take_profit (legacy label)

IB-specific rules:
- ATM body (strike_sell) locked on all roll types — cannot change
- roll_full call sell auto-mirrors putSellStrike for IB (readOnly)
- Proximity uses wing-width not 5% (see Alerts)

---

## ALERTS ENGINE — 15 ALERTS (tone: informational only, no imperatives)

**Section 1 — Standalone:**
| # | Strategy | Trigger | Sev |
|---|----------|---------|-----|
| — | All | DTE ≤7 | RED |
| — | Credit | Delta >0.50 | RED |
| — | Credit | Delta 0.35–0.50 | AMBER |
| — | CC | Stock ≥ call strike | RED |
| — | CC | Stock within 3% of call strike | AMBER |
| P2#9 | CC | Stock >20% below call strike | AMBER |
| — | CSP | Stock ≤ put strike | RED |
| — | CSP | Stock within 3% of put strike | AMBER |
| P2#10 | CSP | Stock >15% below put strike | AMBER |
| P1#4+5 | BPS/BCS | Short strike breached | RED |
| P1#4+5 | BPS/BCS | Within 3% of short strike | AMBER |
| P1#4+5 | BPS/BCS | Loss ≥ 2× credit | RED |
| — | Credit | Profit ≥80% | BLUE |
| — | Credit | Profit ≥50% | BLUE |
| — | Debit | Loss ≥50% of premium | RED |
| P1#8 | Long C/P | Delta < 0.30 | AMBER |
| — | Long C/P | Up ≥100% | BLUE |
| P2#15 | Debit spread | ≥75% max profit + ≤7 DTE | BLUE |
| P2#11 | Straddle/Strangle | IV dropped ≥30% | AMBER |
| P2#12 | Straddle/Strangle | Combined up ≥50% | BLUE |

**Section 2 — IC/IB chains:**
| # | Trigger | Sev |
|---|---------|-----|
| — | DTE ≤7 | RED |
| — | DTE ≤21 | RED |
| — | DTE ≤30 | AMBER |
| P1#1+2 | IB: stock within 0.5× wing-width | AMBER |
| P1#1+2 | IB: stock within 1× wing-width | RED |
| — | IC: within 5% of put short | AMBER |
| — | IC: put short breached | RED |
| — | IC: within 5% of call short | AMBER |
| — | IC: call short breached | RED |
| P2#13 | One wing closed | AMBER |
| — | Profit ≥50% max credit | BLUE |
| — | Loss ≥200% max credit | RED |
| — | Loss ≥100% max credit | AMBER |

**Section 3 — Cal/Diagonal chains:**
| # | Trigger | Sev |
|---|---------|-----|
| — | Front month DTE ≤7 | RED |
| — | Front month DTE ≤14 | AMBER |
| — | Front month DTE ≤21 | AMBER |
| P1#3 | Short leg ITM (call: stock ≥ strike; put: stock ≤ strike) | RED |
| — | Stock >1 SD from strike | AMBER |
| P1#6 | Back month < 45 DTE | AMBER |
| P1#7 | Diagonal: short expired worthless | BLUE |
| — | IV dropped ≥25% since entry | AMBER |
| P2#14 | IV risen ≥40% since entry | AMBER |
| — | Campaign profit ≥20% net debit | BLUE |

---

## PARITY CHECKLIST (run before every zip — NO EXCEPTIONS)

```
□ 1.  Every App.jsx handler has both isMock AND live else branch
□ 2.  Every new trade field in both INSERT and UPDATE SQL (backend)
□ 3.  Every new IC/Cal adjust type in BOTH demo handler AND backend
□ 4.  P&L formula (credit/debit direction) applied before isMock split
□ 5.  validateTrade() accepts all new fields/strategies
□ 6.  New modal workflows have apiPut/apiPost in live path
□ 7.  DTE formula Math.ceil consistent: TradeLog.jsx and Alerts.jsx
□ 8.  calcLotPremium: CSP by exit===entry OR exit===strike_buy;
      CC called-away by |exit − strike_sell| < 0.01
□ 9.  EXPLAIN entries in TradeExplainModal.jsx (459 lines, not TradeLog)
□ 10. All draggable modals: onMouseDownHeader + modalRef + pos state
□ 11. Demo lot notes match premium totals (open lots total $8,205)
```

---

## CLAUDE PERSONAS — ACTIVE EVERY SESSION

Claude operates as three concurrent personas throughout every session.
All three are always active; which one leads depends on the task at hand.

**Persona 1 — Seasoned Stock Options Trader**
A veteran options trader with years of hands-on experience across all major
strategies (wheel, spreads, IC, calendars, diagonals, straddles, etc.) and
deep industry research experience with similar options trading applications.
This persona informs all trading logic decisions, P&L conventions, strategy
definitions, alert thresholds, and UX flows that a real trader would expect.
Leads on: strategy validation, alert logic, P&L formulas, demo data realism,
and any decision where trader intuition should drive the answer.

**Persona 2 — Solution Architect & Developer**
An experienced software architect and developer who has built financial
applications tied to stock options trading. Fluent in the full stack of this
app: React 18, Node/Express, sql.js (WASM SQLite), Electron 28.
Applies engineering discipline: parity checklist, simulation gates, clean
isMock/live splits, schema consistency, and no regressions.
Leads on: all code changes, architecture decisions, parity enforcement,
simulation runs, and packaging.

**Persona 3 — Expert Technical Document Writer**
A specialist in crisp, trader-facing documentation — works in conjunction
with Persona 1 to produce user guides, help content, and in-app guidance
(e.g. HelpPanel.jsx, QuickStartPanel.jsx, TradeExplainModal.jsx entries).
Writing is clear, concise, and assumes the reader is an active trader, not
a software developer. No jargon, no fluff.
Leads on: all user-facing copy, help panel content, strategy explanations,
tooltip text, and any documentation deliverable.

---

## STANDING RULES

1. Fix demo first, mirror to live
2. Ask before sending zip — batch fixes
3. Update this file every session
4. Send zip as `myoptiondiary-v7.zip`
5. Run full parity checklist before packaging — NO EXCEPTIONS
   11-item checklist must be explicitly ticked. If ANY item is unclear,
   investigate before zipping — never assume or skip.
6. Strike display order: sell/buy (short/long) everywhere
7. IB put-leg: strike_sell = ATM body; wing derives symmetrically
8. NFLX post-split (~$93); all demo strikes post-split
9. Alerts tone: informational only — state facts, no imperatives
10. Run a simulation on every fix before packaging — NO EXCEPTIONS
    Every changed formula/calculation must have a numerical simulation.
    Simulation must confirm 0 FAIL before zip is sent. Verify P&L, Gross
    Premium, Realised, Unrealised, and any affected tile. No zip sent until
    both parity AND simulation pass. Claude must not wait to be asked —
    these are mandatory gates, not optional steps.
11. ACTIVE CODEBASE — `options-tracker-v17/trade-tracker/` IS THE ONLY
    SOURCE OF TRUTH. All three scenarios run from this folder:
      Scenario 1 (npm start)       → options-tracker-v17/trade-tracker/
      Scenario 2 (ELECTRON-DEV)   → options-tracker-v17/trade-tracker/
      Scenario 3 (BUILD-ELECTRON) → options-tracker-v17/trade-tracker/
    BUILD-ELECTRON.bat packages this folder into the shipped .exe.
    Every code change MUST be applied to options-tracker-v17/trade-tracker/
    first. The root-level trade-tracker/ is a secondary mirror only — never
    the source of truth. Claude must never edit only the root copy.

---

### Session 150 (2026-04-08) — CSV Import Parser Overhaul + Scenario Audit

**Root cause:** The zip contained old sample CSVs (no END markers, no stock rows)
and old parsers that did not match the migration-format samples built yesterday.

**All 4 parsers rewritten to match the correct migration sample files:**

**parseSchwab:**
  - `Buy` action (equity) → `_lotCreate` stock lot row
  - `Assigned` on PUT option → option closed + inline `_lotCreate` (lot from assignment)
  - `Assigned` on CALL option → option closed + `_lotClose` flag (called away)
  - `Expired` / `Exercise` → already handled, retained

**parseIBKR:**
  - `Code Ep` → expired (was falling to unrecognised/skipped)
  - `Code A` on PUT option → assigned, flagged
  - `Code A` on CALL option → called away, flagged
  - `Stocks / Asset Category` + qty > 0 → `_lotCreate` (share purchase or assignment)
  - `Stocks / Asset Category` + qty < 0 → `_lotClose` (share sale or called away)
  - END markers now parsed (were silently discarded by Trades,Data row filter)

**parseRobinhood:**
  - `OEXP` → expired worthless (was surfaced in skipped panel, now imported)
  - `OASGN` on PUT → CSP assigned, flagged
  - `OASGN` on CALL → CC called away, flagged
  - `BUY` (equity, no OCC symbol) → `_lotCreate`
  - `SELL` (equity, no OCC symbol) → `_lotClose`
  - DIV/ACH/INT silently skipped

**parseTastytrade (3 fixes):**
  - `Receive Deliver / Buy to Open` (no OCC symbol) → `_lotCreate` (was silently skipped)
  - `Receive Deliver / Sell to Close` (no OCC symbol) → `_lotClose` (was silently skipped)
  - `Receive Deliver / Expiration` now correctly identifies Long vs Short using
    `openPositions` map built from Trade rows — Long Put/Call no longer misclassified as CSP/CC

**App.jsx — handleImport rewritten (3-step lot-aware flow):**
  - Step 1: Create stock lots from `_lotCreate` rows BEFORE option trades
  - Step 2: Close lots from `_lotClose` rows (called away / sale)
  - Step 3: Enrich option trades with auto-lot-linking against fresh snapshot
  - Works correctly in all 3 scenarios (isMock and live paths)
  - Live path: strips internal fields (_event, _lotCreate etc.) before backend POST
  - Event rows (expired/assigned): entry_price=0.01 placeholder so backend accepts them;
    note instructs user to press Assignment/Called Away/Expired button to correct
  - isMock path: event rows pass filter via `_event` flag; React state only, no backend

**Sample CSVs updated in both locations:**
  - `options-tracker-v17/sample-csvs/` ← all 4 updated to migration format with END markers
  - `trade-tracker/public/migration/` ← all 4 already correct (were updated yesterday)
  - README.md rewritten to describe new wheel-history format

**Scenario audit (all 3 scenarios verified):**
  - S1 (npm start): isMock=true, getBase→3002, React state only, no backend validation
  - S2 (ELECTRON-DEV): Electron injects __BACKEND_PORT__, live SQLite, full validation
  - S3 (BUILD-ELECTRON): Same as S2, packaged .exe, migration files in resources/app/migration
  - Migration endpoint covers all 3 path variations correctly

**Parity: 248/248 PASS**
**Simulation: 88/88 rows across Schwab/IBKR/Robinhood/Tastytrade — 0 issues**

### Session 151 (2026-04-08) — Import Pipeline Overhaul

**Bug 1 — setStep(3) → wizard stuck on Upload step (CONFIRMED)**
After processFile() completed, setStep(3) kept the wizard on the Upload step (step 3 IS Upload).
The PreviewPanel only rendered when preview.length > 0, so if anything went wrong during
parsing the user saw nothing and had no way to proceed.
Fix: setStep(4) — always advance to Preview step after parsing.
PreviewPanel now renders on step===4 regardless of trade count.
Upload drop zone shows only on step===3 (not tied to preview.length).

**Bug 2 — Open trade with past expiry silently rejected by validateTrade (CONFIRMED)**
Root cause: parseSchwab produces two independent records per lifecycle event:
  - Row 1 (STO): status=open, expiry=2026-02-20
  - Row 2 (Assigned): _event=assigned_put, exit_price=strike
Previously these were treated as two independent records. The open CSP (Row 1) stayed
as status=open with a past expiry — validateTrade correctly rejected it with
"open trade cannot have a past expiration". The trade was silently dropped.
Same issue affects all broker parsers for any trade where the STO row has a past expiry.

Fix: Merge event rows with their matching open trades BEFORE posting to backend.
In processFile(), when an eventRow (assigned_put / called_away / expired) matches an
open trade by ticker + expiry + strike + strategy, they are merged into ONE closed record:
  - entry_price, entry_date, contracts from the open
  - exit_price, exit_date from the event
  - _event flag preserved for lot operations in handleImport
  - status = closed — never rejected by validateTrade
Result: all 9 sample trades per broker now import correctly.

**Bug 3 — EVENT_MARKER regex fragile (FIXED)**
pairOpenClose used /· (Expired|Assigned|Exercise) ·/ on notes text to detect event rows.
This missed Schwab "Expired worthless" (no trailing ·) and "Called Away" (not in regex).
Fix: eventRows separated from tradeOnly BEFORE pairOpenClose using the _event flag (reliable).
pairOpenClose now only sees clean open/close option rows — no regex needed.

**Bug 4 — Empty state (FIXED)**
When preview is empty (all dupes or all skipped), PreviewPanel now shows a 📭 screen
with the reason and a skipped rows panel. Import button disabled when preview.length===0.

**Manual CSV sample simulation**: 33 trades, 14/14 strategies, 2 lot creates, 1 lot close,
0 skipped, 0 validateTrade rejections.

**Parity**: 248/248 PASS. Import audit: 55/55 PASS.

### Session 151 (2026-04-09) — Import Pipeline End-to-End Fix + Clear All Data

**Root causes found and fixed (all 4 brokers now fully working):**

**Bug 1 — Pure lot rows (no strategy) being posted as trades**
  TT/IBKR/RH outright stock purchase rows have no strategy field.
  These passed the enrichedTrades filter and were posted to /api/trades.
  The INSERT has strategy TEXT NOT NULL — sql.js silently ignored the INSERT,
  last_insert_rowid() returned stale lot rowid, dbGet returned null → 500 on ALL trades.
  Fix: enrichedTrades filter now gates out rows with no strategy: `if (!t.strategy) return false`

**Bug 2 — pureLotRows lost in processFile**
  Pure stock rows (_lotCreate/no strategy/no _event) were excluded from both
  tradeOnly and eventRows arrays → never reached preview → never reached handleImport.
  Fix: dedicated pureLotRows array extracted in processFile, appended to paired.

**Bug 3 — Step 2 lot close used stale allLots (live path)**
  In live path, allLots = lots (old React state, doesn't contain newly created lot).
  openLot lookup failed → lot never closed → showed Active.
  Fix: use importedLotMap[ticker] directly as openLot.

**Bug 4 — snapshotLots live path missing new lots**
  snapshotLots = lots (old state) → autoMatchLot found no AAPL lots → 0 linked.
  Fix: live path now builds snapshot same as isMock — from importedLotMap.

**Bug 5 — autoMatchLot excluded closed lots**
  tickerLots filter used !l.close_date — excluded lots closed in same import.
  Fix: removed !l.close_date filter from autoMatchLot.

**Bug 6 — Clear All Data endpoint used wrong table name**
  Endpoint said DELETE FROM lots but table is named purchase_lots.
  SQLite threw silently, returned ok:true, nothing was deleted.
  Fix: DELETE FROM purchase_lots.

**Bug 7 — Legacy trades filename (no .db extension)**
  Old backend wrote to file named `trades` (no extension).
  New backend added legacy migration: renames `trades` → `trades.db` on startup.

**Infrastructure fixes:**
  - dbRun rewritten to use db.prepare().run() for reliable lastInsertRowid
  - INSERT handler wrapped in try/catch with proper error logging
  - Clear All Data button added to sidebar (two-step confirmation)
  - Works in both Demo (resets to getDemoTrades/getDemoLots) and Live (DELETE FROM tables)

**Validated end-to-end (P1 view):**
  All 4 brokers: AAPL lot created → trades linked → lot closed → Wheel Cycle Summary shows:
    Total Premium +$2,090 · Share P&L $0 · ROI 4.8% · Annualised 20.4% · 85 days held
    Trade pills: CSP → Assigned 02-20 +$690 · CC 04-17 +$380 · CC ✓ Called Away 05-16

**Stock Positions behaviour confirmed:**
  Active Positions: shows lots with no close_date (currently owned shares)
  Wheel Cycle Summary: shows ALL lots including closed wheels with full P&L/ROI
  Both views correct by design.

**Parity: 248/248 PASS**

### Session 151 — Additional fixes confirmed working (2026-04-09)

**Bug 8 — deriveStrategy missing Long Call/Put STC case**
  ImportModal.jsx parseSchwab: deriveStrategy('close_sell') fell through to default
  returning 'Covered Call' instead of 'Long Call' / 'Long Put'.
  pairOpenClose couldn't match BTO+STC (different strategies) → pnl=null for debit closes.
  Fix: added close_sell cases for both Long Call and Long Put.
  Impact: META Long Call (-$550) and any debit STC trades now get correct pnl.

**Bug 9 — backend pnl auto-calculation: const reassignment**
  My fix used `d = {...d, pnl}` but d was const → TypeError at runtime.
  Fix: use `let autoPnl` as separate variable, pass to INSERT as
  `(autoPnl != null ? autoPnl : d.pnl) || null`

**Bug 10 — SIGINT handler: server not defined**
  `process.on('SIGINT', () => server.close())` was outside tryListen scope.
  Fix: removed server.close() from SIGINT (process.exit(0) is sufficient).

**Buy Back column fix (TradeLog.jsx)**
  Was showing exit_price for ALL closed trades including expired ($0.00) and
  assigned/called_away (strike price like $220, $325) — misleading.
  Fix: show '—' when exit_price=0 OR exit_price matches strike_buy/strike_sell.
  Only show actual buyback price for genuine BTC/STC closes.

**CONFIRMED WORKING — P1 validation after Schwab import:**
  Realised P&L:  $3,525 ✓
  Gross Premium: $5,640 ✓
  Win Rate:      77.8% (7/9) ✓
  Best Trade:    $1,020 ✓
  Worst Trade:   -$960 ✓
  Trade Log:     9 closed trades, all with correct P&L ✓
  Wheel Summary: AAPL complete wheel, TSLA complete wheel ✓

**File sizes (final confirmed versions):**
  App.jsx:                   122,308 bytes
  ImportModal.jsx:            88,096 bytes
  TradeLog.jsx:              187,561 bytes
  trade-tracker-backend.js:  118,530 bytes

## TO-DO (deferred)

- Double Calendar Spread (call + put calendar simultaneously — new data model needed)

- DOCUMENTATION: Unrealised P&L calculation — document the full priority hierarchy
  for both TradeLog and Close-Out panel so behaviour is clearly explained to the customer:
    Priority 1 — Exact price: live broker (Tradier/Schwab) bid/ask mid during market hours
    Priority 2 — Yahoo fetch: real-time quote (weekday) or previousClose (weekend)
    Priority 3 — BSM estimate (amber "est." badge): inline Black-Scholes using last known
                 stock price (localStorage) + iv_entry + expiration + strikes from trade record
                 → chain strategies (IC/IB/Cal/Diag): always shows est. if stock price available
                 → standalone trades (CC/CSP/LC/LP/spreads): shows est. if iv_entry was recorded
                 → Long Straddle/Strangle: must enter combined Opt $ manually (BSM not applicable)
    Shows "—": only when stock price has never been fetched (brand new install, localStorage empty)
  TradeLog and Close-Out panel are guaranteed in sync at all three priority levels.
  Documentation should also explain the "est." badge and when it appears.

## DESIGN DECISIONS (permanent — do not revisit)

- NO EDIT on chain leg rows (IC/IB/Cal/Diag): chain leg records are immutable once created.
  If the trader enters wrong data they must delete the chain and re-enter it.
  Rationale: editing strikes/entry_price/expiry on a partially-closed leg silently corrupts
  realised P&L. No edit button will ever be added to leg rows.

---

## CHANGELOG

### Sessions 1–69 (2026-03-24/25) — Foundation

Core app built: all 14 strategies, dual-engine demo/live, IC chain structure,
Calendar chain structure, draggable modals, StockPositions lot tracking,
Analytics Dashboard with all tiles, Alerts engine foundation,
Yahoo Finance price fetching (crumb-auth), BSM pricing, ExpiryDatePicker,
option chain viewer in Roll Modal, CC/CSP recommendation strip,
Capital Deployed all components, Standalone P&L tile, Best/Worst chain-level,
Realised P&L drilldown, Gross Premium one-way accumulator,
Price source hierarchy (broker → MarketData → Yahoo → BSM),
IC/Calendar chain filtering in TradeLog, CSV import (4 brokers),
QA documents, spread two-leg pricing fixes.

### Session 150 continued — Manual CSV Import + Comprehensive Sample File

**Manual / Spreadsheet CSV Import — Full Feature**

New `parseManual()` parser added to `ImportModal.jsx`:
- Column detection by name (case-insensitive) — any column order accepted
- All 17 columns supported: ticker, strategy, status, entry_date, expiration, entry_price,
  contracts, strike_sell, strike_buy, exit_price, exit_date, pnl, expiration_back,
  option_type, lot_id, delta, gamma, theta, vega, iv_entry, notes
- No open/close pairing — user provides all fields directly
- END markers silently skipped (compatible with both CSV styles)
- Calendar/Diagonal: validates expiration_back and option_type are present
- IC/IB: passes through for condor_chain_id seeding in handleImport live path
- Skipped rows include clear reason messages shown in the preview panel

UI changes in `ImportModal.jsx`:
- Manual added as 5th broker option (📋 icon)
- Migration card: no guide link for Manual — "Download Sample CSV" button only
- Step 2: column name reference displayed for Manual imports

Backend `trade-tracker-backend.js`:
- manual-sample.csv added to migration file allowlist

`manual-sample.csv` created:
- 28 rows across all 14 strategies, with END markers between strategy groups
- All optional columns populated (delta, gamma, theta, vega, iv_entry)
- Realistic figures matching demo data
- Deployed to both public/migration/ locations

Simulation: 28 trades / 14/14 strategies / 0 failures

**Also completed this session (Session 150 earlier):**

Parser bugs found by end-to-end simulation and fixed:
- Schwab/IBKR/Robinhood: AMZN Long Put expiry was misclassified as CSP
  → Added openPositions tracking to all three parsers (same fix as Tastytrade)
- IBKR Code Ep: qty-sign heuristic was wrong for long options on expiry
  → Replaced with openPositions lookup (reliable regardless of IBKR sign convention)
- Live path event rows (Expired/Assigned) had entry_price=null → backend rejected them
  → Fixed in handleImport: internal fields stripped, 0.01 placeholder added for event rows

Parity: 248/248 PASS throughout

### Session 70 (2026-03-26) — ExpiryDatePicker
Custom Fridays-only calendar for all expiry inputs. Holiday-aware (Good Friday → Thursday).
Quick-jump pills. Replaces all 8 expiry `<input type="date">` fields.

### Session 71–78 (2026-03-26/27) — CC/CSP Recommendation Strip
BSM-powered strike cards (Conservative/Standard/Aggressive). Three states: cards/manual/hidden.
Live IV fetch via fetchAtmIv(). IV override always wins over live feed.
applyRecommendation sets only the correct strike field (CC→strike_sell, CSP→strike_buy).
Strike increment $5 for strikes >$50. Greeks section broker-aware.

### Session 79–81 (2026-03-27) — StockPositions UX
CloseLotModal renamed "Sell Shares / End Wheel". "Close Early" button on CC/CSP rows.
CloseTradeModal pre-fills buy-back from currentPrices. Context nav strip from Alerts.

### Session 82–87 (2026-03-28) — Price Fetch Accuracy
IC/IB spread two-leg net pricing (short − long) across all 4 data sources.
All 4 vanilla spreads (BPS/BCS/BCLS/BPutS) two-leg fix (Math.abs).
Trade History panel: assigned CSP/called-away CC show real premium not $0.
Verification session: 62/62 simulation checks pass.

### Session 88–109 (2026-03-29) — Dashboard Drilldowns + Form Fixes
Gross Premium "▼ By ticker" drilldown. Realised P&L "▼ Details" drilldown.
Capital Deployed "▼ By ticker" drilldown. Auto price refresh after saves.
IB dedicated 4-strike panel. IC/IB save unblocked (isSpread guard).
Chain conflict warning in TradeForm. Delete Chain button. Negative chain IDs → Math.abs.
TradeLog footer count fixed (chains = 1 position each).

### Session 110 (2026-03-30) — IC/Cal Deep Fixes
IB P&L curve: ibTotalCredit = entry × 2 (was single leg, underreported 50%).
IB same-body validation: runs independently of direction error.
Adj IC/IB button on chain header (always visible, no expand needed).
Per-leg Adjust buttons removed from expanded rows (redundant).
IC chain header: adaptive "IC / IB / IC+IB Chains" label.
Calendar/Diagonal entry validations: strike required, expiry rules, DTE warnings.

### Session 111–112 (2026-03-30) — Modal Overhaul
ICAdjustModal: take_profit/reduce_both/roll_full separate put+call close prices.
ICAdjustModal: tile list filtered by chain state. IB one-wing advisory.
CalAdjustModal: Step 3 confirm, golden rule warning, strategy-aware header.
CalAdjustModal: Diagonal support (convert_to_calendar, widen_diagonal).
demoEngine: INOD Diagonal restructured as proper 2-leg chain (id=49/491).
App.jsx + backend: close_position, reduce_position, convert_to_calendar, widen_diagonal.

### Sessions 113–123 (2026-03-31) — Stability + Fixes
ICAdjustModal: reduce_one exclusion lists, IB ATM body locked on all roll types.
ICAdjustModal: IB chain header strike display, roll_full IB section title.
CalAdjustModal: take_profit/close_position merged, J–P validations, rollShortExpiryWarn.
CalAdjustModal: closeLegInPlace guard (avail ≤ 0).
Dashboard: Cal/Diagonal Capital Deployed net debit fix ($992 overstatement corrected).
Dashboard: "All positions closed" → "All premiums settled".
Dashboard: Close-Out P&L IC/Cal chains included in Options Net.
Dashboard: price input fields fixed (LegCloseRow moved outside component body).
TradeLog: confusing open-leg badges removed from IC/Cal chain headers.
TradeForm: IC "Net Credit" field hidden. ICAdjustModal: reduce_one dupe fixed.

### Sessions 124–145 (2026-04-01) — Calendar/Diagonal + Alerts
**option_type field** ('call'|'put') for all Calendar/Diagonal legs:
  TradeForm toggle, TradeLog suffix display, CalAdjustModal carry-forward,
  App.jsx makeNewLeg, backend INSERT/UPDATE/validateTrade/OCC builder.

**TradeForm two-field pricing** for Calendar/Diagonal:
  Front Month Credit + Back Month Cost → greyed computed Net Debit.
  entry_price = long − short computed at submit. Form-only fields, no schema change.

**IB roll enforcement**: ATM body locked on roll_one_leg, roll_resize, roll_full.
  Call sell auto-mirrors put sell for IB. IC-A1 missing sell strike fixed.

**closeLegContracts double-fire guard** on all 4 close helpers (App.jsx + backend).

**Alerts complete overhaul**:
  - All 28 existing alerts reworded to informational tone
  - 8 new P1 alerts (IB wing-width, Cal ITM, credit spread proximity, back month DTE,
    diagonal short expired, long delta <0.30)
  - 7 new P2 alerts (CC/CSP stock drop, Straddle IV crush + leg-out, IC one-wing,
    Calendar IV spike, debit spread near-max)
  - IB proximity: wing-width based (0.5× AMBER, 1× RED); IC keeps 5%

**Analytics simulation**: full numerical verification of all tiles (see verified numbers above).
  Confirmed $24,552 Realised P&L = $12,552 options + $12,000 NVDA share gain.

Regression audit: 27/27 IC/IB/CC/CSP unaffected.

*Last updated: 2026-04-01 — V17 sessions 124–145 + simulation audit complete*

### Session 148 (2026-04-07) — Personas + Resume Prompt + TO-DO Cleanup
Added formal CLAUDE PERSONAS section to PROJECT-CONTEXT-V17.md:
  - Persona 1: Seasoned Stock Options Trader
  - Persona 2: Solution Architect & Developer
  - Persona 3: Expert Technical Document Writer (works with P1 on user docs)
Populated RESUME-PROMPT.md (was empty) with session startup checklist,
all three personas, and standing rules summary.
TO-DO section audited against codebase — 9 of 11 items confirmed implemented:
  Items 2–9 all verified in code and removed from TO-DO.
  Item 7 (no-edit chain legs) moved to permanent DESIGN DECISIONS section.
  Remaining open: Double Calendar Spread (item 1) + Unrealised P&L docs (item 11).

### Session 148 (2026-04-07) — Personas + Resume Prompt
Added formal CLAUDE PERSONAS section to PROJECT-CONTEXT-V17.md:
  - Persona 1: Seasoned Stock Options Trader
  - Persona 2: Solution Architect & Developer
  - Persona 3: Expert Technical Document Writer (works with P1 on user docs)
Populated RESUME-PROMPT.md (was empty) with session startup checklist,
all three personas, and standing rules summary.
Both files will be present in all future zips.

### Session 146 (2026-04-03) — Full session bug fixes

**TradeForm.jsx:**
- Cal/Diagonal form layout reorder: Option Type → Dates → Strikes and Prices
- Section renamed 'Pricing' → 'Strikes and Prices' for Cal/Diagonal
- Strikes first (Short Leg + Long Leg), then Front/Back Month pricing
- Net Debit helper text leads with per-contract cost ($55.00/contract)
- NEW: Diagonal entry validation — short strike must be < long strike (hard error)

**TradeLog.jsx:**
- Column heading 'Qty' → 'Contracts' in Cal/Diagonal detail table
- 'partial' text removed from Leg P&L cell
- P&L chart IV modal: Cal/Diagonal IV edit no longer closes modal (was calling wrong function)
- Cal/Diagonal expiry P&L curve: fixed tent shape — short leg intrinsic at expiry now included
  Formula: (backAtExpiry − shortIntrinsic − netDebit) × contracts_open × 100
- Straddle/Strangle kCall/kPut fallback made unambiguous (kSell > 0 ? kSell : kBuy)
- Bear Put Spread BSM variable names clarified (no math change)

**CalAdjustModal.jsx:**
- Roll Front Month Out: New Expiry hint moved below picker; Net Credit label outside box
- livePnl: uses contracts_open (not original) — e.g. $680 → $340 after reduce
- widen_diagonal validation FIXED: was inverted for puts — blocked valid ($95P→$90P)
  and allowed invalid ($95P→$102P). Now unified: new short must be < long strike for both

**App.jsx + backend.js (PARITY — both fixed):**
- IC makeLeg / insertNewLeg: contracts_original = source.contracts_original (not nConts)
- Cal makeNewLeg / insertLeg: contracts_original = src.contracts_original (not contracts_open)
- Result: "X of Y contracts open" always shows true original chain size as denominator

**Parity checklist: 12/12 PASS**
**QA Suite: MyOptionDiary_QA_Suite_v146.html — 8 new regression sections added**

### Session 147 (2026-04-04) — Unrealised P&L accuracy fixes (3 bugs)

Root cause identified: unrealised P&L was producing wildly wrong values for IC/IB/spread
and partially-reduced Calendar/Diagonal chains. Three bugs fixed across three files.
All fixes are read-only display calculations — no DB schema, no handler, no parity split needed.

**Bug 1 — yahooQuotes.js (HIGH severity): Single-leg spread fallback stored raw option mid**
When Yahoo returned only one of the two expected spread legs (due to illiquidity or chain
gaps), the `else` branch stored the raw individual leg mid as `prices[id].option`.
For IC put wings near the money, this raw mid (~$6.53) instead of net spread (~$1.86)
produced unrealised values like -$986 instead of -$52.
FIX: Added `SPREAD_STRATEGIES` guard in the else branch. When only one leg is found for
IC/IB/BPS/BCS/BCLS/BPutS, the code now runs a BSM net-spread fallback (same as the
zero-legs path) and stores `isBsEst: true`. Non-spread strategies (CC, CSP, Long options)
continue to use the single-leg mid as before.

**Bug 2 — TradeLog.jsx (MEDIUM severity): computeCalChainPnL used t.contracts, not contracts_open**
Calendar/Diagonal unrealised P&L multiplied by `t.contracts` (original total) instead of
`t.contracts_open` (currently open). After a `reduce_position` partial close (e.g. 2→1),
unrealised was doubled. Fixed to `t.contracts_open ?? t.contracts ?? 1`.

**Bug 3 — Dashboard.jsx (MEDIUM severity): IC and Calendar closeOut loops used leg.contracts**
Same issue as Bug 2 in the Close-Out P&L calculation. Both the IC/IB chain loop and the
Calendar/Diagonal chain loop used `leg.contracts || 1` as the multiplier.
Fixed to `(leg.contracts_open != null ? leg.contracts_open : leg.contracts) || 1`
with an added `if (c <= 0) return` guard to skip any fully-closed legs that remain in
the status='open' pool (possible after reduce_position).

**Verified numbers: ALL UNCHANGED** — Realised P&L $24,552 · Gross Premium $24,085 ·
Win Rate 59.3% · all lot premiums. These fixes only affect unrealised display.
SPY IC put leg unrealised corrected from ~-$986 → ~-$52 (BSM at SPY $654, 41 DTE, IV 14%).

**Simulation: 23/23 PASS**
**Parity checklist: 11/11 PASS**

### Session 147 addendum (2026-04-04) — calcTheoPnl BSM consistency fix

**TradeLog.jsx — calcTheoPnl BSM fallback path (spreads):**
Bug: for BCS/BullCS/BPS/BearPS, the BSM fallback used a single-leg strike_sell BSM,
while Dashboard.jsx closeOutOptionPnl correctly used 2-leg net spread BSM.
Result: Theo P&L in TradeLog did NOT match the Close-Out P&L contribution in Dashboard
when Opt $ was blank (e.g. total Yahoo+broker fetch failure). Divergence up to $300–$600.

Fix: calcTheoPnl now uses the exact same per-strategy branching as Dashboard:
  Call spreads (BCS/BullCS): BSM(kSell,call) − BSM(kBuy,call)
  Put  spreads (BPS/BearPS): BSM(kBuy,put)   − BSM(kSell,put)
Long Straddle/Strangle added to SKIP_EST (were in SKIP_BS, now explicit).

Simulation: 14/14 strategies pass — TradeLog and Dashboard now produce identical
BSM estimates for every standalone strategy in every scenario.
Only affects the BSM fallback path (Opt $ blank). Opt $ populated path was always correct.

**TradeLog.jsx — computeChainPnL hasPrices flag (IC/IB chains):**
Bug: unrealisedPnL=0 was shown as "—" for both "no price" and "true breakeven".
Fix: added hasPrices flag (same pattern as computeCalChainPnL). Display, Total P&L,
and destructuring updated. 22/22 scenarios pass.

**yahooQuotes.js — Calendar/Diagonal getOptionFetchDescriptors option_type:**
Bug: hardcoded isCall=true for ALL Calendar/Diagonal legs, ignoring option_type field.
Effect: put calendars/diagonals fetched the wrong (call) chain → no strike match →
  BSM fallback also ran with wrong isCall → wildly incorrect estimate
  (e.g. ABBV put cal: priced $38.74 call instead of $0.002 put).
Fix: isCallOt = trade.option_type !== 'put' — matches backend buildTradierOptionSymbol
  and Dashboard BSM exactly. Legacy records (no option_type) default to call. ✓
  BSM fallback inherits correct isCall automatically via descs array.
18/18 scenarios pass. Call calendars unchanged; put calendars/diagonals now correct.

**backend.js + yahooQuotes.js — Yahoo expiry snap guard:**
Bug: Yahoo's ?date= API snaps to the nearest available expiry when the requested
expiry isn't in their system. For SPY May-22 (weekly), Yahoo returns May-15 data.
The backend /api/yahoo/chain handler used the nearest expiry blindly — no check.
The frontend direct fallback also used options[0] blindly.
Effect: IC legs with non-standard weekly expiries got WRONG-EXPIRY option prices
  (May-15 prices for a May-22 trade = 7 days short DTE). This produced incorrect
  unrealised P&L in TradeLog and prevented the BSM fallback from firing correctly.
  TradeLog showed either a wrong value or "—", while Dashboard (which runs its own
  inline BSM) correctly showed ~-$362.
Fix: Added expiry proximity guard in BOTH locations:
  - backend /api/yahoo/chain: if |returned_expiry - requested_expiry| > 7 days → return []
  - yahooQuotes.js fetchOptionChainYahoo direct fallback: same check on candidate.expirationDate
  When rejected → legResults = {} → BSM fallback fires with correct T (48d for May-22)
  → prices[t.id].option populated → TradeLog shows same -$362 est. as Dashboard ✓
Simulation: 7/7 pass. Standard expiries (≤7d off) unaffected.

**TradeLog.jsx — computeChainPnL hasPrices flag (IC/IB chains):**
Bug: computeChainPnL returned unrealisedPnL=0 when no option price was available,
and the display condition `unrealisedPnL !== 0` showed "—" for BOTH cases:
  (a) no price fetched yet — correct to show "—"
  (b) price available but chain exactly at breakeven — should show "+$0.00"
Calendar chains (computeCalChainPnL) already had a hasPrices flag — IC/IB did not.

Fix: added hasPrices tracking to computeChainPnL (same pattern as Calendar):
  - hasPrices=true when ANY open leg has prices[t.id]?.option != null
  - Display: hasPrices → show value (even +$0.00); !hasPrices → show "—"
  - Total P&L tile: hasPrices → realised+unrealised; !hasPrices → realised only
  - Destructuring on call site updated to include hasPrices
Simulation: 22/22 scenarios pass across all IC/IB partial/full/closed states.

### Session 150 (2026-04-08) — CSV Import full wheel reconstruction

**ROOT CAUSE:** The zip shipped today contained old sample CSVs (no END markers,
no BUY/SELL stock rows) and old parsers that did not handle them. The correct
sample files existed but parser code was never written to match.

**All 4 parsers rewritten in ImportModal.jsx:**

*Schwab*
- `Buy` action (no OCC symbol) → `_lotCreate` stock purchase record
- `Assigned` on PUT → CSP option closed + `_event: assigned_put`
- `Assigned` on CALL → CC option closed + `_event: called_away`
- `Expired` → option closed at $0 + `_event: expired`
- END markers emitted as `_endMarker` records (were already present)

*Tastytrade*
- `Receive Deliver / Buy to Open` (no OCC symbol) → `_lotCreate`
- `Receive Deliver / Sell to Close` (no OCC symbol) → `_lotClose`
- `Receive Deliver / Expiration` — now correctly distinguishes short (CC/CSP)
  from long (Long Call/Put) using `openPositions` map built from Trade rows.
  Previously always assumed short. AMZN Long Put expiry now correctly typed.
- `Receive Deliver / Assignment` (CSP) → `_event: assigned_put`
- `Receive Deliver / Assignment` (CC) → `_event: called_away`

*IBKR*
- `Stocks` Asset Category + qty > 0 → `_lotCreate` (outright buy or CSP assignment)
- `Stocks` Asset Category + qty < 0 → `_lotClose` (called away or sale)
- `Code Ep` → expired + `_event: expired` (previously fell through to skipped)
- `Code A` (put option) → `_event: assigned_put` (previously fell through to skipped)
- `Code A` (call option) → `_event: called_away` (previously fell through to skipped)
- END markers now parsed (IBKR parser previously only read `Trades,Data` rows)

*Robinhood*
- `BUY` trans code (no OCC symbol) → `_lotCreate`
- `SELL` trans code (no OCC symbol) → `_lotClose`
- `OEXP` → expired + `_event: expired` (previously fell through to skipped)
- `OASGN` (put) → `_event: assigned_put` (previously fell through to skipped)
- `OASGN` (call) → `_event: called_away` (previously fell through to skipped)
- `DIV`, `ACH`, `CDIV`, `INT`, etc. → new `SILENT_SKIP_CODES` set (silently skipped)
- END markers now parsed

**handleImport in App.jsx rewritten (3-step lot-aware flow):**
- Step 1: Creates lots from `_lotCreate` rows BEFORE processing options.
  Both isMock and live paths. `importedLotMap` tracks newly created lots
  so option trades in the same END group can auto-link to them.
- Step 2: Closes lots from `_lotClose` rows. Matches to most recently
  created lot for that ticker. Both isMock and live paths.
- Step 3: Option trades enriched and auto-linked as before, but now uses
  `snapshotLots` (includes freshly created lots) for matching.
- `_event` flag bypasses zero-price filter — assigned/expired rows
  have null entry_price but are valid closed records.
- `clearStockCache` called on all imported tickers after import.

**Sample CSVs replaced with correct migration-format files:**
All 4 broker sample files now contain complete wheel histories with END markers,
stock BUY/SELL rows, OEXP/OASGN/Code Ep/Code A events.

**Tastytrade sample updated to match Tastytrade_Migration_Guide.docx.**
README.md rewritten to describe actual sample content.

**Simulation results:**
- Schwab:     30/30 rows ✓ (25 handled + 5 silently skipped)
- IBKR:       29/29 rows ✓ (all handled)
- Robinhood:  32/32 rows ✓ (29 handled + 3 silently skipped)
- Tastytrade: 34/34 rows ✓ (0 issues — including Long Put expiry fix)

**Parity: 248/248 PASS. No backend schema changes. demoEngine.js untouched.**


### Session 150 (2026-04-08) — Import Parser Complete Rebuild + Full Audit

**Root cause identified:** The zip contained old parsers and old sample CSVs.
The sample files (with END markers, BUY/SELL stock rows, OEXP/OASGN/Code Ep/Code A)
existed but the parsers were never updated to match them.

**ImportModal.jsx — all 4 parsers fully rebuilt:**

Schwab:
  - `Buy` action (equity) → `_lotCreate` (lot creation)
  - `Assigned` on PUT → CSP closed + `_lotCreate` inline (lot from assignment)
  - `Assigned` on CALL → CC closed + `_lotClose` inline (lot called away)
  - `Expired`, `Exercise` already handled — confirmed working

IBKR:
  - `Code Ep` → expired worthless (was falling to unrecognised/skipped)
  - `Code A` option row → assigned/called-away (was falling to skipped)
  - `Asset Category=Stocks` + qty>0 → `_lotCreate` (purchase or assignment)
  - `Asset Category=Stocks` + qty<0 → `_lotClose` (called away or sale)
  - END markers now parsed correctly (were only read by Tastytrade before)

Robinhood:
  - `OEXP` → expired worthless (was surfacing in skipped panel)
  - `OASGN` → assignment/called-away flagged (was surfacing in skipped panel)
  - `BUY` equity → `_lotCreate` (was surfacing in skipped panel)
  - `SELL` equity → `_lotClose` (was surfacing in skipped panel)
  - `DIV`/`ACH`/`CDIV`/`INT` → SILENT_SKIP_CODES (no longer in skipped panel)
  - END markers now parsed correctly

Tastytrade (3 additional fixes):
  - `Receive Deliver / Buy to Open` (no OCC symbol) → `_lotCreate`
    (was silently skipped — handles both CSP assignment and outright purchase)
  - `Receive Deliver / Sell to Close` (no OCC symbol) → `_lotClose`
    (was silently skipped — handles CC called away)
  - `Receive Deliver / Expiration` now correctly identifies Long vs Short:
    `openPositions` map tracks BTO/STO for each symbol; Expiration reads it
    to derive Long Call/Put (BTO) vs CC/CSP (STO). Previously always assumed short.

**App.jsx — handleImport fully rebuilt:**
  - Step 1: Creates lots from `_lotCreate` rows BEFORE processing option trades
  - Step 2: Closes lots from `_lotClose` rows
  - Step 3: Option trades auto-link to freshly created lots (including inline
    assignment lot creation from Schwab)
  - `importedLotMap` tracks newly created lot IDs within the import batch
  - `snapshotLots` builds a local view of lots post-create/close for auto-linking
  - Works in both demo (isMock) and live paths with full parity
  - `clearStockCache` + `postSaveRefresh` added after import

**Sample CSVs updated** — all 4 correct migration-format files now in zip:
  - schwab-sample.csv: END markers, BUY stock rows, Assigned/Expired events
  - ibkr-sample.csv: END markers, Code A/Ep, Stocks rows
  - robinhood-sample.csv: END markers, OASGN/OEXP, BUY/SELL equity rows
  - tastytrade-sample.csv: END markers, RD/BuyToOpen, RD/SellToClose stock rows
  - README.md rewritten to match actual sample content

**Audit: 248/248 automated parity + 56/56 manual audit checks PASS**
  Three scenario audit: all pass (Scenario 1 browser, 2 Electron-dev, 3 Build)
  LicenseGate bypass: IS_DEV_MODE (NODE_ENV=development + port 3000) ✓
  Both codebases (active + root mirror) verified in sync ✓
  Migration resource files: all 8 present in public/migration ✓

### Session 149 (2026-04-08) — Panel Redesign + Screenshots + Migration Downloads + Source Fix

**CRITICAL DISCOVERY — Active Codebase:**
The zip contains two parallel copies of the codebase:
  - options-tracker-v17/trade-tracker/  ← ACTIVE (all 3 scenarios run from here)
  - trade-tracker/                       ← secondary mirror only
All previous sessions were only updating the root-level copy. Standing Rule 11
added to permanently enforce options-tracker-v17/trade-tracker/ as the sole
source of truth. Both copies are now kept in sync in every zip.

**QuickStart + Help panels — right side, 750px:**
  - QuickStartPanel.jsx: moved from left:240/width:340 to right:0/width:750,
    animation slideInLeft → slideInRight, borderRight → borderLeft
  - HelpPanel (index.css): width 460px → 750px, shadow updated
  - New .panel-backdrop CSS class: rgba(0,0,0,0.25) dim with fadeInBackdrop
    animation, z-index:899. Click backdrop to close either panel.
  - html.dark .panel-backdrop override: rgba(0,0,0,0.50)
  Applied to: options-tracker-v17/trade-tracker/src/index.css
              options-tracker-v17/trade-tracker/src/components/QuickStartPanel.jsx
              options-tracker-v17/trade-tracker/src/components/HelpPanel.jsx

**QuickStart screenshots — 35 images embedded:**
  - All 35 screenshots extracted from MyOptionDiary_QuickStart_V18.docx
  - Compressed to WebP quality 82: 7.3MB raw → 1.27MB (82% reduction)
  - Base64-encoded and embedded as const SS = { rId7..rId41 } in QuickStartPanel.jsx
  - Shot component renders inline with caption, border, and shadow
  - 14 Shot placements across all major cards:
    Stock Positions (rId9), CC entry (rId10), CSP entry (rId12),
    IC entry (rId26), Calendar entry (rId32), Adj IC (rId30),
    Adj Cal (rId35), Assignment (rId14), Called Away (rId17),
    Trade Log (rId11), Import CSV (rId13), Alerts (rId40),
    Dashboard (rId39), Fetch Prices (rId41)

**Migration downloads — fixed for Electron:**
  Root cause: <a href="/migration/..."> bare paths don't trigger downloads in
  Electron because webSecurity:true intercepts navigation to binary files.
  Fix: new GET /api/migration/:filename route in trade-tracker-backend.js —
    - Allowlist of 8 files (4 docx guides + 4 sample CSVs)
    - Content-Disposition: attachment header forces download
    - Correct MIME types (.docx, .csv)
    - IS_ELECTRON path: process.resourcesPath/app/migration/
    - Dev path: __dirname/public/migration/
  ImportModal.jsx: MIGRATION_RESOURCES constant → getMigrationResources()
  function using getBase() at runtime so URLs resolve through
  http://127.0.0.1:PORT/api/migration/... in all environments.
  public/migration/ folder confirmed present in options-tracker-v17/trade-tracker/
  public/migration/ (8 files) — copied into build/ by React build process,
  then into resources/app/ by electron-builder → available to shipped .exe.

**Parity: 11/11 PASS — pure UI/display changes, no trade logic touched.**
