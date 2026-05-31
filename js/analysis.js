// analysis.js — Pure technical-analysis algorithms.
// Inputs: array of candles {time, open, high, low, close, volume}
// Outputs: structured analytical objects consumed by signals.js + UI.

// ──────────────────────────────────────────────────────────────────────────
// Generic helpers
// ──────────────────────────────────────────────────────────────────────────

export const fmt = (n, d = 2) => (n == null || isNaN(n) ? '—' : Number(n).toFixed(d));

const last = (arr, n = 1) => arr[arr.length - n];

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[j];
      prev = s / period;
      out[i] = prev;
    } else if (i >= period) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** Wilder RSI(14) */
export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) gain += ch; else loss -= ch;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** Wilder ATR(14) */
export function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const tr = new Array(candles.length).fill(0);
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < candles.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────────
// Swing detection (fractal pivots) — used by structure / fib / elliott / liquidity
// ──────────────────────────────────────────────────────────────────────────
/**
 * Find swing highs/lows using a left/right window.
 * @param {Array} candles
 * @param {number} left  bars to the left
 * @param {number} right bars to the right
 * @returns {{highs:Array<{i,time,price}>, lows:Array<{i,time,price}>, pivots:Array<{i,time,price,type}>}}
 */
export function findSwings(candles, left = 3, right = 3) {
  const highs = [], lows = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low  <= candles[i].low)  isLow  = false;
    }
    if (isHigh) highs.push({ i, time: candles[i].time, price: candles[i].high });
    if (isLow)  lows.push({ i, time: candles[i].time, price: candles[i].low });
  }
  // Merge into chronological pivot stream, type 'H' or 'L'
  const pivots = [];
  let hi = 0, li = 0;
  while (hi < highs.length || li < lows.length) {
    const h = highs[hi], l = lows[li];
    if (!h) { pivots.push({ ...l, type: 'L' }); li++; continue; }
    if (!l) { pivots.push({ ...h, type: 'H' }); hi++; continue; }
    if (h.i < l.i) { pivots.push({ ...h, type: 'H' }); hi++; }
    else            { pivots.push({ ...l, type: 'L' }); li++; }
  }
  // Alternate H/L by keeping the most extreme of consecutive same type
  const alt = [];
  for (const p of pivots) {
    if (alt.length && last(alt).type === p.type) {
      const prev = last(alt);
      if (p.type === 'H' && p.price > prev.price) alt[alt.length - 1] = p;
      if (p.type === 'L' && p.price < prev.price) alt[alt.length - 1] = p;
    } else alt.push(p);
  }
  return { highs, lows, pivots: alt };
}

