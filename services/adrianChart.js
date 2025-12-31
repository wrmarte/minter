// services/adrianChart.js
const fetch = require('node-fetch');

const GT_NETWORK = (process.env.ADRIAN_GT_NETWORK || 'base').trim().toLowerCase();
const GT_POOL_ID =
  (process.env.ADRIAN_GT_POOL_ID ||
    '0x79cdf2d48abd42872a26d1b1c92ece4245327a4837b427dc9cff5f1acc40e379'
  ).trim().toLowerCase();

const CHART_POINTS = Math.max(20, Math.min(240, Number(process.env.ADRIAN_CHART_POINTS || 96))); // 96 = last day @ 15m
const CACHE_MS = Math.max(10_000, Number(process.env.ADRIAN_CHART_CACHE_MS || 60_000));

let _cache = { ts: 0, url: null, meta: null };

function safeJsonParse(t) { try { return JSON.parse(t); } catch { return null; } }

async function fetchText(url) {
  const res = await fetch(url, { timeout: 12_000 });
  const txt = await res.text();
  return { res, txt };
}

// GeckoTerminal API has had a couple different OHLCV URL shapes historically.
// We probe a few common ones and parse whatever matches.
async function fetchOhlcvList() {
  const base = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(GT_NETWORK)}/pools/${encodeURIComponent(GT_POOL_ID)}`;

  const candidates = [
    // Common pattern A
    `${base}/ohlcv/day?aggregate=15&limit=${CHART_POINTS}`,
    `${base}/ohlcv/minute?aggregate=15&limit=${CHART_POINTS}`,
    `${base}/ohlcv/hour?aggregate=1&limit=${Math.min(CHART_POINTS, 168)}`,

    // Common pattern B (some deployments)
    `${base}/ohlcv?timeframe=day&aggregate=15&limit=${CHART_POINTS}`,
    `${base}/ohlcv?timeframe=minute&aggregate=15&limit=${CHART_POINTS}`,
    `${base}/ohlcv?timeframe=hour&aggregate=1&limit=${Math.min(CHART_POINTS, 168)}`
  ];

  let lastErr = null;

  for (const url of candidates) {
    try {
      const { res, txt } = await fetchText(url);
      if (!res.ok) {
        lastErr = new Error(`GT HTTP ${res.status} for ${url}: ${txt.slice(0, 120)}`);
        continue;
      }

      const json = safeJsonParse(txt);
      if (!json) { lastErr = new Error(`GT non-json for ${url}`); continue; }

      // Typical: json.data.attributes.ohlcv_list = [[ts, o, h, l, c, v], ...]
      const list =
        json?.data?.attributes?.ohlcv_list ||
        json?.data?.attributes?.ohlcvList ||
        json?.data?.ohlcv_list ||
        json?.ohlcv_list ||
        null;

      if (Array.isArray(list) && list.length) return list;

      // Fallback: try to discover any array-of-arrays shaped like OHLCV
      const maybe = findArrayOfArrays(json);
      if (maybe?.length) return maybe;

      lastErr = new Error(`GT response had no ohlcv_list for ${url}`);
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('Unable to fetch OHLCV list from GeckoTerminal');
}

function findArrayOfArrays(obj) {
  // very small, safe, depth-limited search for an array-of-arrays where inner length >= 5
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

function buildQuickChartUrl(points, { title = '$ADRIAN', subtitle = 'GeckoTerminal' } = {}) {
  // points: [{ t: unixSeconds, c: close }]
  const labels = points.map(p => new Date(p.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const data = points.map(p => Number(p.c));

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: title,
        data,
        fill: false,
        pointRadius: 0,
        borderWidth: 2,
        tension: 0.25
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: `${title} price (USD)` },
        subtitle: { display: true, text: subtitle }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6 } },
        y: { ticks: { maxTicksLimit: 6 } }
      }
    }
  };

  // QuickChart renders chart from encoded config
  const encoded = encodeURIComponent(JSON.stringify(cfg));
  return `https://quickchart.io/chart?width=900&height=450&format=png&c=${encoded}`;
}

async function getAdrianChartUrl() {
  const now = Date.now();
  if (_cache.url && (now - _cache.ts) < CACHE_MS) return _cache;

  const list = await fetchOhlcvList();

  // Normalize to points. Expect [ts, o, h, l, c, v] but we’ll be flexible.
  const pts = [];
  for (const row of list.slice(0, CHART_POINTS)) {
    if (!Array.isArray(row) || row.length < 5) continue;
    const ts = Number(row[0]);
    const c  = Number(row[4]); // close
    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;

    // GT timestamps are usually seconds; if ms, convert
    const tSec = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    pts.push({ t: tSec, c });
  }

  // Ensure ascending by time
  pts.sort((a, b) => a.t - b.t);

  if (pts.length < 5) throw new Error('Not enough chart points');

  const last = pts[pts.length - 1];
  const first = pts[0];
  const deltaPct = ((last.c - first.c) / first.c) * 100;
  const subtitle = `${GT_NETWORK} pool • ${pts.length} pts • Δ ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`;

  const url = buildQuickChartUrl(pts, { title: '$ADRIAN', subtitle });

  _cache = { ts: now, url, meta: { lastPrice: last.c, deltaPct } };
  return _cache;
}

module.exports = { getAdrianChartUrl };
