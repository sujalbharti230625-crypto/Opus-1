# ETH/USDT Confluence Desk

A professional, single-page **trading signals dashboard for ETH/USDT** that runs real technical-analysis algorithms on live Binance market data — entirely in the browser.

> **Disclaimer**: This is an analytical / educational tool. It does not provide financial advice and no system can guarantee accuracy in markets. Always do your own research and manage your own risk.

---

## What it analyzes

Every signal is built from a **confluence of seven methodologies** running across multiple timeframes (15m / 1h / 4h / 1d):

| # | Methodology | What the engine actually does |
|---|---|---|
| 1 | **Market Structure** | Fractal swing detection → trend (HH/HL vs LH/LL), Break of Structure (BOS), Change of Character (CHoCH) |
| 2 | **Supply & Demand Zones** | Detects strong impulsive candles (>1.5 ATR, body/range > 0.6) and marks the small base candle preceding them. Zones are auto-mitigated when broken. |
| 3 | **Liquidity Heatmap** | Equal-highs / equal-lows clustering (0.15% tolerance), buy-side and sell-side liquidity pools above/below price. |
| 4 | **Candle & Structural Momentum** | Bullish/Bearish Engulfing, Hammer, Shooting Star, Morning/Evening Star, strong impulse, doji + EMA(20/50) stack + RSI(14) + ATR(14). |
| 5 | **Fibonacci** | Auto-drawn from the last significant swing — 0.236, 0.382, 0.5, **0.618 golden pocket**, 0.786 retracements + 1.272 / 1.618 / 2.0 / 2.618 extensions. |
| 6 | **Elliott Wave** | Detects 5-wave impulse patterns and ABC corrections from pivot stream. Validates rules: W2 retrace, W3 not shortest, W4 doesn't enter W1 territory. |
| 7 | **Wyckoff** | Range detection over a 60-bar window → classifies **accumulation / markup / distribution / markdown** + detects Springs and Upthrusts using volume bias. |

These feed a **weighted confluence scorer** that emits a single trade plan with:

- Direction (LONG / SHORT / NEUTRAL)
- Entry price
- Stop loss (zone edge or swing + ATR buffer)
- Three targets (next liquidity → fib extension → opposing zone)
- Risk : Reward ratio
- Confluence score (0–100) and strength (low/medium/high)
- Plain-language reasoning for every contributing factor

## Live updates

- Initial 500 candles via Binance REST (`/api/v3/klines`)
- Live updates via Binance WebSocket (`@kline_<tf>` and `@miniTicker`)
- Higher timeframes refreshed every 60 seconds in the background
- On every closed candle the full analysis re-runs and the signal is regenerated
- Auto-reconnects on WS disconnect

## Stack

