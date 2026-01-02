// services/adrianChart.js
const fetch = require('node-fetch');

let canvasMod = null;
function getCanvas() {
  if (canvasMod) return canvasMod;
  // @napi-rs/canvas is what you already use in your bot
  canvasMod = require('@napi-rs/canvas');
  return canvasMod;
}

// ===================== ENV =====================
const GT_NETWORK = (process.env.ADRIAN_GT_NETWORK || 'base').trim().toLowerCase();
const GT_POOL_ID_RAW =
  (process.env.ADRIAN_GT_POOL_ID ||
    '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
  ).trim();

const CHART_POINTS = Math.max(20, Math.min(240, Number(process.env.ADRIAN_CHART_POINTS || 96)));
const CACHE_MS = Math.max(10_000, Number(process.env.ADRIAN_CHART_CACHE_MS || 60_000));

const TIMEFRAME = String(process.env.ADRIAN_CHART_TIMEFRAME || 'minute').trim().toLowerCase(); // minute|hour|day
const AGGREGATE_ENV = Number(process.env.ADRIAN_CHART_AGGREGATE || '') || null; // null => default per timeframe

const SHOW_VOLUME = String(process.env.ADRIAN_CHART_SHOW_VOLUME || '1').trim() !== '0';
const DEBUG = String(process.env.ADRIAN_CHART_DEBUG || '').trim() === '1';

// Canvas sizing
const W = Math.max(640, Number(process.env.ADRIAN_CHART_W || 960));
const H = Math.max(360, Number(process.env.ADRIAN_CHART_H || 520));

// Trend threshold for “flat-ish” candles (purely aesthetic)
const FLAT_THRESHOLD_PCT = Math.max(0, Number(process.env.ADRIAN_CHART_FLAT_THRESHOLD_PCT || '0.02')); // 0.02%

// ===================== CACHE =====================
let _cache = Object.create(null); // key -> { ts, buffer, filename, meta }

// ===================== HELPERS =====================
function safeJsonParse(t) { try { return JSON.parse(t); } catch { return null; } }

async function fetchText(url) {
  const res = await fetch(url, { timeout: 12_000 });
  const txt = await res.text();
  return { res, txt };
}

function poolIdCandidates(raw) {
  const s = String(raw || '').trim();
  if (!s) return [];
  const has0x = s.toLowerCase().startsWith('0x');
  const with0x = has0x ? s : `0x${s}`;
  const without0x = has0x ? s.slice(2) : s;
  return Array.from(new Set([with0x, without0x].filter(Boolean)));
}

function normalizeTimeframe(tf) {
  const t = String(tf || '').trim().toLowerCase();
  if (t === 'min' || t === 'mins' || t === 'minute' || t === 'minutes') return 'minute';
  if (t === 'hr' || t === 'hrs' || t === 'hour' || t === 'hours') return 'hour';
  if (t === 'day' || t === 'days') return 'day';
  return 'minute';
}

function pickDefaultAggregate(tf) {
  if (tf === 'hour') return 1;
  if (tf === 'day') return 1;
  return 15;
}

function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }

function fmtUSD(x) {
  const n = Number(x);
  if (!isFinite(n)) return '?';
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(8);
}

function fmtNum(x) {
  const n = Number(x);
  if (!isFinite(n)) return '?';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(n >= 10_000 ? 0 : 1) + 'k';
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function findArrayOfArrays(obj) {
  const seen = new Set();
  const stack = [{ v: obj, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6) continue;

    if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length >= 5) {
      return v;
    }
    for (const k of Object.keys(v)) stack.push({ v: v[k], d: d + 1 });
  }
  return null;
}

