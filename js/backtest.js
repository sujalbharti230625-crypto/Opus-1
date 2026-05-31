// backtest.js — Walk-forward backtesting engine.
//
// Replays historical ETH/USDT candles bar-by-bar, calls the same signal
// engine used in live mode, and simulates trade execution with:
//   - Variable R:R (3 partial targets per trade)
//   - Stop loss + breakeven stop after TP1, locked-in stop after TP2
//   - Conservative same-bar SL-before-TP ordering
//   - Position sizing by % risk of equity (risk-based, not fixed-size)
//   - Drawdown tracking
//   - Filter trades by minimum confluence score (medium+ by default)
//
// All algorithms live in analysis.js / signals.js — this module only does
// simulation, so live and backtest signals come from the same source.

import {
  atr, findSwings,
  analyzeStructure, analyzeZones, analyzeLiquidity,
  analyzeMomentum, analyzeFibonacci, analyzeElliott, analyzeWyckoff,
} from './analysis.js';
import { generateSignal } from './signals.js';

// ──────────────────────────────────────────────────────────────────────────
// Pre-compute helpers
// ──────────────────────────────────────────────────────────────────────────

/** Compute swings over the entire candle series ONCE; return pivots with confirmation index. */
function precomputeSwings(candles, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ i, time: candles[i].time, price: candles[i].high, confirmedAt: i + right });
    if (isLow)  lows.push({ i, time: candles[i].time, price: candles[i].low, confirmedAt: i + right });
  }
  // Build sorted alternating pivot list (same logic as findSwings)
  const pivots = [];
  let hi = 0, li = 0;
  while (hi < highs.length || li < lows.length) {
    const h = highs[hi], l = lows[li];
    if (!h) { pivots.push({ ...l, type: 'L' }); li++; continue; }
    if (!l) { pivots.push({ ...h, type: 'H' }); hi++; continue; }
    if (h.i < l.i) { pivots.push({ ...h, type: 'H' }); hi++; }
    else            { pivots.push({ ...l, type: 'L' }); li++; }
  }
  // Alternate by keeping most extreme of consecutive same type
  const alt = [];
  for (const p of pivots) {
    const prev = alt[alt.length - 1];
    if (prev && prev.type === p.type) {
      if (p.type === 'H' && p.price > prev.price) alt[alt.length - 1] = p;
      else if (p.type === 'L' && p.price < prev.price) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  return alt;
}

/** Build per-step analysis from precomputed pivots + bar slice for zones/wyckoff. */
function analyzeAtStep(candles, allPivots, idx, windowSize) {
  // Confirmed pivots up to and including current bar
  const confirmedPivots = [];
  for (const p of allPivots) {
    if (p.confirmedAt <= idx) confirmedPivots.push(p);
    else break;
  }
  // Recompute alternation just for the confirmed slice (cheap, runs on already-alternating data)
  const swings = { highs: confirmedPivots.filter(p => p.type === 'H'),
                   lows:  confirmedPivots.filter(p => p.type === 'L'),
                   pivots: confirmedPivots };

  const start = Math.max(0, idx - windowSize + 1);
  const slice = candles.slice(start, idx + 1);
  const atrSeries = atr(slice, 14);
  const structure = analyzeStructure(slice, swings);
  const zones = analyzeZones(slice, atrSeries);
  const liquidity = analyzeLiquidity(slice, swings);
  const momentum = analyzeMomentum(slice, atrSeries);
  const fib = analyzeFibonacci(slice, swings, atrSeries);
  const elliott = analyzeElliott(swings);
  const wyckoff = analyzeWyckoff(slice, atrSeries);
  return {
    candles: slice,
    swings,
    structure, zones, liquidity, momentum, fib, elliott, wyckoff,
    price: candles[idx].close,
  };
}

/**
 * Pre-compute HTF analysis at each HTF candle close.
 * Returns array of { time, analysis } indexed by HTF candle.
 */
function precomputeHTFAnalyses(htfCandles, windowSize = 200) {
  const allPivots = precomputeSwings(htfCandles);
  const out = [];
  // Start from bar 60 (need enough for wyckoff/atr/swings)
  for (let i = 60; i < htfCandles.length; i++) {
    out.push({
      time: htfCandles[i].time,
      analysis: analyzeAtStep(htfCandles, allPivots, i, windowSize),
    });
  }
  return out;
}

/** Look up the most recent HTF analysis at-or-before a given LTF time. */
function htfAt(htfAnalyses, time) {
  // Binary search for last analysis with time <= target
  let lo = 0, hi = htfAnalyses.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (htfAnalyses[mid].time <= time) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans >= 0 ? htfAnalyses[ans].analysis : null;
}

// ──────────────────────────────────────────────────────────────────────────
// Trade simulation
// ──────────────────────────────────────────────────────────────────────────

function openTradeFromSignal(sig, entryBar, equity, riskPct, partialPct, feeBps = 0) {
  const entry = entryBar.open;     // realistic: enter at next bar's open
  const risk  = Math.abs(entry - sig.sl);
  if (risk <= 0) return null;
  // Re-anchor SL/TPs against the actual entry (entry might differ from sig.entry if we entered next bar open)
  const slDist = sig.sl - sig.entry;
  const tp1Dist = sig.tp1 - sig.entry;
  const tp2Dist = sig.tp2 - sig.entry;
  const tp3Dist = sig.tp3 - sig.entry;
  const sl  = entry + slDist;
  const tp1 = entry + tp1Dist;
  const tp2 = entry + tp2Dist;
  const tp3 = entry + tp3Dist;
  const adjRisk = Math.abs(entry - sl);
  if (adjRisk <= 0) return null;

  // BUG FIX (B14): reject trades whose stop distance is too tight relative to price.
  // With a fixed dollar-risk of equity*riskPct, a tiny stop distance produces a
  // huge position size, and the round-trip fees (charged on notional, not risk)
  // can swallow the entire risk budget — making a "1R loss" actually -3R or worse.
  // Floor the stop distance at 0.3% of entry price.
  const minStopPct = 0.003;
  if (adjRisk / entry < minStopPct) return null;

  const dollarRisk = equity * riskPct / 100;
  const size = dollarRisk / adjRisk;

  // BUG FIX (B14 cont.): also reject if estimated round-trip fees would exceed
  // 20% of the dollar-risk. This caps worst-case loss at ~1.20R (1R from SL +
  // ~0.20R from fees) so a "1R loss" stays within reasonable bounds while still
  // permitting most legitimate setups.
  if (feeBps > 0) {
    const estFees = (entry + sl) * size * (feeBps / 10000);   // entry + worst-case exit
    if (estFees > dollarRisk * 0.20) return null;
  }

  return {
    dir: sig.direction,
    score: sig.score,
    strength: sig.strength,
    openTime: entryBar.time,
    openIdx: entryBar.__idx,
    entry,
    slOrig: sl,
    sl,
    tp1, tp2, tp3,
    size,
    remaining: 1,
    partials: [],     // [{idx, price, time}]
    partialPct,       // [pct1, pct2, pct3]
    realized: 0,      // accumulated PnL
    fees: 0,          // accumulated trading fees
  };
}

/**
 * Apply post-TP1/TP2 stop-loss management based on configured beMode.
 *   'be'    (default) — SL → entry on TP1, → TP1 on TP2 (full breakeven lock)
 *   'small' — SL → entry - 0.25R on TP1, → entry on TP2 (partial lock)
 *   'none'  — SL stays at original until TP2, then → entry
 */
function applyBeMode(trade, idx, beMode) {
  const isLong = trade.dir === 'LONG';
  const r = Math.abs(trade.entry - trade.slOrig);
  if (beMode === 'none') {
    if (idx === 1) trade.sl = trade.entry;
  } else if (beMode === 'small') {
    if (idx === 0) trade.sl = isLong ? trade.entry - r * 0.25 : trade.entry + r * 0.25;
    else if (idx === 1) trade.sl = trade.entry;
  } else {
    if (idx === 0) trade.sl = trade.entry;
    else if (idx === 1) trade.sl = trade.tp1;
  }
}

/**
 * Step a single open trade through one bar. Returns { closed, exitReason }.
 * Mutates trade.realized, trade.remaining, trade.sl, trade.partials.
 * @param {string} beMode  'be' | 'small' | 'none' — see applyBeMode
 */
function stepTrade(trade, bar, beMode = 'be', feeBps = 0) {
  const isLong = trade.dir === 'LONG';
  const targets = [trade.tp1, trade.tp2, trade.tp3];
  const fee = feeBps / 10000;  // 10 bps = 0.1%

  // Conservative: check SL hit first (assume worst path within bar)
  const slHit = isLong ? bar.low <= trade.sl : bar.high >= trade.sl;
  if (slHit) {
    // Close all remaining at SL
    const dir = isLong ? 1 : -1;
    const pnl = (trade.sl - trade.entry) * trade.size * dir * trade.remaining;
    trade.realized += pnl;
    // Fees: entry leg (full size) was charged at open; here charge exit-leg (remaining * sl)
    if (feeBps > 0) {
      const feeAmt = trade.sl * trade.size * trade.remaining * fee;
      trade.realized -= feeAmt;
      trade.fees += feeAmt;
    }
    trade.remaining = 0;
    return {
      closed: true,
      exitReason: trade.partials.length ? `SL after TP${trade.partials.length}` : 'SL',
      exitPrice: trade.sl,
      exitTime: bar.time,
    };
  }

  // No SL hit — process TPs in order this bar
  for (let idx = 0; idx < 3; idx++) {
    if (trade.partials.find(p => p.idx === idx)) continue; // already filled
    const tp = targets[idx];
    const tpHit = isLong ? bar.high >= tp : bar.low <= tp;
    if (!tpHit) continue;

    const portion = trade.partialPct[idx];
    const dir = isLong ? 1 : -1;
    const pnl = (tp - trade.entry) * trade.size * dir * portion;
    trade.realized += pnl;
    // Fee on this exit leg
    if (feeBps > 0) {
      const feeAmt = tp * trade.size * portion * fee;
      trade.realized -= feeAmt;
      trade.fees += feeAmt;
    }
    trade.remaining = Math.max(0, trade.remaining - portion);
    trade.partials.push({ idx, price: tp, time: bar.time });

    // Variable R:R stop management
    applyBeMode(trade, idx, beMode);
  }

  if (trade.remaining <= 1e-9 || trade.partials.length === 3) {
    return {
      closed: true,
      exitReason: 'All TPs',
      exitPrice: trade.tp3,
      exitTime: bar.time,
    };
  }
  return { closed: false };
}

function closeAtMarket(trade, bar, feeBps = 0) {
  const dir = trade.dir === 'LONG' ? 1 : -1;
  const pnl = (bar.close - trade.entry) * trade.size * dir * trade.remaining;
  trade.realized += pnl;
  if (feeBps > 0) {
    const feeAmt = bar.close * trade.size * trade.remaining * (feeBps / 10000);
    trade.realized -= feeAmt;
    trade.fees += feeAmt;
  }
  trade.remaining = 0;
  return {
    closed: true,
    exitReason: 'EOD (forced close)',
    exitPrice: bar.close,
    exitTime: bar.time,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Main backtest runner
// ──────────────────────────────────────────────────────────────────────────

/**
 * @param {object} cfg
 *   candles            : LTF candles (chronological, ascending time)
 *   htf4h              : 4h candles (or null)
 *   htf1d              : 1d candles (or null)
 *   minScore           : minimum confluence score to take a trade (default 55 = medium+)
 *   riskPct            : % of equity to risk per trade (default 1)
 *   startEquity        : starting capital (default 10000)
 *   windowSize         : bars used for analysis at each step (default 300)
 *   partialPct         : array of 3 fractions summing to ~1.0 (default [0.25, 0.35, 0.40])
 *   maxBarsHeld        : max bars a trade can stay open (default 200)
 *   requireHtfAlign    : if true, only take trades aligned with the dominant HTF trend (default false)
 *   minRR              : minimum TP1 R:R required to enter (default 0 = disabled)
 *   beMode             : 'be' | 'small' | 'none' (default 'be')
 *   onProgress         : callback(0..1) for UI progress
 *   onLog              : callback(string) for status messages
 */
export async function runBacktest(cfg) {
  const {
    candles,
    htf4h = null,
    htf1d = null,
    minScore = 55,
    riskPct = 1,
    startEquity = 10000,
    windowSize = 300,
    partialPct = [0.25, 0.35, 0.40],
    maxBarsHeld = 200,
    requireHtfAlign = false,
    minRR = 0,
    beMode = 'be',
    feeBps = 0,           // round-trip fee in basis points (10 = 0.10%)
    onProgress = null,
    onLog = null,
  } = cfg;

  if (!candles || candles.length < windowSize + 50) {
    throw new Error('Not enough candles for backtest');
  }

  const log = (m) => onLog && onLog(m);
  log(`Pre-computing pivots over ${candles.length} bars…`);
  const allPivots = precomputeSwings(candles);

  log(`Pre-computing HTF analyses…`);
  const htf4hSeries = htf4h ? precomputeHTFAnalyses(htf4h, 200) : [];
  const htf1dSeries = htf1d ? precomputeHTFAnalyses(htf1d, 200) : [];

  log(`Walking forward through ${candles.length - windowSize} bars…`);

  const trades = [];
  const equityCurve = [];
  let equity = startEquity;
  let peak = startEquity;
  let maxDD = 0;
  let openTrade = null;
  let signalsConsidered = 0;
  let signalsTaken = 0;
  let signalsRejectedScore = 0;
  let signalsRejectedNeutral = 0;
  let signalsRejectedHtf = 0;
  let signalsRejectedRr = 0;

  for (let i = windowSize; i < candles.length - 1; i++) {
    const bar = candles[i];

    // 1) Manage open trade
    if (openTrade) {
      const res = stepTrade(openTrade, bar, beMode, feeBps);
      if (res.closed) {
        equity += openTrade.realized;
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak;
        if (dd > maxDD) maxDD = dd;
        trades.push({ ...openTrade, ...res });
        openTrade = null;
      } else {
        // Force close on time stop
        const heldBars = i - openTrade.openIdx;
        if (heldBars >= maxBarsHeld) {
          const forced = closeAtMarket(openTrade, bar, feeBps);
          equity += openTrade.realized;
          if (equity > peak) peak = equity;
          const dd = (peak - equity) / peak;
          if (dd > maxDD) maxDD = dd;
          trades.push({ ...openTrade, ...forced, exitReason: 'Time stop' });
          openTrade = null;
        }
      }
    }

    // 2) Generate signal at current bar (if no open trade)
    if (!openTrade) {
      const a = analyzeAtStep(candles, allPivots, i, windowSize);
      const t = bar.time;
      const mtf = [];
      const a4 = htfAt(htf4hSeries, t);
      const a1 = htfAt(htf1dSeries, t);
      if (a4) mtf.push(a4);
      if (a1) mtf.push(a1);
      const sig = generateSignal(a, mtf);
      signalsConsidered++;

      if (sig.direction === 'NEUTRAL') {
        signalsRejectedNeutral++;
      } else if (sig.score < minScore) {
        signalsRejectedScore++;
      } else if (requireHtfAlign && !htfAligned(sig, mtf)) {
        signalsRejectedHtf++;
      } else if (minRR > 0 && rrTp1(sig) < minRR) {
        signalsRejectedRr++;
      } else {
        // Open trade at NEXT bar's open
        const next = candles[i + 1];
        if (next) {
          next.__idx = i + 1;
          const trade = openTradeFromSignal(sig, next, equity, riskPct, partialPct, feeBps);
          if (trade) {
            // Charge entry fee (full size at entry price)
            if (feeBps > 0) {
              const feeAmt = trade.entry * trade.size * (feeBps / 10000);
              trade.realized -= feeAmt;
              trade.fees += feeAmt;
            }
            openTrade = trade;
            signalsTaken++;
          } else {
            // Trade was rejected by openTradeFromSignal sanity checks
            // (tight stop or fee-prohibitive). Count as RR rejection so the funnel
            // accurately reflects all rejections.
            signalsRejectedRr++;
          }
        }
      }
    }

    // 3) Track equity curve
    equityCurve.push({ time: bar.time, value: equity });

    // Yield to UI every 200 bars + progress
    if (i % 200 === 0) {
      if (onProgress) onProgress((i - windowSize) / (candles.length - windowSize));
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Close any still-open trade at last bar
  if (openTrade) {
    const last = candles[candles.length - 1];
    const forced = closeAtMarket(openTrade, last, feeBps);
    equity += openTrade.realized;
    trades.push({ ...openTrade, ...forced });
    openTrade = null;
  }

  if (onProgress) onProgress(1);

  return {
    trades,
    equityCurve,
    stats: computeStats(trades, equity, startEquity, maxDD,
      signalsConsidered, signalsTaken, signalsRejectedScore, signalsRejectedNeutral,
      signalsRejectedHtf, signalsRejectedRr),
    config: { minScore, riskPct, startEquity, windowSize, partialPct, maxBarsHeld, requireHtfAlign, minRR, beMode },
  };
}

/** True if signal direction agrees with the dominant HTF trend among provided HTFs. */
function htfAligned(sig, mtf) {
  if (!mtf || !mtf.length) return true;  // no HTF data → don't filter
  let bull = 0, bear = 0;
  for (const a of mtf) {
    if (a.structure?.trend === 'up')   bull++;
    if (a.structure?.trend === 'down') bear++;
  }
  if (bull === bear) return false;
  const htfDir = bull > bear ? 'LONG' : 'SHORT';
  return sig.direction === htfDir;
}

/** TP1 reward / risk ratio for a signal. */
function rrTp1(sig) {
  if (!sig.entry || !sig.sl || !sig.tp1) return 0;
  const risk = Math.abs(sig.entry - sig.sl);
  const reward = Math.abs(sig.tp1 - sig.entry);
  return risk > 0 ? reward / risk : 0;
}

// ──────────────────────────────────────────────────────────────────────────
// Statistics
// ──────────────────────────────────────────────────────────────────────────

function computeStats(trades, finalEquity, startEquity, maxDD, considered, taken, rejScore, rejNeutral, rejHtf = 0, rejRr = 0) {
  const n = trades.length;
  const wins = trades.filter(t => t.realized > 0);
  const losses = trades.filter(t => t.realized < 0);
  const breakeven = trades.filter(t => t.realized === 0);
  const grossProfit = wins.reduce((s, t) => s + t.realized, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.realized, 0));
  const netPnl = finalEquity - startEquity;
  const netPct = (netPnl / startEquity) * 100;
  const winRate = n ? wins.length / n : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0);
  const avgWin = wins.length ? grossProfit / wins.length : 0;
  const avgLoss = losses.length ? grossLoss / losses.length : 0;
  const avgRMultiple = n ? trades.reduce((s, t) => {
    const r = t.slOrig - t.entry;
    if (r === 0) return s;
    // R = realized / |entry - sl| / size
    const rDollar = Math.abs(t.entry - t.slOrig) * t.size; // 1R in $
    return rDollar > 0 ? s + (t.realized / rDollar) : s;
  }, 0) / n : 0;
  const expectancy = (winRate * avgWin) - ((1 - winRate) * avgLoss);

  // Hit rates
  const tp1Rate = n ? trades.filter(t => t.partials.length >= 1).length / n : 0;
  const tp2Rate = n ? trades.filter(t => t.partials.length >= 2).length / n : 0;
  const tp3Rate = n ? trades.filter(t => t.partials.length >= 3).length / n : 0;

  // By strength
  const byStrength = {};
  for (const s of ['low', 'medium', 'high']) {
    const sub = trades.filter(t => t.strength === s);
    if (!sub.length) { byStrength[s] = null; continue; }
    const w = sub.filter(t => t.realized > 0).length;
    const totPnl = sub.reduce((acc, t) => acc + t.realized, 0);
    byStrength[s] = {
      trades: sub.length,
      winRate: w / sub.length,
      pnl: totPnl,
      avgPnl: totPnl / sub.length,
    };
  }

  // By direction
  const longs = trades.filter(t => t.dir === 'LONG');
  const shorts = trades.filter(t => t.dir === 'SHORT');
  const dirStats = {
    long:  longs.length  ? { n: longs.length,  wr: longs.filter(t => t.realized > 0).length / longs.length,  pnl: longs.reduce((s,t)=>s+t.realized,0) }   : null,
    short: shorts.length ? { n: shorts.length, wr: shorts.filter(t => t.realized > 0).length / shorts.length, pnl: shorts.reduce((s,t)=>s+t.realized,0) } : null,
  };

  // Avg trade duration (in bars)
  const avgBars = n ? trades.reduce((s, t) => {
    const dur = t.exitTime ? Math.round((t.exitTime - t.openTime) / 60) : 0; // rough minutes
    return s + dur;
  }, 0) / n : 0;

  return {
    trades: n, wins: wins.length, losses: losses.length, breakeven: breakeven.length,
    winRate, profitFactor, expectancy,
    netPnl, netPct, finalEquity, startEquity,
    grossProfit, grossLoss,
    avgWin, avgLoss, avgRMultiple,
    maxDDPct: maxDD * 100,
    tp1Rate, tp2Rate, tp3Rate,
    byStrength, dirStats,
    signalsConsidered: considered, signalsTaken: taken,
    signalsRejectedScore: rejScore, signalsRejectedNeutral: rejNeutral,
    signalsRejectedHtf: rejHtf, signalsRejectedRr: rejRr,
    avgBarsHeldMin: avgBars,
  };
}
