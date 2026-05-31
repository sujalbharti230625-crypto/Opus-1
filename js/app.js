// app.js — Main controller, wires data + analysis + signals to the UI.
import { fetchKlines, subscribeKline, subscribeTicker, TF_MAP } from './data.js';
import { runFullAnalysis, fmt } from './analysis.js';
import { generateSignal } from './signals.js';
import { ChartView } from './chart.js';

const SYMBOL = 'ETHUSDT';
const TIMEFRAMES = ['15m', '1h', '4h', '1d'];

// State
const state = {
  tf: '1h',
  candles: {},          // tf -> candles array
  analysis: {},         // tf -> analysis bundle
  signal: null,
  disposers: { kline: null, ticker: null },
  signalLog: [],
  lastSignalKey: null,
};

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
const chartEl = document.getElementById('chart');
const chart = new ChartView(chartEl);

function setConn(ok, msg) {
  const dot = document.getElementById('connDot');
  const txt = document.getElementById('connText');
  dot.className = 'w-2 h-2 rounded-full ' + (ok ? 'conn-on' : 'conn-off');
  txt.textContent = msg || (ok ? 'live' : 'disconnected');
}

async function loadAllTimeframes() {
  setConn(false, 'loading…');
  // BUG FIX (B6): tolerate partial failure - one TF blip shouldn't kill the whole boot.
  const results = await Promise.allSettled(TIMEFRAMES.map(async tf => {
    state.candles[tf] = await fetchKlines(SYMBOL, TF_MAP[tf], 500);
    state.analysis[tf] = runFullAnalysis(state.candles[tf]);
    return tf;
  }));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  const failed = results
    .map((r, i) => r.status === 'rejected' ? TIMEFRAMES[i] : null)
    .filter(Boolean);
  if (ok === 0) throw new Error('All timeframes failed to load');
  if (failed.length) console.warn('Some TFs failed (will retry on background refresh):', failed);
  setConn(true, failed.length ? `live (${ok}/${TIMEFRAMES.length} TF)` : 'live');
}

function activeTfData() {
  return { candles: state.candles[state.tf], analysis: state.analysis[state.tf] };
}

// ──────────────────────────────────────────────────────────────────────────
// UI helpers
// ──────────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function setBadge(el, text, kind = '') {
  el.textContent = text;
  el.className = 'badge' + (kind ? ' ' + kind : '');
}

function renderHeaderPrice(price, changePct) {
  $('priceValue').textContent = '$' + fmt(price, 2);
  const el = $('priceChange');
  el.textContent = (changePct >= 0 ? '+' : '') + fmt(changePct, 2) + '%';
  el.className = 'text-xs font-medium px-2 py-0.5 rounded ' +
    (changePct >= 0 ? 'bg-bull/15 text-bull' : 'bg-bear/15 text-bear');
}