// ===================== GECKOTERMINAL OHLCV =====================
async function fetchOhlcvList({ timeframe, aggregate, limit }) {
  const tf = normalizeTimeframe(timeframe);
  const agg = Number(aggregate) || pickDefaultAggregate(tf);
  const lim = clamp(Number(limit) || CHART_POINTS, 20, 240);

  const pools = poolIdCandidates(GT_POOL_ID_RAW);
  let lastErr = null;

  for (const poolId of pools) {
    const base = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(GT_NETWORK)}/pools/${encodeURIComponent(poolId)}`;

    const candidates = [
      `${base}/ohlcv/${tf}?aggregate=${encodeURIComponent(String(agg))}&limit=${encodeURIComponent(String(lim))}`,
      `${base}/ohlcv?timeframe=${encodeURIComponent(tf)}&aggregate=${encodeURIComponent(String(agg))}&limit=${encodeURIComponent(String(lim))}`,

      tf === 'minute' ? `${base}/ohlcv/minute?aggregate=${encodeURIComponent(String(agg))}&limit=${encodeURIComponent(String(lim))}` : null,
      tf === 'hour' ? `${base}/ohlcv/hour?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 168)))}` : null,
      tf === 'day' ? `${base}/ohlcv/day?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 365)))}` : null
    ].filter(Boolean);

    for (const url of candidates) {
      try {
        const { res, txt } = await fetchText(url);
        if (!res.ok) {
          lastErr = new Error(`GT HTTP ${res.status} for ${url}: ${txt.slice(0, 120)}`);
          continue;
        }
        const json = safeJsonParse(txt);
        if (!json) { lastErr = new Error(`GT non-json for ${url}`); continue; }

        const list =
          json?.data?.attributes?.ohlcv_list ||
          json?.data?.attributes?.ohlcvList ||
          json?.data?.ohlcv_list ||
          json?.ohlcv_list ||
          null;

        if (Array.isArray(list) && list.length) return { list, used: { poolId, url, tf, agg } };

        const maybe = findArrayOfArrays(json);
        if (maybe?.length) return { list: maybe, used: { poolId, url, tf, agg } };

        lastErr = new Error(`GT response had no ohlcv_list for ${url}`);
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error('Unable to fetch OHLCV list from GeckoTerminal');
}

function cacheKey({ tf, agg, pts, vol, w, h }) {
  return [
    `net=${GT_NETWORK}`,
    `pool=${String(GT_POOL_ID_RAW).toLowerCase()}`,
    `tf=${tf}`,
    `agg=${agg}`,
    `pts=${pts}`,
    `vol=${vol ? 1 : 0}`,
    `w=${w}`,
    `h=${h}`
  ].join('|');
}

// ===================== CANVAS RENDER =====================
function drawGlowBorder(ctx, w, h) {
  // 3D glasses border: cyan + red offset
  ctx.save();
  ctx.lineWidth = 3;

  ctx.strokeStyle = 'rgba(0,255,255,0.35)';
  ctx.shadowColor = 'rgba(0,255,255,0.35)';
  ctx.shadowBlur = 12;
  ctx.strokeRect(10, 10, w - 20, h - 20);

  ctx.shadowBlur = 0;
  ctx.strokeStyle = 'rgba(255,60,90,0.30)';
  ctx.strokeRect(13, 13, w - 26, h - 26);

  ctx.restore();
}

function drawText3D(ctx, text, x, y, size = 22, align = 'left') {
  ctx.save();
  ctx.font = `700 ${size}px sans-serif`;
  ctx.textAlign = align;
  ctx.textBaseline = 'top';

  // red shadow
  ctx.fillStyle = 'rgba(255,60,90,0.80)';
  ctx.fillText(text, x + 2, y + 1);

  // cyan main
  ctx.fillStyle = 'rgba(0,255,255,0.95)';
  ctx.fillText(text, x, y);

  ctx.restore();
}

function drawSubtitle(ctx, text, x, y, w) {
  ctx.save();
  ctx.font = `500 12px sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(200,210,255,0.85)';

  // wrap-ish (simple)
  const maxW = Math.max(200, w);
  let line = '';
  const words = String(text || '').split(' ');
  let yy = y;

  for (const word of words) {
    const test = line ? (line + ' ' + word) : word;
    if (ctx.measureText(test).width > maxW) {
      ctx.fillText(line, x, yy);
      yy += 14;
      line = word;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);

  ctx.restore();
}

