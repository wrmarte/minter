// services/adrianChart.js
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

let CanvasLib = null;
try {
  CanvasLib = require('@napi-rs/canvas');
} catch (e) {
  try { CanvasLib = require('canvas'); } catch {}
}

const { createCanvas } = CanvasLib || {};
const GlobalFonts = CanvasLib?.GlobalFonts;

// ---- FONT REGISTRATION (CRITICAL FOR RAILWAY) ----
const FONT_FAMILY = (process.env.ADRIAN_CHART_FONT_FAMILY || 'DejaVu Sans').trim();

// User can set ADRIAN_CHART_FONT_PATH to something like: "fonts/DejaVuSans.ttf"
const FONT_PATH_ENV = (process.env.ADRIAN_CHART_FONT_PATH || '').trim();

function resolveFontPath(p) {
  if (!p) return null;

  // absolute
  if (path.isAbsolute(p)) return p;

  // relative to project root (/app on Railway)
  // process.cwd() in Railway typically is /app
  return path.join(process.cwd(), p);
}

function firstExistingPath(paths) {
  for (const p of paths) {
    try {
      if (!p) continue;
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function tryRegisterFontOnce() {
  try {
    if (!GlobalFonts) {
      console.warn('⚠️ adrianChart: Canvas GlobalFonts not available. Text may not render if no system fonts exist.');
      return false;
    }

    const candidates = [];

    // 1) env override (supports "fonts/..." or absolute)
    const envResolved = resolveFontPath(FONT_PATH_ENV);
    if (envResolved) candidates.push(envResolved);

    // 2) common repo layouts
    candidates.push(path.join(process.cwd(), 'fonts', 'DejaVuSans.ttf'));          // /app/fonts/DejaVuSans.ttf
    candidates.push(path.join(process.cwd(), 'assets', 'fonts', 'DejaVuSans.ttf'));// /app/assets/fonts/DejaVuSans.ttf
    candidates.push(path.join(__dirname, '..', 'fonts', 'DejaVuSans.ttf'));        // relative from /services
    candidates.push(path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSans.ttf'));

    // 3) common Linux system paths (in case you don't bundle)
    candidates.push('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf');
    candidates.push('/usr/share/fonts/dejavu/DejaVuSans.ttf');
    candidates.push('/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf');
    candidates.push('/usr/share/fonts/noto/NotoSans-Regular.ttf');

    const picked = firstExistingPath(candidates);

    if (!picked) {
      console.warn(`⚠️ adrianChart: font file missing. Tried:\n - ${candidates.join('\n - ')}\nText may not render on Railway.`);
      return false;
    }

    const ok = GlobalFonts.registerFromPath(picked, FONT_FAMILY);
    if (ok) {
      console.log(`✅ adrianChart: registered font "${FONT_FAMILY}" from ${picked}`);
      return true;
    }

    console.warn(`⚠️ adrianChart: GlobalFonts.registerFromPath returned false for ${picked}`);
    return false;
  } catch (e) {
    console.warn(`⚠️ adrianChart: font register failed: ${e?.message || e}`);
    return false;
  }
}

// register once at load
tryRegisterFontOnce();

// ---- ENV DEFAULTS ----
const ADRIAN_GT_NETWORK = (process.env.ADRIAN_GT_NETWORK || 'base').trim().toLowerCase();
const ADRIAN_GT_POOL_ID = (process.env.ADRIAN_GT_POOL_ID ||
  '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
).trim().toLowerCase();

const DEFAULT_POINTS = Math.max(20, Math.min(240, Number(process.env.ADRIAN_CHART_POINTS || 96)));
const CANDLE_AGG_MIN = Math.max(1, Math.min(240, Number(process.env.ADRIAN_CANDLE_AGG_MIN || 15)));
const SHOW_VOLUME = String(process.env.ADRIAN_CANDLE_SHOW_VOLUME || '1').trim() === '1';

const CHART_W = Math.max(800, Math.min(2000, Number(process.env.ADRIAN_CANDLE_W || 1200)));
const CHART_H = Math.max(450, Math.min(1200, Number(process.env.ADRIAN_CANDLE_H || 650)));

// Theme
const BG = '#0c0c0c';
const GRID = 'rgba(255,255,255,0.10)';
const TEXT = '#f2f2f2';
const MUTED = '#d0d0d0';
const BLUE = 'rgba(0,140,255,0.95)';
const BLUE_FILL = 'rgba(0,140,255,0.55)';
const RED = 'rgba(255,0,0,0.78)';
const RED_FILL = 'rgba(255,0,0,0.45)';

// ----------------- Helpers -----------------
function safeJsonParse(t) { try { return JSON.parse(t); } catch { return null; } }
function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
function fmtUsd(n, d = 6) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  return `$${x.toFixed(d)}`;
}
function fmtVol(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 'N/A';
  if (x >= 1e9) return `${(x / 1e9).toFixed(2)}B`;
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(2)}K`;
  return x.toFixed(2);
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 15000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (hasAbort) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: controller.signal });
      const bodyText = await res.text();
      return { res, bodyText };
    } finally {
      clearTimeout(timer);
    }
  } else {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const bodyText = await res.text();
        return { res, bodyText };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
}

function _findArrayOfArrays(obj) {
  const seen = new Set();
  const stack = [{ v: obj, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 7) continue;

    if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length >= 5) return v;
    for (const k of Object.keys(v)) stack.push({ v: v[k], d: d + 1 });
  }
  return null;
}

async function fetchOhlcvList({ points, aggMin }) {
  const base = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`;

  const candidates = [
    `${base}/ohlcv/minute?aggregate=${aggMin}&limit=${points}`,
    `${base}/ohlcv/day?aggregate=${aggMin}&limit=${points}`,
    `${base}/ohlcv/hour?aggregate=1&limit=${Math.min(points, 168)}`,
    `${base}/ohlcv?timeframe=minute&aggregate=${aggMin}&limit=${points}`,
    `${base}/ohlcv?timeframe=day&aggregate=${aggMin}&limit=${points}`,
    `${base}/ohlcv?timeframe=hour&aggregate=1&limit=${Math.min(points, 168)}`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      const { res, bodyText } = await fetchWithTimeout(url, {}, 14000);
      if (!res.ok) { lastErr = new Error(`GT HTTP ${res.status}: ${bodyText?.slice(0, 120)}`); continue; }

      const json = safeJsonParse(bodyText);
      if (!json) { lastErr = new Error('GT non-json response'); continue; }

      const list =
        json?.data?.attributes?.ohlcv_list ||
        json?.data?.attributes?.ohlcvList ||
        json?.data?.ohlcv_list ||
        json?.ohlcv_list ||
        null;

      if (Array.isArray(list) && list.length) return list;

      const maybe = _findArrayOfArrays(json);
      if (maybe?.length) return maybe;

      lastErr = new Error('GT response had no ohlcv_list');
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Unable to fetch OHLCV list from GeckoTerminal');
}

function normalizeOhlcv(list, limit) {
  const out = [];
  for (const row of (list || []).slice(0, limit)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    let ts = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = row.length >= 6 ? Number(row[5]) : null;

    if (!Number.isFinite(ts) || !Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
    ts = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;

    out.push({ t: ts, o, h, l, c, v: Number.isFinite(v) ? v : null });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

function computeMeta(candles) {
  const n = candles.length;
  if (n < 5) throw new Error('Not enough candle points');

  const first = candles[0];
  const last = candles[n - 1];
  const lastPrice = last.c;
  const deltaPct = ((last.c - first.c) / (first.c || 1)) * 100;

  let hi = -Infinity;
  let lo = Infinity;
  let volSum = 0;

  for (const c of candles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    if (Number.isFinite(c.v)) volSum += c.v;
  }

  if (!Number.isFinite(hi)) hi = lastPrice;
  if (!Number.isFinite(lo)) lo = lastPrice;

  return {
    last: lastPrice,
    lastPrice,
    deltaPct,
    hi,
    high: hi,
    lo,
    low: lo,
    volSum,
    volumeSum: volSum,
    startTs: first.t,
    endTs: last.t,
    points: n,
    poolWeb: `https://www.geckoterminal.com/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`,
    poolApi: `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(ADRIAN_GT_POOL_ID)}`
  };
}

function setFont(ctx, weight, sizePx) {
  ctx.font = `${weight} ${sizePx}px "${FONT_FAMILY}", sans-serif`;
}

function renderCandlesPng(candles, meta) {
  if (!createCanvas) throw new Error('Canvas library not available (install @napi-rs/canvas)');

  const canvas = createCanvas(CHART_W, CHART_H);
  const ctx = canvas.getContext('2d');

  const padL = 78;
  const padR = 78;
  const padT = 58;
  const padB = SHOW_VOLUME ? 110 : 82;

  const plotW = CHART_W - padL - padR;
  const plotH = CHART_H - padT - padB;

  const volH = SHOW_VOLUME ? Math.floor(plotH * 0.22) : 0;
  const priceH = plotH - volH - (SHOW_VOLUME ? 16 : 0);

  const priceTop = padT;
  const priceBot = padT + priceH;

  const volTop = SHOW_VOLUME ? (priceBot + 16) : 0;
  const volBot = SHOW_VOLUME ? (padT + plotH) : 0;

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, CHART_W, CHART_H);

  // Title + subtitle
  ctx.fillStyle = TEXT;
  setFont(ctx, '700', 20);
  ctx.textAlign = 'left';
  ctx.fillText('🕶️ $ADRIAN Candles — 3D Mode', padL, 30);

  const subtitle = `${ADRIAN_GT_NETWORK} • ${candles.length} candles • Δ ${meta.deltaPct >= 0 ? '+' : ''}${meta.deltaPct.toFixed(2)}%`;
  ctx.fillStyle = MUTED;
  setFont(ctx, '600', 13);
  ctx.fillText(subtitle, padL, 50);

  // Legend
  setFont(ctx, '700', 13);
  ctx.fillStyle = BLUE;
  ctx.fillText('🟦 up / bought', padL + 430, 50);
  ctx.fillStyle = RED;
  ctx.fillText('🟥 down / sold', padL + 560, 50);
  ctx.fillStyle = MUTED;
  setFont(ctx, '600', 13);
  ctx.fillText('• overlay: 🟥 offset + 🟦 main', padL + 700, 50);

  // Price scale
  const hi = Number(meta.hi);
  const lo = Number(meta.lo);
  const pad = (hi - lo) * 0.04 || (hi * 0.02) || 0.0000001;
  const yMax = hi + pad;
  const yMin = Math.max(0, lo - pad);

  const yFor = (price) => {
    const p = Number(price);
    const t = (p - yMin) / (yMax - yMin || 1);
    return priceBot - t * (priceH || 1);
  };

  // Grid + Y labels (left + right)
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;

  const yTicks = 6;
  for (let i = 0; i <= yTicks; i++) {
    const yy = priceTop + (priceH * i) / yTicks;

    ctx.beginPath();
    ctx.moveTo(padL, yy);
    ctx.lineTo(padL + plotW, yy);
    ctx.stroke();

    const p = yMax - ((yMax - yMin) * i) / yTicks;
    const label = p >= 1 ? p.toFixed(4) : p.toFixed(8);

    ctx.fillStyle = MUTED;
    setFont(ctx, '700', 12);

    ctx.textAlign = 'left';
    ctx.fillText(`$${label}`, 10, yy + 4);

    ctx.textAlign = 'right';
    ctx.fillText(`$${label}`, CHART_W - 10, yy + 4);
  }
  ctx.textAlign = 'left';

  // X axis + candles geometry
  const n = candles.length;
  const stepX = plotW / Math.max(1, n);
  const candleW = clamp(stepX * 0.7, 3, 16);

  const xFor = (idx) => padL + idx * stepX + stepX / 2;

  // Vertical grid + time labels
  const xTicks = 6;
  setFont(ctx, '700', 12);
  ctx.fillStyle = MUTED;

  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.round((n - 1) * (i / xTicks));
    const c = candles[idx];
    const d = new Date(c.t * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const label = `${hh}:${mm}`;
    const xx = xFor(idx);

    ctx.strokeStyle = GRID;
    ctx.beginPath();
    ctx.moveTo(xx, priceTop);
    ctx.lineTo(xx, priceBot);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(xx, priceBot);
    ctx.lineTo(xx, priceBot + 6);
    ctx.stroke();

    const labelY = SHOW_VOLUME ? (volBot + 24) : (priceBot + 28);
    ctx.textAlign = 'center';
    ctx.fillText(label, xx, labelY);
  }
  ctx.textAlign = 'left';

  // Candles
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const xx = xFor(i);
    const yO = yFor(c.o);
    const yC = yFor(c.c);
    const yH = yFor(c.h);
    const yL = yFor(c.l);

    const up = c.c >= c.o;
    const wickColor = up ? BLUE : RED;
    const bodyColor = up ? BLUE_FILL : RED_FILL;
    const bodyStroke = up ? BLUE : RED;

    // wick
    ctx.strokeStyle = wickColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xx, yH);
    ctx.lineTo(xx, yL);
    ctx.stroke();

    // body
    const top = Math.min(yO, yC);
    const bot = Math.max(yO, yC);
    const hBody = Math.max(2, bot - top);

    ctx.fillStyle = bodyColor;
    ctx.fillRect(xx - candleW / 2, top, candleW, hBody);

    ctx.strokeStyle = bodyStroke;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(xx - candleW / 2, top, candleW, hBody);
  }

  // Volume bars
  if (SHOW_VOLUME) {
    ctx.strokeStyle = GRID;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, volTop);
    ctx.lineTo(padL + plotW, volTop);
    ctx.stroke();

    const maxV = candles.reduce((m, c) => Math.max(m, Number.isFinite(c.v) ? c.v : 0), 0) || 1;
    const vFor = (v) => volBot - ((v || 0) / maxV) * volH;

    ctx.fillStyle = MUTED;
    setFont(ctx, '700', 12);
    ctx.textAlign = 'left';
    ctx.fillText('Volume', padL, volTop - 6);

    for (let i = 0; i < n; i++) {
      const c = candles[i];
      const v = Number.isFinite(c.v) ? c.v : 0;
      const xx = xFor(i);
      const yy = vFor(v);
      const up = c.c >= c.o;
      ctx.fillStyle = up ? 'rgba(0,140,255,0.35)' : 'rgba(255,0,0,0.25)';
      ctx.fillRect(xx - candleW / 2, yy, candleW, volBot - yy);
    }

    ctx.fillStyle = MUTED;
    setFont(ctx, '700', 12);
    ctx.textAlign = 'right';
    ctx.fillText(fmtVol(maxV), CHART_W - 10, volTop + 12);
    ctx.textAlign = 'left';
  }

  // 3D overlay close line
  const drawLine = (offX, offY, stroke, width) => {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const xx = xFor(i) + offX;
      const yy = yFor(candles[i].c) + offY;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    }
    ctx.stroke();
  };
  drawLine(2, 2, 'rgba(255,0,0,0.55)', 3.5);
  drawLine(0, 0, 'rgba(0,140,255,0.95)', 3.5);

  // Footer
  ctx.fillStyle = MUTED;
  setFont(ctx, '700', 12);
  ctx.textAlign = 'left';

  const lastStr = fmtUsd(meta.last, meta.last >= 1 ? 4 : 8);
  const hiStr = fmtUsd(meta.hi, meta.hi >= 1 ? 4 : 8);
  const loStr = fmtUsd(meta.lo, meta.lo >= 1 ? 4 : 8);
  const volStr = fmtVol(meta.volSum);
  const dStr = `${meta.deltaPct >= 0 ? '+' : ''}${meta.deltaPct.toFixed(2)}%`;

  ctx.fillText(
    `Last ${lastStr} • Δ ${dStr} • Hi ${hiStr} • Lo ${loStr} • Vol ${volStr}`,
    padL,
    CHART_H - 18
  );

  return canvas.toBuffer('image/png');
}

// ----------------- Public API -----------------
async function getAdrianChartUrl(opts = {}) {
  const points = Math.max(20, Math.min(240, Number(opts.points || DEFAULT_POINTS)));
  const aggMin = Math.max(1, Math.min(240, Number(opts.aggMin || CANDLE_AGG_MIN)));

  const list = await fetchOhlcvList({ points, aggMin });
  const candles = normalizeOhlcv(list, points);
  const meta = computeMeta(candles);

  const png = renderCandlesPng(candles, meta);

  const name = (opts.name || 'adrian_candles.png').trim();
  return {
    url: `attachment://${name}`,
    file: { attachment: png, name },
    meta
  };
}

module.exports = { getAdrianChartUrl };
