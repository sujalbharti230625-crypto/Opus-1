// chart.js — lightweight-charts wrapper with overlays for analysis output.

const COLORS = {
  bg: '#0f1525',
  grid: '#1f2940',
  text: '#9aa3bc',
  bull: '#26d782',
  bear: '#ef4767',
  demand: 'rgba(38,215,130,0.15)',
  demandLine: 'rgba(38,215,130,0.6)',
  supply: 'rgba(239,71,103,0.15)',
  supplyLine: 'rgba(239,71,103,0.6)',
  fib: 'rgba(0,212,255,0.4)',
  liquidity: 'rgba(246,185,77,0.6)',
  swingHigh: '#ef4767',
  swingLow: '#26d782',
  entry: '#00d4ff',
  sl: '#ef4767',
  tp: '#26d782',
};

export class ChartView {
  constructor(container) {
    this.container = container;
    this.chart = LightweightCharts.createChart(container, {
      layout: { background: { color: COLORS.bg }, textColor: COLORS.text },
      grid:   { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      timeScale: { borderColor: COLORS.grid, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: COLORS.grid },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      autoSize: true,
    });

    this.candleSeries = this.chart.addCandlestickSeries({
      upColor: COLORS.bull,
      downColor: COLORS.bear,
      wickUpColor: COLORS.bull,
      wickDownColor: COLORS.bear,
      borderVisible: false,
    });
    this.volumeSeries = this.chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: '',
      scaleMargins: { top: 0.85, bottom: 0 },
      color: 'rgba(107,117,145,0.4)',
    });

    // Overlay registries (we recreate priceLines/markers each redraw)
    this._priceLines = [];
    this._markers = [];
    this._zoneSeries = [];
    this._toggles = { zones: true, liquidity: true, fib: true, swings: true, signal: true };
    // BUG FIX (B5): chart was created with `autoSize: true` so a manual
    // ResizeObserver calling applyOptions({}) is redundant and just adds
    // observer churn on resize. Removed.
  }

  setToggles(t) { this._toggles = { ...this._toggles, ...t }; }

  setData(candles) {
    this.candleSeries.setData(candles.map(c => ({
      time: c.time, open: c.open, high: c.high, low: c.low, close: c.close,
    })));
    this.volumeSeries.setData(candles.map(c => ({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,215,130,0.35)' : 'rgba(239,71,103,0.35)',
    })));
  }

  updateLast(c) {
    this.candleSeries.update({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });
    this.volumeSeries.update({
      time: c.time, value: c.volume,
      color: c.close >= c.open ? 'rgba(38,215,130,0.35)' : 'rgba(239,71,103,0.35)',
    });
  }

  clearOverlays() {
    for (const pl of this._priceLines) {
      try { this.candleSeries.removePriceLine(pl); } catch(_) {}
    }
    this._priceLines = [];
    this.candleSeries.setMarkers([]);
    this._markers = [];
  }

  /**
   * Apply analysis overlays + signal lines.
   */
  drawAnalysis(analysis, signal) {
    this.clearOverlays();
    const t = this._toggles;

    // Supply / demand zones (rendered as paired price lines using band-style colors)
    if (t.zones) {
      for (const z of analysis.zones.zones.slice(-6)) {
        const color = z.type === 'demand' ? COLORS.demandLine : COLORS.supplyLine;
        this._priceLines.push(this.candleSeries.createPriceLine({
          price: z.top, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false,
          title: z.type === 'demand' ? 'Demand ▲' : 'Supply ▼',
        }));
        this._priceLines.push(this.candleSeries.createPriceLine({
          price: z.bottom, color, lineWidth: 1, lineStyle: 2, axisLabelVisible: false,
          title: '',
        }));
      }
    }

    // Liquidity markers
    if (t.liquidity) {
      for (const b of analysis.liquidity.bsl.slice(0, 3)) {
        this._priceLines.push(this.candleSeries.createPriceLine({
          price: b.price, color: COLORS.liquidity, lineWidth: 1, lineStyle: 1,
          axisLabelVisible: true, title: 'BSL',
        }));
      }
      for (const s of analysis.liquidity.ssl.slice(0, 3)) {
        this._priceLines.push(this.candleSeries.createPriceLine({
          price: s.price, color: COLORS.liquidity, lineWidth: 1, lineStyle: 1,
          axisLabelVisible: true, title: 'SSL',
        }));
      }
    }

    // Fibonacci levels
    if (t.fib && analysis.fib) {
      const f = analysis.fib;
      const fibColor = COLORS.fib;
      for (const [r, p] of Object.entries(f.levels)) {
        this._priceLines.push(this.candleSeries.createPriceLine({
          price: p, color: fibColor, lineWidth: 1, lineStyle: 3,
          axisLabelVisible: true, title: `Fib ${r}`,
        }));
      }
    }

    // Swing markers
    const markers = [];
    if (t.swings) {
      const piv = analysis.swings.pivots.slice(-12);
      for (const p of piv) {
        markers.push({
          time: p.time,
          position: p.type === 'H' ? 'aboveBar' : 'belowBar',
          color: p.type === 'H' ? COLORS.swingHigh : COLORS.swingLow,
          shape: p.type === 'H' ? 'arrowDown' : 'arrowUp',
          text: p.type,
        });
      }
    }

    // Signal entry/SL/TP lines
    if (t.signal && signal && signal.direction !== 'NEUTRAL') {
      this._priceLines.push(this.candleSeries.createPriceLine({
        price: signal.entry, color: COLORS.entry, lineWidth: 2, lineStyle: 0,
        axisLabelVisible: true, title: `${signal.direction} entry`,
      }));
      this._priceLines.push(this.candleSeries.createPriceLine({
        price: signal.sl, color: COLORS.sl, lineWidth: 2, lineStyle: 0,
        axisLabelVisible: true, title: 'SL',
      }));
      [signal.tp1, signal.tp2, signal.tp3].forEach((tp, i) => {
        if (tp) this._priceLines.push(this.candleSeries.createPriceLine({
          price: tp, color: COLORS.tp, lineWidth: 1, lineStyle: 2,
          axisLabelVisible: true, title: `TP${i + 1}`,
        }));
      });
    }

    this.candleSeries.setMarkers(markers);
    this._markers = markers;
  }
}