// ──────────────────────────────────────────────────────────────────────────
// 1) Market Structure (BOS / CHoCH / Trend)
// BUG FIX (B2): now accepts pre-computed swings to avoid recomputing findSwings.
// Backward-compatible: if `swings` not given, computes them.
// ──────────────────────────────────────────────────────────────────────────
export function analyzeStructure(candles, swings) {
  const piv = (swings && swings.pivots) ? swings.pivots : findSwings(candles, 3, 3).pivots;
  const pivots = piv;
  if (pivots.length < 4) {
    return { trend: 'neutral', event: 'insufficient', lastSwingHigh: null, lastSwingLow: null, pivots };
  }

  // Walk pivots to detect BOS/CHoCH
  let trend = 'neutral';      // 'up' | 'down' | 'neutral'
  let lastEvent = 'init';
  let lastH = null, lastL = null;       // running last swing high/low
  let prevH = null, prevL = null;

  for (const p of pivots) {
    if (p.type === 'H') {
      if (lastH != null) prevH = lastH;
      lastH = p;
      // Bullish BOS if higher high in uptrend, or CHoCH from down to up if breaks last lower-high
      if (prevH && p.price > prevH.price) {
        if (trend === 'down')      { trend = 'up';   lastEvent = 'CHoCH ↑'; }
        else if (trend === 'up')   { lastEvent = 'BOS ↑'; }
        else                        { trend = 'up';   lastEvent = 'BOS ↑'; }
      }
    } else {
      if (lastL != null) prevL = lastL;
      lastL = p;
      if (prevL && p.price < prevL.price) {
        if (trend === 'up')        { trend = 'down'; lastEvent = 'CHoCH ↓'; }
        else if (trend === 'down') { lastEvent = 'BOS ↓'; }
        else                        { trend = 'down'; lastEvent = 'BOS ↓'; }
      }
    }
  }

  return {
    trend,                    // up | down | neutral
    event: lastEvent,
    lastSwingHigh: lastH,
    lastSwingLow:  lastL,
    pivots,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 2) Supply & Demand Zones
// Detect base candle(s) preceding a strong impulsive move.
// Demand = base before bullish impulse; Supply = base before bearish impulse.
// ──────────────────────────────────────────────────────────────────────────
export function analyzeZones(candles, atrSeries) {
  const zones = [];
  const len = candles.length;
  for (let i = 5; i < len - 1; i++) {
    const a = atrSeries[i];
    if (!a) continue;
    const c = candles[i];
    const range = c.high - c.low;
    const body = Math.abs(c.close - c.open);
    // Strong impulse: body > 1.5 * ATR and body/range > 0.6
    if (body > 1.5 * a && body / range > 0.6) {
      const dir = c.close > c.open ? 'bull' : 'bear';
      // Base candle = i-1 (or last small candle before)
      const baseIdx = i - 1;
      const base = candles[baseIdx];
      if (!base) continue;
      const baseBody = Math.abs(base.close - base.open);
      const baseRange = base.high - base.low;
      if (baseRange === 0) continue;
      // Base must be relatively small
      if (baseBody / baseRange < 0.6 && baseRange < a * 1.2) {
        zones.push({
          type: dir === 'bull' ? 'demand' : 'supply',
          top: base.high,
          bottom: base.low,
          time: base.time,
          createdAt: c.time,
          impulseIdx: i,
          mitigated: false,
        });
      }
    }
  }
  // Mark mitigated zones (price returned and broke through)
  for (const z of zones) {
    for (let j = z.impulseIdx + 1; j < len; j++) {
      const k = candles[j];
      if (z.type === 'demand' && k.close < z.bottom) { z.mitigated = true; break; }
      if (z.type === 'supply' && k.close > z.top)    { z.mitigated = true; break; }
    }
  }
  // Keep most recent ~6 unmitigated zones
  const fresh = zones.filter(z => !z.mitigated).slice(-12);
  const price = last(candles).close;
  const demand = fresh.filter(z => z.type === 'demand' && z.top  <= price * 1.005).sort((a,b)=>b.top-a.top);
  const supply = fresh.filter(z => z.type === 'supply' && z.bottom >= price * 0.995).sort((a,b)=>a.bottom-b.bottom);
  // Active zone if price currently inside
  let active = null;
  for (const z of fresh) {
    if (price >= z.bottom && price <= z.top) { active = z; break; }
  }
  return {
    zones: fresh,
    nearestDemand: demand[0] || null,
    nearestSupply: supply[0] || null,
    active,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 3) Liquidity (equal highs / equal lows, BSL / SSL)
// ──────────────────────────────────────────────────────────────────────────
export function analyzeLiquidity(candles, swings) {
  const tol = 0.0015; // 0.15% tolerance for "equal"
  const eqHighs = [], eqLows = [];
  const highs = swings.highs.slice(-30);
  const lows  = swings.lows.slice(-30);

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const a = highs[i].price, b = highs[j].price;
      if (Math.abs(a - b) / a <= tol) {
        eqHighs.push({ price: (a + b) / 2, count: 2, t1: highs[i].time, t2: highs[j].time });
      }
    }
  }
  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const a = lows[i].price, b = lows[j].price;
      if (Math.abs(a - b) / a <= tol) {
        eqLows.push({ price: (a + b) / 2, count: 2, t1: lows[i].time, t2: lows[j].time });
      }
    }
  }

  const price = last(candles).close;
  // Buy-side liquidity = swing highs above price (target for upside sweep)
  const bsl = highs.filter(h => h.price > price).sort((a,b)=>a.price-b.price);
  const ssl = lows.filter(l => l.price < price).sort((a,b)=>b.price-a.price);

  return {
    bsl: bsl.slice(0, 5),     // nearest 5 above
    ssl: ssl.slice(0, 5),     // nearest 5 below
    eqHighs: eqHighs.slice(-5),
    eqLows: eqLows.slice(-5),
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 4) Candle & Structural Momentum
// ──────────────────────────────────────────────────────────────────────────
export function detectCandlePattern(candles) {
  const n = candles.length;
  if (n < 3) return { pattern: 'n/a', strength: 0, bias: 'neutral' };
  const c0 = candles[n - 1], c1 = candles[n - 2], c2 = candles[n - 3];
  const body0 = Math.abs(c0.close - c0.open);
  const range0 = c0.high - c0.low || 1e-9;
  const body1 = Math.abs(c1.close - c1.open);
  const upper0 = c0.high - Math.max(c0.open, c0.close);
  const lower0 = Math.min(c0.open, c0.close) - c0.low;

  // Bullish engulfing
  if (c1.close < c1.open && c0.close > c0.open && c0.close > c1.open && c0.open < c1.close) {
    return { pattern: 'Bullish Engulfing', strength: 0.8, bias: 'bull' };
  }
  // Bearish engulfing
  if (c1.close > c1.open && c0.close < c0.open && c0.open > c1.close && c0.close < c1.open) {
    return { pattern: 'Bearish Engulfing', strength: 0.8, bias: 'bear' };
  }
  // Hammer (bull pin)
  if (lower0 > body0 * 2 && upper0 < body0 * 0.7 && c0.close >= c0.open) {
    return { pattern: 'Hammer / Bull Pin', strength: 0.7, bias: 'bull' };
  }
  // Shooting star (bear pin)
  if (upper0 > body0 * 2 && lower0 < body0 * 0.7 && c0.close <= c0.open) {
    return { pattern: 'Shooting Star', strength: 0.7, bias: 'bear' };
  }
  // Morning star
  if (c2.close < c2.open && body1 / (c1.high - c1.low + 1e-9) < 0.4 && c0.close > c0.open && c0.close > (c2.open + c2.close)/2) {
    return { pattern: 'Morning Star', strength: 0.85, bias: 'bull' };
  }
  // Evening star
  if (c2.close > c2.open && body1 / (c1.high - c1.low + 1e-9) < 0.4 && c0.close < c0.open && c0.close < (c2.open + c2.close)/2) {
    return { pattern: 'Evening Star', strength: 0.85, bias: 'bear' };
  }
  // Strong impulse candle
  const ratio = body0 / range0;
  if (ratio > 0.75 && body0 > body1 * 1.2) {
    return {
      pattern: c0.close > c0.open ? 'Strong Bullish Impulse' : 'Strong Bearish Impulse',
      strength: Math.min(1, ratio),
      bias: c0.close > c0.open ? 'bull' : 'bear',
    };
  }
  // Doji
  if (ratio < 0.15) return { pattern: 'Doji', strength: 0.2, bias: 'neutral' };
  return {
    pattern: c0.close > c0.open ? 'Bull Candle' : 'Bear Candle',
    strength: ratio,
    bias: c0.close > c0.open ? 'bull' : 'bear',
  };
}