function renderCandles({ candles, meta }) {
  const { createCanvas } = getCanvas();
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background (cinema dark)
  ctx.fillStyle = '#0b0d12';
  ctx.fillRect(0, 0, W, H);

  // Subtle vignette
  ctx.save();
  const grad = ctx.createRadialGradient(W * 0.5, H * 0.45, 50, W * 0.5, H * 0.45, Math.max(W, H) * 0.65);
  grad.addColorStop(0, 'rgba(255,255,255,0.06)');
  grad.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  drawGlowBorder(ctx, W, H);

  // Layout
  const padL = 70;
  const padR = 22;
  const padT = 58;
  const padB = 24;

  const volH = SHOW_VOLUME ? Math.floor(H * 0.18) : 0;
  const gap = SHOW_VOLUME ? 12 : 0;

  const chartX = padL;
  const chartY = padT;
  const chartW = W - padL - padR;
  const chartH = H - padT - padB - volH - gap;

  const volY = chartY + chartH + gap;

  // Price range
  let minP = Infinity;
  let maxP = -Infinity;
  for (const c of candles) {
    if (isFinite(c.l)) minP = Math.min(minP, c.l);
    if (isFinite(c.h)) maxP = Math.max(maxP, c.h);
  }
  if (!isFinite(minP) || !isFinite(maxP) || maxP <= 0) {
    throw new Error('Invalid candle range');
  }
  // padding
  const padPct = 0.04;
  const pad = (maxP - minP) * padPct;
  minP = Math.max(0, minP - pad);
  maxP = maxP + pad;

  const priceToY = (p) => chartY + ((maxP - p) / (maxP - minP)) * chartH;

  // Volume range
  let maxV = 0;
  if (SHOW_VOLUME) {
    for (const c of candles) maxV = Math.max(maxV, Number(c.v || 0));
    if (!isFinite(maxV) || maxV <= 0) maxV = 1;
  }

  // Grid
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;

  const yTicks = 5;
  for (let i = 0; i <= yTicks; i++) {
    const yy = chartY + (chartH * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(chartX, yy);
    ctx.lineTo(chartX + chartW, yy);
    ctx.stroke();
  }

  const xTicks = 6;
  for (let i = 0; i <= xTicks; i++) {
    const xx = chartX + (chartW * i) / xTicks;
    ctx.beginPath();
    ctx.moveTo(xx, chartY);
    ctx.lineTo(xx, chartY + chartH);
    ctx.stroke();
  }

  // Volume grid
  if (SHOW_VOLUME) {
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.beginPath();
    ctx.moveTo(chartX, volY);
    ctx.lineTo(chartX + chartW, volY);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(chartX, volY + volH);
    ctx.lineTo(chartX + chartW, volY + volH);
    ctx.stroke();
  }

  ctx.restore();

  // Axes labels
  ctx.save();
  ctx.fillStyle = 'rgba(210,220,255,0.78)';
  ctx.font = '500 11px sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let i = 0; i <= yTicks; i++) {
    const p = maxP - ((maxP - minP) * i) / yTicks;
    const yy = chartY + (chartH * i) / yTicks;
    ctx.fillText(`$${fmtUSD(p)}`, chartX - 10, yy);
  }

  // X labels (time)
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const n = candles.length;
  for (let i = 0; i <= xTicks; i++) {
    const idx = Math.round((n - 1) * (i / xTicks));
    const c = candles[idx];
    if (!c) continue;
    const xx = chartX + (chartW * i) / xTicks;
    ctx.fillText(c.label, xx, chartY + chartH + 4);
  }
  ctx.restore();

  // Candles
  const nC = candles.length;
  const slot = chartW / nC;
  const bodyW = Math.max(3, Math.min(14, slot * 0.62));

  const BLUE = 'rgba(60, 140, 255, 0.95)';
  const RED = 'rgba(255, 60, 90, 0.92)';
  const WICK_BLUE = 'rgba(120, 190, 255, 0.95)';
  const WICK_RED = 'rgba(255, 140, 170, 0.95)';

  // volume colors (subtle)
  const VOL_BLUE = 'rgba(60, 140, 255, 0.22)';
  const VOL_RED = 'rgba(255, 60, 90, 0.18)';

  // Draw volume first (behind)
  if (SHOW_VOLUME) {
    for (let i = 0; i < nC; i++) {
      const c = candles[i];
      const xx = chartX + i * slot + slot * 0.5;
      const v = Number(c.v || 0);
      const hV = (v / maxV) * volH;
      const y0 = volY + volH - hV;

      const isUp = c.c >= c.o;
      ctx.fillStyle = isUp ? VOL_BLUE : VOL_RED;
      ctx.fillRect(xx - bodyW / 2, y0, bodyW, Math.max(1, hV));
    }
  }

  // Candles + wicks
  for (let i = 0; i < nC; i++) {
    const c = candles[i];
    const xx = chartX + i * slot + slot * 0.5;

    const yo = priceToY(c.o);
    const yc = priceToY(c.c);
    const yh = priceToY(c.h);
    const yl = priceToY(c.l);

    const isUpRaw = c.c >= c.o;
    const pctMove = c.o ? ((c.c - c.o) / c.o) * 100 : 0;

    // treat tiny moves as “flat” visually (still chooses a color)
    const isUp = Math.abs(pctMove) < FLAT_THRESHOLD_PCT ? true : isUpRaw;

    const bodyTop = Math.min(yo, yc);
    const bodyBot = Math.max(yo, yc);
    const bodyH = Math.max(2, bodyBot - bodyTop);

    // wick
    ctx.save();
    ctx.strokeStyle = isUp ? WICK_BLUE : WICK_RED;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(xx, yh);
    ctx.lineTo(xx, yl);
    ctx.stroke();
    ctx.restore();

    // 3D glow around body
    ctx.save();
    ctx.shadowColor = isUp ? 'rgba(0,255,255,0.22)' : 'rgba(255,60,90,0.18)';
    ctx.shadowBlur = 10;
    ctx.fillStyle = isUp ? BLUE : RED;
    ctx.fillRect(xx - bodyW / 2, bodyTop, bodyW, bodyH);
    ctx.restore();

    // subtle outline
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.lineWidth = 1;
    ctx.strokeRect(xx - bodyW / 2, bodyTop, bodyW, bodyH);
    ctx.restore();
  }

  // Title + meta
  drawText3D(ctx, '$ADRIAN — Candles', 22, 16, 22, 'left');

  const sub = [
    `${meta.tfLabel} • ${meta.points} candles`,
    `Last $${fmtUSD(meta.last)}`,
    `Hi $${fmtUSD(meta.hi)} / Lo $${fmtUSD(meta.lo)}`,
    `Δ ${meta.deltaPct >= 0 ? '+' : ''}${meta.deltaPct.toFixed(2)}%`,
    SHOW_VOLUME ? `Vol ${fmtNum(meta.volSum)}` : null
  ].filter(Boolean).join('   |   ');

  drawSubtitle(ctx, sub, 22, 40, W - 44);

  // tiny watermark
  ctx.save();
  ctx.font = '500 11px sans-serif';
  ctx.fillStyle = 'rgba(200,210,255,0.22)';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  ctx.fillText(`🕶️ ${GT_NETWORK} / GeckoTerminal`, W - 16, H - 12);
  ctx.restore();

  return canvas.toBuffer('image/png');
}

