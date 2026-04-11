# MyOptionDiary — Sample Import CSVs

One sample file per supported broker. All four files contain the **same wheel
history** across the same tickers, formatted for each broker's export convention.
Use them to verify the parser produces correct results before importing your own data.

---

## Files

| File | Broker | Parser |
|------|--------|--------|
| `schwab-sample.csv`     | Charles Schwab      | parseSchwab()     |
| `tastytrade-sample.csv` | Tastytrade          | parseTastytrade() |
| `ibkr-sample.csv`       | Interactive Brokers | parseIBKR()       |
| `robinhood-sample.csv`  | Robinhood           | parseRobinhood()  |

---

## What each file contains

Six complete wheel histories and two directional trades, grouped with END markers:

| Group | Ticker | History | Lots created | Lots closed |
|-------|--------|---------|--------------|-------------|
| 1 | AAPL | CSP → Assigned → CC (closed early) → CC (called away) | 1 (from assignment) | 1 (called away) |
| 2 | NVDA | CSP → Expired worthless | 0 | 0 |
| 3 | MSFT | CSP → Closed early (BTC) | 0 | 0 |
| 4 | TSLA | Stock purchase → CC (expired) → CC (called away) | 1 (outright buy) | 1 (called away) |
| 5 | META | Long Call → Closed (STC) | 0 | 0 |
| 6 | AMZN | Long Put → Expired worthless | 0 | 0 |

Non-option rows (dividends, fees, money movement, cash reports) are included
in each file to verify they are silently skipped.

---

## Expected import result (all brokers)

After parsing, lot creation, and open/close pairing:

**Lots created:** 2 (AAPL from CSP assignment, TSLA from outright purchase)  
**Lots closed:** 2 (AAPL called away, TSLA called away)

**Option trades imported:**

| # | Ticker | Strategy | Status | Entry | Notes |
|---|--------|----------|--------|-------|-------|
| 1 | AAPL | Cash-Secured Put | Closed — Assigned | $3.45 | Event flagged — use Assignment button |
| 2 | AAPL | Covered Call $215 | Closed | $3.80 | Paired with BTC → P&L +$190 (2 contracts) |
| 3 | AAPL | Covered Call $220 | Closed — Called Away | $5.10 | Event flagged — use Called Away button |
| 4 | NVDA | Cash-Secured Put | Closed — Expired | $4.80 | Expired worthless |
| 5 | MSFT | Cash-Secured Put | Closed | $4.50 | Paired with BTC → P&L +$225 (1 contract) |
| 6 | TSLA | Covered Call $320 | Closed — Expired | $9.20 | Expired worthless |
| 7 | TSLA | Covered Call $325 | Closed — Called Away | $8.40 | Event flagged — use Called Away button |
| 8 | META | Long Call | Closed | $12.30 | Paired with STC → P&L −$550 (1 contract) |
| 9 | AMZN | Long Put | Closed — Expired | $9.60 | Expired worthless (long, not short) |

**IBKR note:** Closed trades use IBKR's own Realized P/L figure (net of
commissions) rather than the computed entry−exit difference.

---

## END marker convention

Each group ends with a line containing just `END`. This separates complete lot
histories so the importer can sequence lot creation → option trades → lot closure
in the correct order. All four brokers use the same END convention.

---

## How to use

1. Open MyOptionDiary in Demo Mode (npm start)
2. Go to Trade Log → Import CSV
3. Select the broker matching the file
4. Upload the sample file
5. Verify the preview shows the lot creation banners and correct trade count
6. Confirm — then check Stock Positions to see the 2 new lots

On the second import of any file, deduplication removes all trades already
present and shows 0 new trades.