export function analyzeMomentum(candles, atrSeriesIn) {
  const closes = candles.map(c => c.close);
  const rsiArr = rsi(closes, 14);
  // BUG FIX (B4): reuse pre-computed ATR if provided.
  const atrArr = atrSeriesIn || atr(candles, 14);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const lastRsi = last(rsiArr);
  const lastAtr = last(atrArr);
  const e20 = last(ema20), e50 = last(ema50);

  const pattern = detectCandlePattern(candles);
  const c0 = last(candles);
  // BUG FIX (B8): clamp bodyRange to [0,1]. A degenerate candle with
  // high == low (rare but possible on stale ticks) would otherwise produce
  // an absurd ratio displayed as "9999%" in the UI.
  const bodyRange = Math.min(1,
    Math.abs(c0.close - c0.open) / Math.max(1e-9, c0.high - c0.low));

  // Structural momentum: EMA stack alignment
  let structural = 'neutral';
  if (e20 != null && e50 != null) {
    if (c0.close > e20 && e20 > e50) structural = 'bull';
    else if (c0.close < e20 && e20 < e50) structural = 'bear';
  }

  return {
    rsi: lastRsi,
    atr: lastAtr,
    ema20: e20, ema50: e50,
    pattern: pattern.pattern,
    candleBias: pattern.bias,
    candleStrength: pattern.strength,
    bodyRange,
    structural,
    rsiSeries: rsiArr,
    atrSeries: atrArr,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 5) Fibonacci levels — from last *significant* swing
// BUG FIX (B3): instead of blindly using last 2 pivots (which produces
// noisy levels on tiny micro-swings), walk pivots backward until we find
// an alternating pair whose price range is at least `minATRMult` × ATR.
// Falls back to last 2 pivots if no significant swing exists.
// ──────────────────────────────────────────────────────────────────────────
export function analyzeFibonacci(candles, swings, atrSeries) {
  const piv = swings.pivots;
  if (piv.length < 2) return null;
  const lastAtr = atrSeries ? atrSeries[atrSeries.length - 1] : null;
  const refPrice = candles[candles.length - 1].close;
  const atrVal = lastAtr || refPrice * 0.01;
  const minRange = atrVal * 5;

  let a = null, b = null;
  outer:
  for (let i = piv.length - 1; i > 0; i--) {
    for (let j = i - 1; j >= 0 && i - j <= 6; j--) {
      const pa = piv[j], pb = piv[i];
      if (pa.type === pb.type) continue;
      if (Math.abs(pb.price - pa.price) >= minRange) {
        a = pa; b = pb;
        break outer;
      }
    }
  }
  if (!a || !b) {
    a = piv[piv.length - 2];
    b = piv[piv.length - 1];
  }

  const direction = b.type === 'H' ? 'up' : 'down'; // last move direction
  const high = direction === 'up' ? b.price : a.price;
  const low  = direction === 'up' ? a.price : b.price;
  const range = high - low;
  if (range <= 0) return null;
  const lvl = (r) => direction === 'up' ? high - range * r : low + range * r;
  const ext = (r) => direction === 'up' ? high + range * (r - 1) : low - range * (r - 1);

  return {
    direction,
    swingHigh: high, swingLow: low,
    levels: {
      '0.236': lvl(0.236),
      '0.382': lvl(0.382),
      '0.5':   lvl(0.5),
      '0.618': lvl(0.618),
      '0.786': lvl(0.786),
    },
    extensions: {
      '1.272': ext(1.272),
      '1.618': ext(1.618),
      '2.0':   ext(2.0),
      '2.618': ext(2.618),
    },
    goldenPocket: { from: lvl(0.618), to: lvl(0.65) },
    aTime: a.time, bTime: b.time,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 6) Elliott Wave (simplified) — looks for 5-wave impulse using last 6 pivots
// ──────────────────────────────────────────────────────────────────────────
export function analyzeElliott(swings) {
  const p = swings.pivots;
  if (p.length < 6) return { pattern: 'insufficient', count: 0, valid: false, phase: '—' };
  const last6 = p.slice(-6);
  // Need alternating H/L, starting with L for bull impulse or H for bear
  const types = last6.map(x => x.type).join('');
  const bullImpulse = types === 'LHLHLH'; // 0=L,1=H(W1),2=L(W2),3=H(W3),4=L(W4),5=H(W5)
  const bearImpulse = types === 'HLHLHL';

  if (!bullImpulse && !bearImpulse) {
    // Try last 4 for ABC correction
    const last4 = p.slice(-4);
    const t4 = last4.map(x=>x.type).join('');
    if (t4 === 'HLHL' || t4 === 'LHLH') {
      return { pattern: 'ABC Correction', count: 3, valid: true, phase: t4.startsWith('H') ? 'corrective ↓' : 'corrective ↑' };
    }
    return { pattern: 'Unclear', count: 0, valid: false, phase: '—' };
  }

  const [w0, w1, w2, w3, w4, w5] = last6;
  const dir = bullImpulse ? 1 : -1;
  const len = (a, b) => Math.abs(b.price - a.price);
  const L1 = len(w0, w1);
  const L3 = len(w2, w3);
  const L5 = len(w4, w5);
  // Rules:
  // 1. Wave 2 cannot retrace > 100% of wave 1
  const w2OK = bullImpulse ? w2.price > w0.price : w2.price < w0.price;
  // 2. Wave 3 must not be the shortest among 1,3,5
  const w3OK = L3 >= L1 && L3 >= L5 && L3 > L1 * 1.0;
  // 3. Wave 4 must not enter wave 1 territory
  const w4OK = bullImpulse ? w4.price > w1.price : w4.price < w1.price;
  const valid = w2OK && w3OK && w4OK;

  return {
    pattern: bullImpulse ? '5-Wave Impulse ↑' : '5-Wave Impulse ↓',
    count: 5,
    valid,
    phase: valid ? (bullImpulse ? 'completing W5 ↑' : 'completing W5 ↓') : 'invalidated',
    waves: { w0, w1, w2, w3, w4, w5 },
    direction: dir,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// 7) Wyckoff Phase Detection
// Simplified: detect range, identify phase via volume + spring/upthrust events.
// ──────────────────────────────────────────────────────────────────────────
export function analyzeWyckoff(candles, atrSeries) {
  const N = candles.length;
  if (N < 60) return { phase: 'unclear', range: null, event: '—', volBias: '—' };
  const lookback = 60;
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows  = recent.map(c => c.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow  = Math.min(...lows);
  const rangeMid  = (rangeHigh + rangeLow) / 2;
  const rangeWidth = rangeHigh - rangeLow;
  const a = atrSeries[N - 1];
  if (!a) return { phase: 'unclear', range: null, event: '—', volBias: '—' };

  // Determine if we're in a sideways range: width should be only modestly larger than ATR
  const isRange = rangeWidth < a * 12;
  // Trend before range: compare first vs last close of preceding window
  const pre = candles.slice(-lookback - 30, -lookback);
  const preTrend = pre.length > 5 ? (last(pre).close - pre[0].close) : 0;

  // Volume: recent up-vol vs down-vol
  let upVol = 0, dnVol = 0;
  for (const c of recent) {
    if (c.close > c.open) upVol += c.volume;
    else if (c.close < c.open) dnVol += c.volume;
  }
  const volBias = upVol > dnVol * 1.1 ? 'bullish' : dnVol > upVol * 1.1 ? 'bearish' : 'balanced';

  // Spring: wick below rangeLow, close back inside (in last 5 candles)
  let event = '—';
  for (let i = N - 5; i < N; i++) {
    const c = candles[i];
    if (c.low < rangeLow * 0.999 && c.close > rangeLow) event = 'Spring (bullish)';
    if (c.high > rangeHigh * 1.001 && c.close < rangeHigh) event = 'Upthrust (bearish)';
  }

  // Phase classification
  let phase = 'unclear';
  if (!isRange) {
    phase = preTrend > 0 ? 'markup ↑' : 'markdown ↓';
  } else {
    if (preTrend < 0 && volBias !== 'bearish') phase = 'accumulation';
    else if (preTrend > 0 && volBias !== 'bullish') phase = 'distribution';
    else phase = preTrend < 0 ? 'accumulation' : 'distribution';
  }

  return {
    phase,
    range: { high: rangeHigh, low: rangeLow, mid: rangeMid, width: rangeWidth },
    event,
    volBias,
    upVol, dnVol,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// One-shot full analysis runner for a single timeframe.
// Computes shared building blocks (ATR, swings) ONCE and threads them
// through downstream analyzers — fixes the duplicate-work bugs (B2, B4).
// ──────────────────────────────────────────────────────────────────────────
export function runFullAnalysis(candles) {
  const atrSeries = atr(candles, 14);
  const swings = findSwings(candles, 3, 3);
  const structure = analyzeStructure(candles, swings);
  const zones = analyzeZones(candles, atrSeries);
  const liquidity = analyzeLiquidity(candles, swings);
  const momentum = analyzeMomentum(candles, atrSeries);
  const fib = analyzeFibonacci(candles, swings, atrSeries);
  const elliott = analyzeElliott(swings);
  const wyckoff = analyzeWyckoff(candles, atrSeries);
  return {
    candles,
    swings,
    structure,
    zones,
    liquidity,
    momentum,
    fib,
    elliott,
    wyckoff,
    price: last(candles).close,
  };
}
