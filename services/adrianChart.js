// services/adrianChart.js
const fetch = require('node-fetch');

const CHART_BUILD_TAG = '3D2'; // bump this when you want to confirm deploys

const GT_NETWORK = (process.env.ADRIAN_GT_NETWORK || 'base').trim().toLowerCase();
const GT_POOL_ID_RAW =
  (process.env.ADRIAN_GT_POOL_ID ||
    '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
  ).trim();

const CHART_POINTS = Math.max(20, Math.min(240, Number(process.env.ADRIAN_CHART_POINTS || 96))); // 96 = last day @ 15m
const CACHE_MS = Math.max(10_000, Number(process.env.ADRIAN_CHART_CACHE_MS || 60_000));

const DEFAULT_TIMEFRAME = (process.env.ADRIAN_CHART_TIMEFRAME || 'minute').trim().toLowerCase(); // minute|hour|day
const DEFAULT_AGGREGATE = Number(process.env.ADRIAN_CHART_AGGREGATE || '') || null; // if null => pick sensible default
const SHOW_VOLUME = String(process.env.ADRIAN_CHART_SHOW_VOLUME || '1').trim() !== '0';

// Keyed cache so timeframe/aggregate can vary later
let _cache = Object.create(null); // key -> { ts, urlBase, meta }

let _bootLogged = false;

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
  return 15; // minute
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
  return String(Math.round(n));
}

// Depth-limited search for an array-of-arrays where inner length >= 5
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

    for (const k of Object.keys(v)) {
      stack.push({ v: v[k], d: d + 1 });
    }
  }
  return null;
}

// Probe GT OHLCV endpoints
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

      // common historical paths
      tf === 'minute' ? `${base}/ohlcv/minute?aggregate=${encodeURIComponent(String(agg))}&limit=${encodeURIComponent(String(lim))}` : null,
      tf === 'hour' ? `${base}/ohlcv/hour?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 168)))}` : null,
      tf === 'day' ? `${base}/ohlcv/day?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 365)))}` : null,

      // extra fallback ladders
      tf === 'minute' ? `${base}/ohlcv/hour?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 168)))}` : null,
      tf === 'hour' ? `${base}/ohlcv/day?aggregate=1&limit=${encodeURIComponent(String(Math.min(lim, 180)))}` : null
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

function makeCacheKey({ timeframe, aggregate, points, showVolume }) {
  return [
    'tag=' + CHART_BUILD_TAG,
    'net=' + GT_NETWORK,
    'pool=' + String(GT_POOL_ID_RAW || '').toLowerCase(),
    'tf=' + normalizeTimeframe(timeframe),
    'agg=' + String(Number(aggregate) || pickDefaultAggregate(normalizeTimeframe(timeframe))),
    'pts=' + String(points),
    'vol=' + (showVolume ? '1' : '0')
  ].join('|');
}

function buildQuickChartUrlBase(points, { subtitle, showVolume = true } = {}) {
  // points: [{ t: unixSeconds, c: close, v?: volume }]
  const labels = points.map(p =>
    new Date(p.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  );

  const closes = points.map(p => Number(p.c));
  const volumes = points.map(p => Number(p.v || 0));

  // 3D glasses effect:
  // - cyan main + glow
  // - red ghost + glow
  // - small offset to separate the lenses visually
  const offsetFactor = 1.0007;
  const closesRed = closes.map(v => (Number.isFinite(v) ? v * offsetFactor : v));

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        ...(showVolume ? [{
          type: 'bar',
          data: volumes,
          yAxisID: 'yVol',
          borderWidth: 0,
          backgroundColor: 'rgba(255,255,255,0.07)',
          order: 0
        }] : []),

        // Cyan glow
        {
          data: closes,
          pointRadius: 0,
          borderWidth: 6,
          tension: 0.28,
          borderColor: 'rgba(0,255,255,0.20)',
          order: 1
        },
        // Red glow
        {
          data: closesRed,
          pointRadius: 0,
          borderWidth: 6,
          tension: 0.28,
          borderColor: 'rgba(255,60,90,0.16)',
          order: 2
        },

        // Cyan main
        {
          data: closes,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.28,
          borderColor: 'rgba(0,255,255,0.95)',
          order: 3
        },
        // Red ghost
        {
          data: closesRed,
          pointRadius: 0,
          borderWidth: 2,
          tension: 0.28,
          borderColor: 'rgba(255,60,90,0.78)',
          order: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 16, right: 18, bottom: 10, left: 12 } },
      plugins: {
        legend: { display: false },
        title: {
          display: true,
          text: '$ADRIAN (USD) — 3D Glasses',
          color: 'rgba(255,255,255,0.93)',
          font: { size: 20, weight: 'bold' }
        },
        subtitle: {
          display: true,
          text: subtitle || '',
          color: 'rgba(180,200,255,0.85)',
          font: { size: 12 }
        }
      },
      scales: {
        x: {
          ticks: {
            maxTicksLimit: 7,
            color: 'rgba(210,220,255,0.72)',
            font: { size: 10 }
          },
          grid: { color: 'rgba(255,255,255,0.07)' }
        },
        y: {
          ticks: {
            maxTicksLimit: 7,
            color: 'rgba(210,220,255,0.72)',
            font: { size: 10 },
            callback: (v) => '$' + v
          },
          grid: { color: 'rgba(255,255,255,0.08)' }
        },
        ...(showVolume ? {
          yVol: {
            position: 'right',
            ticks: {
              maxTicksLimit: 5,
              color: 'rgba(210,220,255,0.35)',
              font: { size: 9 },
              callback: (v) => fmtNum(v)
            },
            grid: { drawOnChartArea: false }
          }
        } : {})
      }
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(cfg));

  // IMPORTANT:
  // - backgroundColor makes it “cinema dark”
  // - We return a BASE url (no cb), so we can attach cb per request to beat Discord caching
  return `https://quickchart.io/chart?width=960&height=500&format=png&backgroundColor=${encodeURIComponent(
    '0b0d12'
  )}&c=${encoded}`;
}

