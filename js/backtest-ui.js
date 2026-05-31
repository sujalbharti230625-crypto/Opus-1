// backtest-ui.js — UI controller for backtest.html
import { fetchHistoricalKlines, TF_MAP, TF_MIN } from './data.js';
import { runBacktest } from './backtest.js';

const SYMBOL = 'ETHUSDT';

// Lookback in days
const LOOKBACK_DAYS = { '6m': 183, '1y': 365, '2y': 730 };

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (n == null || isNaN(n) || !isFinite(n)) ? '—' : Number(n).toFixed(d);
const fmtUSD = (n) => (n == null || isNaN(n) || !isFinite(n)) ? '—' : '$' + n.toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtPct = (n) => (n == null || isNaN(n) || !isFinite(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(2) + '%';

let eqChart = null;
let eqSeries = null;
let lastResult = null;

function setProgress(p, txt) {
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = (p * 100).toFixed(1) + '%';
  if (txt) $('progressText').textContent = txt;
}

function showCardColor(elId, val) {
  const el = $(elId);
  // BUG FIX (B11): also remove all leftover state classes before applying new one
  el.classList.remove('text-bull', 'text-bear', 'text-text', 'text-warn');
  if (val == null || isNaN(val)) { el.classList.add('text-text'); return; }
  el.classList.add(val > 0 ? 'text-bull' : val < 0 ? 'text-bear' : 'text-text');
}

// BUG FIX (B12): reset all stat cards before a new run so a failed/aborted run
// doesn't leave stale numbers from a previous run.
function resetStatCards() {
  const ids = [
    's-netpnl', 's-winrate', 's-pf', 's-dd', 's-trades', 's-avgr',
    's-equity', 's-exp', 's-fees', 's-grossPnl', 's-avgScore', 's-avgBars',
    'hit-tp1', 'hit-tp2', 'hit-tp3', 'dir-long', 'dir-short',
    'str-low', 'str-medium', 'str-high',
    'f-considered', 'f-rejN', 'f-rejS', 'f-taken',
  ];
  for (const id of ids) {
    const el = $(id);
    if (!el) continue;
    el.textContent = '—';
    el.classList.remove('text-bull', 'text-bear', 'text-warn');
  }
  $('tradesBody').innerHTML = '';
  $('tradeCount').textContent = '—';
  $('eqRange').textContent = '—';
}

function renderSummary(stats, trades) {
  $('s-netpnl').textContent = fmtUSD(stats.netPnl) + ' (' + fmtPct(stats.netPct) + ')';
  showCardColor('s-netpnl', stats.netPnl);
  $('s-winrate').textContent = (stats.winRate * 100).toFixed(1) + '%';
  $('s-pf').textContent = isFinite(stats.profitFactor) ? stats.profitFactor.toFixed(2) : '∞';
  $('s-dd').textContent  = '-' + stats.maxDDPct.toFixed(2) + '%';
  showCardColor('s-dd', -stats.maxDDPct);  // always bear since DD ≥ 0 → -DD ≤ 0
  $('s-trades').textContent = stats.trades;
  $('s-avgr').textContent = stats.avgRMultiple.toFixed(2) + 'R';
  showCardColor('s-avgr', stats.avgRMultiple);
  $('s-equity').textContent = fmtUSD(stats.finalEquity);
  $('s-exp').textContent = fmtUSD(stats.expectancy);
  showCardColor('s-exp', stats.expectancy);

  // Fees, gross P&L, avg score, avg bars held
  const totalFees = trades.reduce((s, t) => s + (t.fees || 0), 0);
  $('s-fees').textContent = fmtUSD(totalFees);
  showCardColor('s-fees', -totalFees);  // fees always bear-colored
  const grossPnl = stats.netPnl + totalFees;
  $('s-grossPnl').textContent = fmtUSD(grossPnl);
  showCardColor('s-grossPnl', grossPnl);
  const avgScore = trades.length ? trades.reduce((s, t) => s + (t.score || 0), 0) / trades.length : 0;
  $('s-avgScore').textContent = avgScore.toFixed(1);
  const days = stats.avgBarsHeldMin / (60 * 24);
  $('s-avgBars').textContent = trades.length === 0 ? '—' :
    days >= 1 ? days.toFixed(1) + 'd' : (days * 24).toFixed(1) + 'h';

  $('hit-tp1').textContent = (stats.tp1Rate * 100).toFixed(1) + '%';
  $('hit-tp2').textContent = (stats.tp2Rate * 100).toFixed(1) + '%';
  $('hit-tp3').textContent = (stats.tp3Rate * 100).toFixed(1) + '%';

  const dl = stats.dirStats.long;
  $('dir-long').textContent  = dl  ? `${dl.n} / ${(dl.wr*100).toFixed(0)}% / ${fmtUSD(dl.pnl)}`   : '—';
  const ds = stats.dirStats.short;
  $('dir-short').textContent = ds ? `${ds.n} / ${(ds.wr*100).toFixed(0)}% / ${fmtUSD(ds.pnl)}` : '—';

  for (const s of ['low', 'medium', 'high']) {
    const b = stats.byStrength[s];
    $('str-' + s).textContent = b ? `${b.trades} trades · ${(b.winRate*100).toFixed(0)}% wr · ${fmtUSD(b.pnl)}` : '—';
  }

  $('f-considered').textContent = stats.signalsConsidered.toLocaleString();
  $('f-rejN').textContent = stats.signalsRejectedNeutral.toLocaleString();
  $('f-rejS').textContent = stats.signalsRejectedScore.toLocaleString();
  $('f-taken').textContent = stats.signalsTaken.toLocaleString();
}

function renderEquityCurve(equityCurve) {
  if (!eqChart) {
    eqChart = LightweightCharts.createChart($('eqChart'), {
      layout: { background: { color: '#0f1525' }, textColor: '#9aa3bc' },
      grid: { vertLines: { color: '#1f2940' }, horzLines: { color: '#1f2940' } },
      timeScale: { borderColor: '#1f2940', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#1f2940' },
      autoSize: true,
    });
    eqSeries = eqChart.addAreaSeries({
      lineColor: '#00d4ff',
      topColor: 'rgba(0,212,255,0.4)',
      bottomColor: 'rgba(0,212,255,0.0)',
      lineWidth: 2,
    });
  }
  // Down-sample if too many points (chart smoothness)
  const data = equityCurve.length > 4000
    ? equityCurve.filter((_, i) => i % Math.ceil(equityCurve.length / 4000) === 0)
    : equityCurve;
  eqSeries.setData(data);
  eqChart.timeScale().fitContent();

  if (equityCurve.length) {
    const start = new Date(equityCurve[0].time * 1000).toISOString().slice(0, 10);
    const end = new Date(equityCurve[equityCurve.length - 1].time * 1000).toISOString().slice(0, 10);
    $('eqRange').textContent = `${start}  →  ${end}`;
  }
}

function renderTrades(trades, filter = 'all') {
  let list = trades.slice();
  if (filter === 'win') list = list.filter(t => t.realized > 0);
  else if (filter === 'loss') list = list.filter(t => t.realized < 0);
  else if (filter === 'long') list = list.filter(t => t.dir === 'LONG');
  else if (filter === 'short') list = list.filter(t => t.dir === 'SHORT');

  $('tradeCount').textContent = list.length + ' / ' + trades.length;

  const tbody = $('tradesBody');
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="11" class="p-6 text-center text-muted">No trades match the filter.</td></tr>';
    return;
  }

  // BUG FIX (B10): preserve absolute trade indices when capping/filtering.
  // Previously the row # restarted at 1 for every filter, making the same
  // trade appear as different numbers — confusing and misleading.
  const indexed = list.map((t, i) => ({ t, absIdx: trades.indexOf(t) }));
  const capped = indexed.slice(-500);

  tbody.innerHTML = capped.map(({ t, absIdx }) => {
    const dollarRisk = Math.abs(t.entry - t.slOrig) * t.size;
    const r = dollarRisk > 0 ? t.realized / dollarRisk : 0;
    const dt = new Date(t.openTime * 1000).toISOString().slice(5, 16).replace('T', ' ');
    const tps = `${fmt(t.tp1)} / ${fmt(t.tp2)} / ${fmt(t.tp3)}`;
    const cls = t.realized > 0 ? 'win-row' : t.realized < 0 ? 'loss-row' : '';
    return `<tr class="${cls}">
      <td class="text-muted">${absIdx + 1}</td>
      <td>${dt}</td>
      <td class="${t.dir === 'LONG' ? 'text-bull' : 'text-bear'}">${t.dir}</td>
      <td class="text-right">${fmt(t.entry)}</td>
      <td class="text-right text-bear">${fmt(t.slOrig)}</td>
      <td class="text-right">${tps}</td>
      <td class="text-right">${fmt(t.exitPrice)}</td>
      <td class="text-muted">${t.exitReason || '—'}</td>
      <td>${t.strength}</td>
      <td class="text-right">${(t.realized >= 0 ? '+' : '') + t.realized.toFixed(2)}</td>
      <td class="text-right">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</td>
    </tr>`;
  }).join('');
}

function readConfig() {
  return {
    lookback: $('cfg-lookback').value,
    tf:       $('cfg-tf').value,
    minScore: parseInt($('cfg-minScore').value, 10),
    riskPct:  parseFloat($('cfg-risk').value),
    equity:   parseFloat($('cfg-equity').value),
    p1: parseFloat($('cfg-p1').value),
    p2: parseFloat($('cfg-p2').value),
    p3: parseFloat($('cfg-p3').value),
    feeBps:   parseInt($('cfg-fees').value, 10),
    htfAlign: $('cfg-htfAlign').checked,
    minRR:    $('cfg-minRR').checked ? 1.0 : 0,
    beMode:   $('cfg-beMode').value,
  };
}

async function run() {
  const cfg = readConfig();
  const days = LOOKBACK_DAYS[cfg.lookback];
  const tfMin = TF_MIN[cfg.tf];
  const totalBars = Math.ceil(days * 24 * 60 / tfMin);

  // Validate partials
  const partialSum = cfg.p1 + cfg.p2 + cfg.p3;
  if (Math.abs(partialSum - 100) > 0.5) {
    alert('Partial exits must sum to 100% (currently ' + partialSum + '%)');
    return;
  }

  $('runBtn').disabled = true;
  $('runBtn').textContent = 'Running…';
  resetStatCards();   // BUG FIX (B12): clear stale stats from previous run
  setProgress(0, 'Fetching ' + cfg.lookback + ' of ' + cfg.tf + ' candles (' + totalBars + ' bars)…');

  try {
    const candles = await fetchHistoricalKlines(SYMBOL, TF_MAP[cfg.tf], totalBars,
      (p) => setProgress(p * 0.3, `Fetching ${cfg.tf} candles… ${(p * 100).toFixed(0)}%`));

    setProgress(0.3, 'Fetching higher-timeframe context…');
    const htf4h = cfg.tf === '1h' || cfg.tf === '15m'
      ? await fetchHistoricalKlines(SYMBOL, '4h', Math.ceil(days * 24 / 4))
      : null;
    const htf1d = cfg.tf !== '1d'
      ? await fetchHistoricalKlines(SYMBOL, '1d', days)
      : null;

    setProgress(0.4, 'Running simulation…');
    const result = await runBacktest({
      candles,
      htf4h, htf1d,
      minScore: cfg.minScore,
      riskPct: cfg.riskPct,
      startEquity: cfg.equity,
      partialPct: [cfg.p1 / 100, cfg.p2 / 100, cfg.p3 / 100],
      requireHtfAlign: cfg.htfAlign,
      minRR: cfg.minRR,
      beMode: cfg.beMode,
      feeBps: cfg.feeBps,
      onProgress: (p) => setProgress(0.4 + p * 0.6, `Simulating… ${(p * 100).toFixed(0)}%`),
      onLog: (m) => setProgress(parseFloat($('progressBar').style.width) / 100, m),
    });

    lastResult = result;
    setProgress(1, `Done · ${result.trades.length} trades`);
    renderSummary(result.stats, result.trades);
    renderEquityCurve(result.equityCurve);
    renderTrades(result.trades, $('tradeFilter').value);
    setTimeout(() => $('progressWrap').classList.add('hidden'), 1200);
  } catch (e) {
    console.error(e);
    setProgress(0, 'Error: ' + e.message);
    alert('Backtest failed: ' + e.message);
  } finally {
    $('runBtn').disabled = false;
    $('runBtn').textContent = 'Run Backtest';
  }
}

$('runBtn').addEventListener('click', run);
$('tradeFilter').addEventListener('change', () => {
  if (lastResult) renderTrades(lastResult.trades, $('tradeFilter').value);
});