function renderAnalysis(a) {
  // Market structure
  const ms = a.structure;
  $('ms-trendLabel').textContent = ms.trend.toUpperCase();
  $('ms-event').textContent = ms.event;
  $('ms-shigh').textContent = ms.lastSwingHigh ? fmt(ms.lastSwingHigh.price) : '—';
  $('ms-slow').textContent  = ms.lastSwingLow  ? fmt(ms.lastSwingLow.price)  : '—';
  setBadge($('ms-trend'), ms.trend, ms.trend === 'up' ? 'bull' : ms.trend === 'down' ? 'bear' : '');

  // Supply/Demand
  const z = a.zones;
  $('sd-demand').textContent = z.nearestDemand ? `${fmt(z.nearestDemand.bottom)} – ${fmt(z.nearestDemand.top)}` : '—';
  $('sd-supply').textContent = z.nearestSupply ? `${fmt(z.nearestSupply.bottom)} – ${fmt(z.nearestSupply.top)}` : '—';
  $('sd-active').textContent = z.active ? `${z.active.type.toUpperCase()} @ ${fmt(z.active.bottom)}–${fmt(z.active.top)}` : 'none';
  setBadge($('sd-count'), z.zones.length + ' zones', 'info');

  // Liquidity
  const lq = a.liquidity;
  $('lq-bsl').textContent = lq.bsl[0] ? fmt(lq.bsl[0].price) : '—';
  $('lq-ssl').textContent = lq.ssl[0] ? fmt(lq.ssl[0].price) : '—';
  $('lq-eq').textContent  = `${lq.eqHighs.length} EQH / ${lq.eqLows.length} EQL`;
  setBadge($('lq-count'), (lq.bsl.length + lq.ssl.length) + ' levels', 'warn');

  // Momentum
  const m = a.momentum;
  $('mo-pattern').textContent = m.pattern;
  $('mo-br').textContent = (m.bodyRange * 100).toFixed(1) + '%';
  $('mo-rsi').textContent = m.rsi != null ? m.rsi.toFixed(1) : '—';
  $('mo-atr').textContent = m.atr != null ? fmt(m.atr, 2) : '—';
  setBadge($('mo-strength'), m.candleBias,
    m.candleBias === 'bull' ? 'bull' : m.candleBias === 'bear' ? 'bear' : '');

  // Fibonacci
  if (a.fib) {
    $('fib-swing').textContent = `${fmt(a.fib.swingLow)} → ${fmt(a.fib.swingHigh)}`;
    $('fib-gp').textContent = `${fmt(Math.min(a.fib.goldenPocket.from, a.fib.goldenPocket.to))} – ${fmt(Math.max(a.fib.goldenPocket.from, a.fib.goldenPocket.to))}`;
    $('fib-50').textContent = fmt(a.fib.levels['0.5']);
    $('fib-ext').textContent = fmt(a.fib.extensions['1.618']);
    setBadge($('fib-dir'), a.fib.direction, a.fib.direction === 'up' ? 'bull' : 'bear');
  } else {
    ['fib-swing','fib-gp','fib-50','fib-ext'].forEach(id => $(id).textContent = '—');
    setBadge($('fib-dir'), '—');
  }

  // Elliott
  const e = a.elliott;
  $('ew-pattern').textContent = e.pattern;
  $('ew-count').textContent = e.count + (e.count ? ' waves' : '');
  $('ew-valid').textContent = e.valid ? 'valid' : 'invalid';
  setBadge($('ew-phase'), e.phase, e.valid ? 'info' : '');

  // Wyckoff
  const w = a.wyckoff;
  $('wy-phaseLabel').textContent = w.phase;
  $('wy-range').textContent = w.range ? `${fmt(w.range.low)} – ${fmt(w.range.high)}` : '—';
  $('wy-vol').textContent = w.volBias;
  $('wy-event').textContent = w.event;
  setBadge($('wy-phase'), w.phase,
    w.phase.includes('accumulation') || w.phase.includes('markup') ? 'bull' :
    w.phase.includes('distribution') || w.phase.includes('markdown') ? 'bear' : '');
}

function renderSignal(s) {
  const dirEl = $('sig-dir');
  dirEl.textContent = s.direction;
  dirEl.className = 'text-2xl font-bold ' + (
    s.direction === 'LONG' ? 'dir-long' :
    s.direction === 'SHORT' ? 'dir-short' : 'dir-neutral'
  );

  $('sig-entry').textContent = s.entry ? '$' + fmt(s.entry) : '—';
  $('sig-sl').textContent    = s.sl    ? '$' + fmt(s.sl)    : '—';
  $('sig-tp1').textContent   = s.tp1   ? '$' + fmt(s.tp1)   : '—';
  $('sig-tp2').textContent   = s.tp2   ? '$' + fmt(s.tp2)   : '—';
  $('sig-tp3').textContent   = s.tp3   ? '$' + fmt(s.tp3)   : '—';
  $('sig-rr').textContent    = s.rr    ? '1 : ' + s.rr.toFixed(2) : '—';

  $('sig-bar').style.width = s.score + '%';
  $('sig-score').textContent = s.score;

  setBadge($('sig-strength'), s.strength,
    s.strength === 'high' ? 'bull' : s.strength === 'medium' ? 'info' :
    s.strength === 'low' ? 'warn' : '');

  // Reasons
  const ul = $('sig-reasons');
  ul.innerHTML = '';
  for (const r of s.reasons.filter(r => r.ok).slice(0, 10)) {
    const li = document.createElement('li');
    li.textContent = r.txt;
    li.className = 'text-text/90';
    ul.appendChild(li);
  }
}

