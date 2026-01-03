// listeners/musclemb/adrianChart.js
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const Config = require('./config');
const Utils = require('./utils');
const { safeReplyMessage } = require('./messaging');

// ✅ Canvas candles chart service
const { getAdrianChartUrl: getAdrianCandleChartUrl } = require('../../services/adrianChart');

let _adrianChartCache = { ts: 0, url: null, meta: null };

function isTriggered(lowered) {
  const t = (lowered || '').toLowerCase();
  return Config.ADRIAN_CHART_TRIGGERS.some(x => t.includes(x));
}

function _findArrayOfArrays(obj) {
  const seen = new Set();
  const stack = [{ v: obj, d: 0 }];
  while (stack.length) {
    const { v, d } = stack.pop();
    if (!v || typeof v !== 'object') continue;
    if (seen.has(v)) continue;
    seen.add(v);
    if (d > 6) continue;

    if (Array.isArray(v) && v.length && Array.isArray(v[0]) && v[0].length >= 5) return v;

    for (const k of Object.keys(v)) stack.push({ v: v[k], d: d + 1 });
  }
  return null;
}

function _buildQuickChartUrl(points, subtitle = 'GeckoTerminal') {
  const labels = points.map(p => new Date(p.t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  const dataBlue = points.map(p => Number(p.c));
  const dataRed = dataBlue.map(v => Number(v) * 1.004);

  const cfg = {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: '$ADRIAN (red)', data: dataRed, fill: false, pointRadius: 0, borderWidth: 4, tension: 0.25, borderColor: 'rgba(255, 0, 0, 0.75)' },
        { label: '$ADRIAN (blue)', data: dataBlue, fill: false, pointRadius: 0, borderWidth: 4, tension: 0.25, borderColor: 'rgba(0, 140, 255, 0.95)' }
      ]
    },
    options: {
      responsive: true,
      plugins: {
        legend: { display: false },
        title: { display: true, text: '🟥🟦 $ADRIAN price (USD) — 3D Mode', color: 'rgba(235,235,235,0.95)' },
        subtitle: { display: true, text: subtitle, color: 'rgba(200,200,200,0.9)' }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 6, color: 'rgba(210,210,210,0.9)' }, grid: { color: 'rgba(255,255,255,0.08)' } },
        y: { ticks: { maxTicksLimit: 6, color: 'rgba(210,210,210,0.9)' }, grid: { color: 'rgba(255,255,255,0.08)' } }
      }
    }
  };

  const encoded = encodeURIComponent(JSON.stringify(cfg));
  return `https://quickchart.io/chart?width=1000&height=500&format=png&devicePixelRatio=2&backgroundColor=rgba(12,12,12,1)&c=${encoded}`;
}