// ===================== PUBLIC API =====================
async function getAdrianChartImage(opts = {}) {
  const tf = normalizeTimeframe(opts.timeframe || TIMEFRAME);
  const agg = Number(opts.aggregate) || AGGREGATE_ENV || pickDefaultAggregate(tf);
  const pts = clamp(Number(opts.points) || CHART_POINTS, 20, 240);
  const vol = typeof opts.showVolume === 'boolean' ? opts.showVolume : SHOW_VOLUME;

  const key = cacheKey({ tf, agg, pts, vol, w: W, h: H });
  const now = Date.now();
  const cached = _cache[key];
  if (cached?.buffer && (now - cached.ts) < CACHE_MS) return cached;

  if (DEBUG) console.log(`[ADRIAN_CHART] fetching OHLCV tf=${tf} agg=${agg} pts=${pts}`);

  const { list, used } = await fetchOhlcvList({ timeframe: tf, aggregate: agg, limit: pts });

  // Normalize: expect [ts, o, h, l, c, v]
  const candles = [];
  for (const row of list.slice(0, pts)) {
    if (!Array.isArray(row) || row.length < 5) continue;

    const ts = Number(row[0]);
    const o = Number(row[1]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = Number(row[5] ?? 0);

    if (![ts, o, h, l, c].every(Number.isFinite)) continue;

    const tSec = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    const label = new Date(tSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    candles.push({ t: tSec, o, h, l, c, v: Number.isFinite(v) ? v : 0, label });
  }

  candles.sort((a, b) => a.t - b.t);
  if (candles.length < 10) throw new Error('Not enough candle points');

  const first = candles[0];
  const last = candles[candles.length - 1];

  let hi = -Infinity, lo = Infinity, volSum = 0;
  for (const c of candles) {
    hi = Math.max(hi, c.h);
    lo = Math.min(lo, c.l);
    volSum += Number(c.v || 0);
  }

  const deltaPct = first.o ? ((last.c - first.o) / first.o) * 100 : 0;

  const tfLabel =
    tf === 'minute' ? `${agg}m` :
    tf === 'hour' ? `${agg}h` :
    `${agg}d`;

  const meta = {
    network: GT_NETWORK,
    poolIdUsed: used?.poolId || null,
    tf,
    agg,
    tfLabel,
    points: candles.length,
    last: last.c,
    hi,
    lo,
    deltaPct,
    volSum: vol ? volSum : null
  };

  const buffer = renderCandles({ candles, meta });

  const filename = 'adrian_candles.png';
  const out = { ts: now, buffer, filename, meta };

  _cache[key] = out;

  if (DEBUG) console.log(`[ADRIAN_CHART] rendered ${filename} candles=${candles.length} url=${used?.url || ''}`);

  return out;
}

/**
 * Back-compat: returns an attachment URL + the file buffer.
 * You must send `files: [{ attachment: buffer, name: filename }]` with your message,
 * and set embed image to `attachment://filename`.
 */
async function getAdrianChartUrl(opts = {}) {
  const img = await getAdrianChartImage(opts);
  return {
    ts: img.ts,
    url: `attachment://${img.filename}`,
    file: { attachment: img.buffer, name: img.filename },
    meta: img.meta
  };
}

module.exports = { getAdrianChartImage, getAdrianChartUrl };

