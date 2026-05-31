// data.js — Binance public market data (REST + WebSocket)
// No API key required for public endpoints.

const REST = 'https://api.binance.com';
const WSS  = 'wss://stream.binance.com:9443/ws';

// Map UI timeframe -> Binance interval
export const TF_MAP = {
  '15m': '15m',
  '1h':  '1h',
  '4h':  '4h',
  '1d':  '1d',
};

// Map TF -> minutes (used for resampling math, ATR scaling, etc.)
export const TF_MIN = { '15m': 15, '1h': 60, '4h': 240, '1d': 1440 };

const parseKline = (k) => ({
  time:   Math.floor(k[0] / 1000),  // seconds (lightweight-charts expects seconds)
  open:   parseFloat(k[1]),
  high:   parseFloat(k[2]),
  low:    parseFloat(k[3]),
  close:  parseFloat(k[4]),
  volume: parseFloat(k[5]),
});

/**
 * Fetch a single batch of historical klines (max 1000).
 */
export async function fetchKlines(symbol, interval, limit = 500) {
  const url = `${REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance REST error ${res.status}`);
  return (await res.json()).map(parseKline);
}

/**
 * Fetch a long history of klines by paginating backward via endTime.
 * @param {string} symbol     e.g. ETHUSDT
 * @param {string} interval   Binance interval (15m,1h,4h,1d)
 * @param {number} totalBars  desired number of candles (most recent N)
 * @param {(p:number)=>void}  onProgress  optional progress 0..1
 */
export async function fetchHistoricalKlines(symbol, interval, totalBars, onProgress) {
  const all = [];
  let endTime = Date.now();
  const pageSize = 1000;
  let safetyMax = 100; // hard upper-bound on requests

  while (all.length < totalBars && safetyMax-- > 0) {
    const limit = Math.min(pageSize, totalBars - all.length);
    const url = `${REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}&endTime=${endTime}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance REST error ${res.status}`);
    const raw = await res.json();
    if (!raw.length) break;

    const chunk = raw.map(parseKline);
    // Prepend (older) so final array is chronological ascending
    all.unshift(...chunk);
    // Step back: next page must end before this chunk's first openTime
    endTime = raw[0][0] - 1;
    if (onProgress) onProgress(Math.min(1, all.length / totalBars));
    // gentle pacing to avoid weight saturation
    await new Promise(r => setTimeout(r, 60));
    // Stop if we got less than asked (no more history)
    if (chunk.length < limit) break;
  }

  // Dedupe by openTime in case of overlap, sort ascending
  const seen = new Set();
  const dedup = [];
  for (const c of all) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    dedup.push(c);
  }
  dedup.sort((a, b) => a.time - b.time);
  return dedup;
}

/**
 * Fetch 24h ticker (price + change %).
 */
export async function fetch24hTicker(symbol) {
  const res = await fetch(`${REST}/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error('ticker error');
  const t = await res.json();
  return {
    price: parseFloat(t.lastPrice),
    changePct: parseFloat(t.priceChangePercent),
    high: parseFloat(t.highPrice),
    low: parseFloat(t.lowPrice),
    volume: parseFloat(t.volume),
  };
}

/**
 * Subscribe to a kline websocket stream.
 * BUG FIX (B1): onStatus is now its own argument, not a property guess on onCandle.
 *
 * @param {string} symbol e.g. ethusdt (lowercase)
 * @param {string} interval
 * @param {(c, isClosed)=>void} onCandle callback receives current (live or closed) candle
 * @param {(s:'open'|'close'|'error')=>void} onStatus  optional status callback
 * @returns {() => void} disposer
 */
export function subscribeKline(symbol, interval, onCandle, onStatus) {
  let ws;
  let alive = true;
  let reconnectTimer = null;

  const connect = () => {
    const stream = `${symbol.toLowerCase()}@kline_${interval}`;
    ws = new WebSocket(`${WSS}/${stream}`);

    ws.onopen = () => onStatus && onStatus('open');
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        const k = m.k;
        if (!k) return;
        onCandle({
          time:   Math.floor(k.t / 1000),
          open:   parseFloat(k.o),
          high:   parseFloat(k.h),
          low:    parseFloat(k.l),
          close:  parseFloat(k.c),
          volume: parseFloat(k.v),
        }, !!k.x);
      } catch (e) { /* ignore */ }
    };
    ws.onclose = () => {
      onStatus && onStatus('close');
      if (alive) reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => {
      onStatus && onStatus('error');
      try { ws.close(); } catch (_) {}
    };
  };
  connect();

  return () => {
    alive = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch (_) {}
  };
}

/**
 * Subscribe to live mini-ticker for the symbol (price every second).
 */
export function subscribeTicker(symbol, onTick, onStatus) {
  let ws;
  let alive = true;
  let reconnectTimer = null;

  const connect = () => {
    ws = new WebSocket(`${WSS}/${symbol.toLowerCase()}@miniTicker`);
    ws.onopen = () => onStatus && onStatus('open');
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(ev.data);
        onTick({
          price: parseFloat(m.c),
          open:  parseFloat(m.o),
          high:  parseFloat(m.h),
          low:   parseFloat(m.l),
          volume: parseFloat(m.v),
        });
      } catch (_) {}
    };
    ws.onclose = () => {
      onStatus && onStatus('close');
      if (alive) reconnectTimer = setTimeout(connect, 2000);
    };
    ws.onerror = () => { try { ws.close(); } catch (_) {} };
  };
  connect();

  return () => {
    alive = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try { ws && ws.close(); } catch (_) {}
  };
}