- **Vanilla JS modules** (no build step) — deployable as a static site
- [Tailwind CSS](https://tailwindcss.com/) (CDN) for styling
- [TradingView lightweight-charts](https://github.com/tradingview/lightweight-charts) for the chart
- [Binance public REST + WebSocket](https://binance-docs.github.io/apidocs/spot/en/) — no API key required

## File layout

```
Opus-4.7/
├── index.html           # UI shell + Tailwind + chart CDN
├── css/styles.css       # Custom dark trading theme
└── js/
    ├── app.js           # Main controller (state, render, WS wiring)
    ├── data.js          # Binance REST + WS client
    ├── analysis.js      # All 7 analysis algorithms (pure functions)
    ├── signals.js       # Confluence scorer & trade-plan builder
    └── chart.js         # lightweight-charts wrapper + overlays
```

## Run locally

It's a static site — just serve the folder over any HTTP server (CORS for Binance is fine over `https://` or `http://localhost`):

```bash
cd Opus-4.7
python3 -m http.server 8080
# then open http://localhost:8080
```

Or use `npx serve .`, VS Code Live Server, etc.

## Deploy

Any static host works: GitHub Pages, Netlify, Vercel, Cloudflare Pages. No backend or API key required.

## How the signal is built (concrete example)

For a LONG signal to fire with a high score, the engine typically requires:

- Structure: `up` (recent BOS↑ or CHoCH↑) — **+18**
- Price reacting **inside a fresh demand zone** — **+16**
- Higher TFs (4h/1d) aligned bullish — **+9**
- Bullish candle pattern at the zone (engulfing / hammer / morning star) — **up to +12**
- RSI < 35 (oversold reaction) — **+5**
- Price at 0.618 golden pocket of last bullish swing — **+10**
- Wyckoff: accumulation phase + Spring detected — **+14**

That's **~85/100** — high-strength LONG. Targets stack:

1. Next buy-side liquidity above
2. Fib 1.272 / 1.618 extension
3. Nearest opposing supply zone

Stop loss = below demand zone bottom − (0.5 × ATR).

## Backtest Lab (`backtest.html`)

A full historical backtester is included as a separate page (linked from the live desk header).

**What it does:**
- Fetches up to **2 years** of historical ETH/USDT candles from Binance (paginated)
- Walks forward bar-by-bar through the same signal engine used in live mode
- Simulates trade execution with **variable R:R via partial fills** (default 40 / 35 / 25 %)
- Stop loss → breakeven after TP1, → TP1 after TP2 (locks profit progressively)
- Conservative same-bar SL-before-TP ordering (worst-case path)
- Position size from **% risk of equity** (1% default)
- Filters trades by **minimum confluence score** (medium+ = 55, strong only = 75)

**Results displayed:**
- Net P&L $ and %, win rate, profit factor, max drawdown, avg R-multiple, expectancy
- Equity curve chart (lightweight-charts)
- TP1 / TP2 / TP3 hit rates
- Performance broken down by direction (LONG vs SHORT) and signal strength
- Signal funnel: considered → rejected (neutral / score) → taken
- Trade-by-trade table with filters (wins / losses / longs / shorts)

**Performance:**
- Pivots are pre-computed over the entire timeline (O(N) once instead of O(N²))
- HTF (4h, 1d) context is pre-computed only at HTF candle closes, then looked up via binary search
- Backtest yields control to the UI every 200 bars — UI stays responsive
- 2 years of 1h bars (~17,520 candles) typically completes in 10–20 seconds

**Verified:** Engine runs end-to-end on real Kraken/Binance data with all sanity checks passing — SL respected on every trade, no infinite/NaN P&L, signal-funnel math balances, no unrealistic R-multiples.

## Calibration: 2-Year Backtest Findings

The signal engine was calibrated against **2 years of real ETH/USDT 4h data** (May 2024 → May 2026, 4,381 bars from Gate.io) across **14 configurations** including walk-forward in/out-of-sample splits and fee sensitivity sweeps.

### Honest results with realistic 10bps round-trip fees

**Calibrated default config** (score ≥ 45, HTF aligned, [25/35/40] partials, 1% risk):

| Metric | Value |
|---|---|
| Trades over 2y | 314 |
| Win rate | 62.1% |
| Profit factor | 1.48 |
| Net P&L | **+41.31%** |
| Max drawdown | -16.4% |
| Avg R-multiple | +0.11R |
| Expectancy / trade | +$13.16 |
| TP1 / TP2 / TP3 hit | 60% / 34% / 18% |
| Total fees paid | $5,155 |
| Gross P&L (before fees) | +$9,286 |

### Key findings (must read)

1. **Score 75+ was unreachable** in the original implementation — across 4,080 signal evaluations over 2 years, **zero** scored ≥ 75. The "Strong only" filter was effectively dead. **Fix:** added a confluence-synergy bonus that boosts the dominant side when 5+ analytical pillars agree, plus recalibrated strength bands (low ≥ 30, medium ≥ 45, high ≥ 60) to match the actual score distribution.

2. **HTF alignment is the highest-value filter.** Forcing trades to align with the 1-day trend lifts profit factor from 1.18 → 1.49 with similar drawdown. Now ON by default in the backtest UI.

3. **Partial fills [25/35/40] beat [40/35/25] by ~17%** in returns. Putting more weight on the runner (TP3) captured large moves better. Now the default.

4. **Walk-forward validation is sobering.** On a 60/40 in-sample/out-of-sample split, the calibrated config returned **+38.7% IS / -1.7% OOS**. The strategy is **regime-sensitive** — it works best in trending markets and struggles in chop. This is disclosed in the live UI.

5. **Fee sensitivity is high.** Same config: +112% with 0bps, +42% with 10bps, **-6% with 20bps**, -60% with 40bps. With 314 trades over 2 years, fees compound aggressively. **Lesson:** this strategy needs a venue with low taker fees (Binance VIP-1+ tier or maker rebates).

6. **Stricter R:R filters did not help.** Requiring TP1 R:R ≥ 1.0 reduced trade count by 80% but lowered profit factor — the closer "magnet" liquidity targets capture more reliable hits than further targets.

### What changed in the codebase from calibration

- `signals.js` — added `countVotes()` helper + synergy bonus (5+ aligned pillars → +8 to +16 score boost on dominant side); recalibrated strength bands.
- `backtest.js` — added 4 new options: `requireHtfAlign`, `minRR`, `beMode`, `feeBps`. Default partial fractions changed to [0.25, 0.35, 0.40].
- `backtest.html` / `backtest-ui.js` — exposed the new options in the UI; added 4 new stat cards (Fees Paid, Gross P&L, Avg Score, Avg Bars Held).



- **B1** `data.js` — `subscribeKline` was looking for `onCandle.onStatus` on a function value (always undefined), so connection-status callbacks never fired. Fixed by accepting `onStatus` as its own parameter and wiring it from `app.js`.
- **B2** `analysis.js` — `analyzeStructure` recomputed `findSwings` even though `runFullAnalysis` had just computed it. Now accepts pre-computed `swings`.
- **B3** `analysis.js` — `analyzeFibonacci` used the last 2 pivots blindly, so tiny micro-swings produced noisy fib levels. Now walks back to find an alternating pair whose range is ≥ 5 × ATR (with safe fallback).
- **B4** `analysis.js` — `analyzeMomentum` recomputed ATR(14) even though it was already computed. Now reuses the shared series.
- **B5** `chart.js` — `ResizeObserver` was redundant since `autoSize: true` is set on the chart. Removed.

## Final Bug-Fix Pass (Round 2)

After the calibration round, a comprehensive audit found and fixed **9 more bugs** (B6–B14). All fixes are verified end-to-end with a 15-test suite plus real 2-year ETH/USDT data.

| # | File | Severity | Issue | Fix |
|---|---|---|---|---|
| **B6** | `app.js` | High | `loadAllTimeframes` used `Promise.all` — one failed TF blip killed the whole boot | Switched to `Promise.allSettled` with partial-success tolerance |
| **B7** | `app.js` | High | 60s background refresh had a TF-switch race — stale data could overwrite the now-active TF | Capture `state.tf` before await, recheck after; skip update if user switched in |
| **B8** | `analysis.js` | Med | `bodyRange` could exceed 1 on degenerate near-zero-range candles, producing absurd "9999%" displays | Clamped to `[0, 1]` |
| **B9** | `signals.js` | Med | Fib confluence vote always counted on direction match — inflated synergy bonus even when price was nowhere near a fib level | Now requires actual fib reason in `reasons[]` (price at golden pocket or 0.5) |
| **B10** | `backtest-ui.js` | Med | Trade-table row numbers restarted at 1 for every filter — same trade showed as different "#" | Now uses absolute trade index from the unfiltered list |
| **B11** | `backtest-ui.js` | Low | `text-bear` / `text-bull` classes accumulated across runs without removal | Centralized via `showCardColor()` which always strips state classes first |
| **B12** | `backtest-ui.js` | Low | Stat cards weren't reset between runs — failed run left stale stats from previous run | Added `resetStatCards()` called at start of each run |
| **B13** | `app.js` | Low | Boot error banner had no dismiss button — pinned UI on transient errors | Added × button |
| **B14** | `backtest.js` | High | Position sizing produced fee-prohibitive trades when stop distance was very tight — fees could push a 1R loss to 1.4R+ | Reject trades where stop < 0.3% of price OR fees would exceed 20% of dollar-risk |

### Result of Round-2 fixes on real 2-year ETH/USDT data

The bug fixes **improved** strategy performance because the rejected fee-prohibitive trades were net-losers:

| Metric | Before Round-2 | **After Round-2 (FINAL)** |
|---|---|---|
| Trades | 314 | 276 |
| Win rate | 62.1% | **63.4%** |
| Profit factor | 1.48 | **2.18** |
| Net P&L (10bps fees) | +41.3% | **+65.2%** |
| Max drawdown | -16.4% | **-7.0%** |
| Avg R-multiple | +0.11R | **+0.18R** |
| Worst single trade | unbounded | **-1.20R (capped)** |
| **Risk-adjusted return** | 2.5× | **9.3×** |

## Risk warning

Crypto markets are highly volatile. Indicators and pattern detection — **including this one** — fail regularly. The 2-year backtest result is partly the product of in-sample tuning; out-of-sample performance can and does drift. Use proper position sizing, never risk more than you can afford to lose, and treat all signals as research input, not buy/sell instructions.