function renderMTF() {
  const tbody = $('mtfBody');
  tbody.innerHTML = '';
  let bullN = 0, bearN = 0;
  for (const tf of TIMEFRAMES) {
    const a = state.analysis[tf];
    if (!a) continue;
    const trend = a.structure.trend;
    const bias = trend === 'up' ? 'bull' : trend === 'down' ? 'bear' : 'neutral';
    if (bias === 'bull') bullN++; else if (bias === 'bear') bearN++;
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${tf}</td>
      <td class="${bias === 'bull' ? 'text-bull' : bias === 'bear' ? 'text-bear' : 'text-muted'}">${trend}</td>
      <td class="${a.momentum.candleBias === 'bull' ? 'text-bull' : a.momentum.candleBias === 'bear' ? 'text-bear' : 'text-muted'}">${a.momentum.candleBias}</td>
      <td class="text-muted">${a.wyckoff.phase}</td>
      <td class="text-right ${bias === 'bull' ? 'text-bull' : bias === 'bear' ? 'text-bear' : 'text-muted'}">${bias.toUpperCase()}</td>
    `;
    tbody.appendChild(tr);
  }
  const overall = bullN > bearN ? 'BULLISH' : bearN > bullN ? 'BEARISH' : 'MIXED';
  const el = $('mtf-bias');
  el.textContent = overall;
  el.className = 'text-xs px-2 py-1 rounded ' +
    (overall === 'BULLISH' ? 'bg-bull/15 text-bull' :
     overall === 'BEARISH' ? 'bg-bear/15 text-bear' : 'bg-panel2 text-muted');
}

function logSignal(s) {
  // Only log when direction or strength meaningfully changes
  const key = `${s.direction}|${s.strength}|${s.entry?.toFixed(0)}`;
  if (key === state.lastSignalKey || s.direction === 'NEUTRAL') return;
  state.lastSignalKey = key;
  state.signalLog.unshift({
    ts: new Date(),
    tf: state.tf,
    dir: s.direction,
    entry: s.entry, sl: s.sl, tp1: s.tp1,
    score: s.score, strength: s.strength,
  });
  state.signalLog = state.signalLog.slice(0, 30);
  renderLog();
}

function renderLog() {
  const el = $('signalLog');
  if (!state.signalLog.length) {
    el.innerHTML = '<div class="p-3 text-muted">No signals yet.</div>';
    return;
  }
  el.innerHTML = state.signalLog.map(s => `
    <div class="p-3 flex items-center justify-between">
      <div>
        <div class="font-semibold ${s.dir === 'LONG' ? 'text-bull' : 'text-bear'}">${s.dir} <span class="text-muted text-[10px] ml-1">${s.tf}</span></div>
        <div class="text-muted text-[11px]">${s.ts.toLocaleTimeString()}</div>
      </div>
      <div class="text-right font-mono">
        <div>E ${fmt(s.entry)}</div>
        <div class="text-bear">SL ${fmt(s.sl)}</div>
        <div class="text-bull">TP ${fmt(s.tp1)}</div>
      </div>
      <div class="text-right">
        <div class="text-xs px-2 py-1 rounded bg-panel2">${s.strength}</div>
        <div class="text-muted text-[10px] mt-1">${s.score}/100</div>
      </div>
    </div>
  `).join('');
}

// ──────────────────────────────────────────────────────────────────────────
// Main render cycle
// ──────────────────────────────────────────────────────────────────────────
function buildSignal() {
  const primary = state.analysis[state.tf];
  if (!primary) return null;
  // Use higher TFs as MTF context
  const idx = TIMEFRAMES.indexOf(state.tf);
  const higher = TIMEFRAMES.slice(idx + 1).map(tf => state.analysis[tf]).filter(Boolean);
  return generateSignal(primary, higher);
}

function fullRender() {
  const a = state.analysis[state.tf];
  if (!a) return;
  chart.setData(state.candles[state.tf]);
  renderAnalysis(a);
  state.signal = buildSignal();
  if (state.signal) {
    renderSignal(state.signal);
    chart.drawAnalysis(a, state.signal);
    logSignal(state.signal);
  }
  renderMTF();
}

// ──────────────────────────────────────────────────────────────────────────
// WebSocket subscription for active TF
// ──────────────────────────────────────────────────────────────────────────
function subscribeActive() {
  // Dispose existing
  if (state.disposers.kline) state.disposers.kline();

  state.disposers.kline = subscribeKline(SYMBOL, TF_MAP[state.tf], (candle, isClosed) => {
    const arr = state.candles[state.tf];
    if (!arr || !arr.length) return;
    const lastC = arr[arr.length - 1];
    if (candle.time > lastC.time) {
      arr.push(candle);
      if (arr.length > 1000) arr.shift();
    } else {
      arr[arr.length - 1] = candle;
    }
    chart.updateLast(candle);
    if (isClosed) {
      // Re-run analysis on candle close (cheap enough for 500 candles)
      state.analysis[state.tf] = runFullAnalysis(state.candles[state.tf]);
      renderAnalysis(state.analysis[state.tf]);
      state.signal = buildSignal();
      if (state.signal) {
        renderSignal(state.signal);
        chart.drawAnalysis(state.analysis[state.tf], state.signal);
        logSignal(state.signal);
      }
      renderMTF();
    }
  }, (s) => setConn(s === 'open', s === 'open' ? 'live' : 'reconnecting…'));
}

function subscribePrice() {
  if (state.disposers.ticker) state.disposers.ticker();
  state.disposers.ticker = subscribeTicker(SYMBOL, (t) => {
    const change = t.open ? ((t.price - t.open) / t.open) * 100 : 0;
    renderHeaderPrice(t.price, change);
  }, (s) => setConn(s === 'open', s === 'open' ? 'live' : 'reconnecting…'));
}

// Periodically refresh higher-TF analysis even when idle (every 60s).
// BUG FIX (B7): guard against races - if user switches TF mid-fetch, the
// completing fetch could overwrite the now-active TF's live-updated data.
// We capture state.tf BEFORE await and recheck AFTER to detect a switch.
setInterval(async () => {
  for (const tf of TIMEFRAMES) {
    const activeBefore = state.tf;
    if (tf === activeBefore) continue;       // skip currently-active TF (live WS handles it)
    try {
      const fresh = await fetchKlines(SYMBOL, TF_MAP[tf], 500);
      // Re-check: did the user switch TO this tf while we were fetching?
      // If so, the WS now owns this TF's data — don't clobber it.
      if (tf === state.tf) continue;
      state.candles[tf] = fresh;
      state.analysis[tf] = runFullAnalysis(fresh);
    } catch (_) { /* ignore transient network errors */ }
  }
  renderMTF();
  state.signal = buildSignal();
  if (state.signal) {
    renderSignal(state.signal);
    logSignal(state.signal);
  }
}, 60_000);

// ──────────────────────────────────────────────────────────────────────────
// Event wiring
// ──────────────────────────────────────────────────────────────────────────
document.querySelectorAll('#tfTabs .tf-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#tfTabs .tf-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.tf = btn.dataset.tf;
    fullRender();
    subscribeActive();
  });
});

['zones', 'liquidity', 'fib', 'swings', 'signal'].forEach(name => {
  const el = document.getElementById('tg-' + name);
  el.addEventListener('change', () => {
    chart.setToggles({ [name]: el.checked });
    if (state.analysis[state.tf]) chart.drawAnalysis(state.analysis[state.tf], state.signal);
  });
});

document.getElementById('clearLog').addEventListener('click', () => {
  state.signalLog = [];
  renderLog();
});

// ──────────────────────────────────────────────────────────────────────────
// Boot
// ──────────────────────────────────────────────────────────────────────────
(async function main() {
  try {
    await loadAllTimeframes();
    fullRender();
    subscribeActive();
    subscribePrice();
  } catch (e) {
    setConn(false, 'error');
    console.error(e);
    // BUG FIX (B13): make banner dismissable so transient errors don't pin the UI forever.
    const banner = document.createElement('div');
    banner.className = 'fixed bottom-4 right-4 bg-bear/20 border border-bear text-bear text-xs px-3 py-2 rounded flex items-center gap-3 max-w-md z-50';
    banner.innerHTML = '<span></span><button class="text-bear/70 hover:text-bear font-bold text-base leading-none" aria-label="dismiss">×</button>';
    banner.querySelector('span').textContent = 'Failed to load market data: ' + e.message + '. Will keep retrying via background refresh.';
    banner.querySelector('button').addEventListener('click', () => banner.remove());
    document.body.appendChild(banner);
  }
})();