async function _fetchAdrianOhlcvList() {
  const base = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(Config.ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(Config.ADRIAN_GT_POOL_ID)}`;
  const candidates = [
    `${base}/ohlcv/day?aggregate=15&limit=${Config.ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv/minute?aggregate=15&limit=${Config.ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv/hour?aggregate=1&limit=${Math.min(Config.ADRIAN_CHART_POINTS, 168)}`,
    `${base}/ohlcv?timeframe=day&aggregate=15&limit=${Config.ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv?timeframe=minute&aggregate=15&limit=${Config.ADRIAN_CHART_POINTS}`,
    `${base}/ohlcv?timeframe=hour&aggregate=1&limit=${Math.min(Config.ADRIAN_CHART_POINTS, 168)}`
  ];

  let lastErr = null;
  for (const url of candidates) {
    try {
      const { res, bodyText } = await Utils.fetchWithTimeout(url, {}, 12000);
      if (!res.ok) { lastErr = new Error(`GT HTTP ${res.status}: ${bodyText?.slice(0, 120)}`); continue; }
      const json = Utils.safeJsonParse(bodyText);
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

async function getLineChartUrlCached() {
  const now = Date.now();
  if (_adrianChartCache.url && (now - _adrianChartCache.ts) < Config.ADRIAN_CHART_CACHE_MS) return _adrianChartCache;

  const list = await _fetchAdrianOhlcvList();

  const pts = [];
  let high = null;
  let low = null;
  let volumeSum = 0;

  for (const row of list.slice(0, Config.ADRIAN_CHART_POINTS)) {
    if (!Array.isArray(row) || row.length < 5) continue;

    const ts = Number(row[0]);
    const h = Number(row[2]);
    const l = Number(row[3]);
    const c = Number(row[4]);
    const v = (row.length >= 6) ? Number(row[5]) : null;

    if (!Number.isFinite(ts) || !Number.isFinite(c)) continue;

    const tSec = ts > 2_000_000_000_000 ? Math.floor(ts / 1000) : ts;
    pts.push({ t: tSec, c });

    if (Number.isFinite(h)) high = (high == null) ? h : Math.max(high, h);
    if (Number.isFinite(l)) low = (low == null) ? l : Math.min(low, l);
    if (Number.isFinite(v)) volumeSum += v;

    if (high == null) high = c;
    if (low == null) low = c;
  }

  pts.sort((a, b) => a.t - b.t);
  if (pts.length < 5) throw new Error('Not enough chart points');

  const first = pts[0];
  const last = pts[pts.length - 1];
  const deltaPct = ((last.c - first.c) / (first.c || 1)) * 100;

  const subtitle = `${Config.ADRIAN_GT_NETWORK} pool • ${pts.length} pts • Δ ${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(2)}%`;
  const url = _buildQuickChartUrl(pts, subtitle);

  _adrianChartCache = {
    ts: now,
    url,
    meta: {
      lastPrice: last.c,
      deltaPct,
      high,
      low,
      volumeSum,
      startTs: first.t,
      endTs: last.t,
      points: pts.length,
    }
  };
  return _adrianChartCache;
}

function _numOrNull(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeCandleMeta(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  return {
    last: _numOrNull(m.last ?? m.lastPrice ?? m.price ?? m.close),
    deltaPct: _numOrNull(m.deltaPct ?? m.changePct ?? m.pct),
    high: _numOrNull(m.hi ?? m.high ?? m.max),
    low: _numOrNull(m.lo ?? m.low ?? m.min),
    volumeSum: _numOrNull(m.volSum ?? m.volumeSum ?? m.vol ?? m.volume),
    startTs: _numOrNull(m.startTs ?? m.start ?? m.from),
    endTs: _numOrNull(m.endTs ?? m.end ?? m.to),
    points: _numOrNull(m.points ?? m.n ?? m.count),
    poolWeb: typeof m.poolWeb === 'string' ? m.poolWeb : null,
  };
}

async function sendEmbed(message) {
  try {
    if (Config.ADRIAN_CHART_MODE !== 'line') {
      const chart = await getAdrianCandleChartUrl({ points: Config.ADRIAN_CHART_POINTS, name: 'adrian_candles.png' });
      const file = new AttachmentBuilder(chart.file.attachment, { name: chart.file.name });

      const metaN = normalizeCandleMeta(chart.meta);

      const lastDec = (metaN.last != null && metaN.last >= 1) ? 4 : 8;
      const hiDec = (metaN.high != null && metaN.high >= 1) ? 4 : 8;
      const loDec = (metaN.low != null && metaN.low >= 1) ? 4 : 8;

      const lastStr = metaN.last != null ? Utils.fmtMoney(metaN.last, lastDec) : 'N/A';
      const deltaStr = metaN.deltaPct != null ? `${metaN.deltaPct >= 0 ? '+' : ''}${metaN.deltaPct.toFixed(2)}%` : 'N/A';
      const hiStr = metaN.high != null ? Utils.fmtMoney(metaN.high, hiDec) : 'N/A';
      const loStr = metaN.low != null ? Utils.fmtMoney(metaN.low, loDec) : 'N/A';
      const volStr = metaN.volumeSum != null ? Utils.fmtVol(metaN.volumeSum) : 'N/A';

      const rangeLine = (metaN.startTs != null && metaN.endTs != null)
        ? `Range: <t:${Math.floor(metaN.startTs)}:R> → <t:${Math.floor(metaN.endTs)}:R>`
        : null;

      const poolWeb = metaN.poolWeb ||
        `https://www.geckoterminal.com/${encodeURIComponent(Config.ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(Config.ADRIAN_GT_POOL_ID)}`;

      const embed = new EmbedBuilder()
        .setColor('#1e90ff')
        .setTitle('🕶️ $ADRIAN Candles (3D Mode)')
        .setDescription(
          [
            `Last: **${lastStr}** • Δ: **${deltaStr}**`,
            `🟦 up / bought • 🟥 down / sold`,
            `🟥 offset + 🟦 main overlay line (3D glasses theme)`,
            rangeLine
          ].filter(Boolean).join('\n')
        )
        .setImage(chart.url)
        .addFields(
          { name: 'High', value: `**${hiStr}**`, inline: true },
          { name: 'Low', value: `**${loStr}**`, inline: true },
          { name: 'Vol (sum)', value: `**${volStr}**`, inline: true },
          { name: 'Pool', value: poolWeb ? `[View Pool](${poolWeb})` : 'N/A', inline: false },
        )
        .setFooter({ text: `Last ${lastStr} • Δ ${deltaStr} • Source: GeckoTerminal → Canvas` })
        .setTimestamp();

      const ok = await safeReplyMessage(message.client, message, {
        embeds: [embed],
        files: [file],
        allowedMentions: { parse: [] }
      });

      if (!ok) console.warn('❌ sendAdrianChartEmbed(candles): safeReplyMessage returned false');
      return;
    }

    const { url, meta } = await getLineChartUrlCached();

    const lastPrice = meta?.lastPrice;
    const deltaPct = meta?.deltaPct;
    const hi = meta?.high;
    const lo = meta?.low;
    const vol = meta?.volumeSum;
    const startTs = meta?.startTs;
    const endTs = meta?.endTs;

    const descBits = [];
    if (Number.isFinite(lastPrice)) descBits.push(`Last: **${Utils.fmtMoney(lastPrice, 6)}**`);
    if (Number.isFinite(deltaPct)) descBits.push(`Δ: **${deltaPct >= 0 ? '+' : ''}${Number(deltaPct).toFixed(2)}%**`);

    const rangeLine = (Number.isFinite(startTs) && Number.isFinite(endTs))
      ? `Range: <t:${Math.floor(startTs)}:R> → <t:${Math.floor(endTs)}:R>`
      : null;

    const poolWeb = `https://www.geckoterminal.com/${encodeURIComponent(Config.ADRIAN_GT_NETWORK)}/pools/${encodeURIComponent(Config.ADRIAN_GT_POOL_ID)}`;

    let chartFile = null;
    let imageRef = null;
    try {
      const { res, buf } = await Utils.fetchBinaryWithTimeout(url, {}, 20000);
      if (res?.ok && buf && buf.length > 2000) {
        chartFile = { attachment: buf, name: 'adrian_chart.png' };
        imageRef = 'attachment://adrian_chart.png';
      } else {
        console.warn('⚠️ chart image fetch not ok, fallback to URL', res?.status);
      }
    } catch (e) {
      console.warn('⚠️ chart image fetch failed, fallback to URL:', e?.message || String(e));
    }

    const embed = new EmbedBuilder()
      .setColor('#1e90ff')
      .setTitle('🟥🟦 $ADRIAN Chart (3D Mode)')
      .setDescription([descBits.join(' • '), rangeLine, '_3D-glasses theme: red/blue overlay._'].filter(Boolean).join('\n') || 'Live chart from GeckoTerminal.')
      .setImage(imageRef || url)
      .addFields(
        { name: 'High', value: Number.isFinite(hi) ? `**${Utils.fmtMoney(hi, 6)}**` : 'N/A', inline: true },
        { name: 'Low', value: Number.isFinite(lo) ? `**${Utils.fmtMoney(lo, 6)}**` : 'N/A', inline: true },
        { name: 'Vol (sum)', value: Number.isFinite(vol) ? `**${Utils.fmtVol(vol)}**` : 'N/A', inline: true },
        { name: 'Pool', value: poolWeb ? `[View Pool](${poolWeb})` : 'N/A', inline: false },
      )
      .setFooter({ text: '🟥🟦 Source: GeckoTerminal → QuickChart (3D Mode)' })
      .setTimestamp();

    const payload = chartFile
      ? { embeds: [embed], files: [chartFile], allowedMentions: { parse: [] } }
      : { embeds: [embed], allowedMentions: { parse: [] } };

    const ok = await safeReplyMessage(message.client, message, payload);
    if (!ok) console.warn('❌ sendAdrianChartEmbed: safeReplyMessage returned false');
  } catch (e) {
    console.warn('⚠️ adrian chart failed:', e?.stack || e?.message || String(e));
    await safeReplyMessage(message.client, message, {
      content: '⚠️ Couldn’t pull $ADRIAN chart right now. Try again in a sec.',
      allowedMentions: { parse: [] }
    }).catch(() => {});
  }
}

module.exports = { isTriggered, sendEmbed };