async function getAdrianChartUrl(opts = {}) {
  if (!_bootLogged) {
    _bootLogged = true;
    console.log(`🕶️ ADRIAN Chart module loaded (build=${CHART_BUILD_TAG})`);
  }

  const timeframe = normalizeTimeframe(opts.timeframe || DEFAULT_TIMEFRAME);
  const aggregate = Number(opts.aggregate) || DEFAULT_AGGREGATE || pickDefaultAggregate(timeframe);
  const points = clamp(Number(opts.points) || CHART_POINTS, 20, 240);
  const showVolume = typeof opts.showVolume === 'boolean' ? opts.showVolume : SHOW_VOLUME;

  const key = makeCacheKey({ timeframe, aggregate, points, showVolume });

  const now = Date.now();
  const cached = _cache[key];

  // Use cached data/urlBase, but ALWAYS return a unique URL to beat Discord image caching
  if (cached?.urlBase && (now - cached.ts) < CACHE_MS) {
    return {
      ts: cached.ts,
      url: `${cached.urlBase}&cb=${now}`,
      meta: cached.meta
    };
  }

  const { list, used } = await fetchOhlcvList({ timeframe, aggregate, limit: points });

  const pts = [];
  for (const row of list.slice(0, points)) {
    if (!Array.isArray(row) || row.length < 5) continue;

    const ts = Number(row[0]);
    const c = Number(row[4]); // close
    const v = Number(row[5] ?? 0); // volume

    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;

    const tSec = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    pts.push({ t: tSec, c, v: Number.isFinite(v) ? v : 0 });
  }

  pts.sort((a, b) => a.t - b.t);
  if (pts.length < 5) throw new Error('Not enough chart points');

  const first = pts[0];
  const last = pts[pts.length - 1];

  let hi = -Infinity, lo = Infinity, volSum = 0;
  for (const p of pts) {
    if (Number.isFinite(p.c)) {
      if (p.c > hi) hi = p.c;
      if (p.c < lo) lo = p.c;
    }
    if (Number.isFinite(p.v)) volSum += p.v;
  }

  const deltaPct = first.c ? ((last.c - first.c) / first.c) * 100 : 0;
  const rangePct = lo ? ((hi - lo) / lo) * 100 : 0;

  const tfLabel =
    timeframe === 'minute' ? `${aggregate}m` :
    timeframe === 'hour' ? `${aggregate}h` :
    `${aggregate}d`;

  const subtitle = [
    `${GT_NETWORK} • ${tfLabel} • ${pts.length} pts`,
    `Last $${fmtUSD(last.c)}`,
    `Hi $${fmtUSD(hi)} / Lo $${fmtUSD(lo)} (R ${rangePct >= 0 ? '+' : ''}${rangePct.toFixed(2)}%)`,
    `Δ ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`,
    showVolume ? `Vol ${fmtNum(volSum)}` : null,
    `build ${CHART_BUILD_TAG}`
  ].filter(Boolean).join('  |  ');

  const urlBase = buildQuickChartUrlBase(pts, { subtitle, showVolume });

  const out = {
    ts: now,
    urlBase,
    meta: {
      build: CHART_BUILD_TAG,
      network: GT_NETWORK,
      poolIdUsed: used?.poolId || null,
      timeframe,
      aggregate,
      points: pts.length,
      lastPrice: last.c,
      deltaPct,
      hi,
      lo,
      rangePct,
      volSum: showVolume ? volSum : null
    }
  };

  _cache[key] = out;

  // return unique URL for Discord
  return { ts: out.ts, url: `${out.urlBase}&cb=${now}`, meta: out.meta };
}

module.exports = { getAdrianChartUrl };
