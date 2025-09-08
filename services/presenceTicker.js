// services/presenceTicker.js
const fetch = require('node-fetch');
const { ActivityType } = require('discord.js');

/**
 * ENV (optional):
 * TICKER_ENABLED=true           // default true
 * TICKER_INTERVAL_MS=60000      // default 60000 (1 min)
 * TICKER_MODE=rotate            // rotate | pair
 * TICKER_SOURCE=coingecko       // coingecko | coincap
 * TICKER_ASSETS=btc,eth         // supports btc,eth  (extensible later)
 */

const ENABLED = !/^false$/i.test(process.env.TICKER_ENABLED || 'true');
const INTERVAL_MS = Math.max(15_000, Number(process.env.TICKER_INTERVAL_MS || '60000')); // rate friendly
const MODE = (process.env.TICKER_MODE || 'rotate').toLowerCase(); // rotate | pair
const SOURCE = (process.env.TICKER_SOURCE || 'coingecko').toLowerCase();
const WANTED = (process.env.TICKER_ASSETS || 'btc,eth')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const SUPPORTED = {
  btc: { coingeckoId: 'bitcoin', coincapId: 'bitcoin', symbol: 'BTC' },
  eth: { coingeckoId: 'ethereum', coincapId: 'ethereum', symbol: 'ETH' },
};

const ASSETS = WANTED
  .map(k => SUPPORTED[k])
  .filter(Boolean);

let timer = null;
let lastPrices = {};
let rotateIndex = 0;
let lastLogAt = 0; // throttle noisy logs

function nowLog(...args) {
  const t = Date.now();
  if (t - lastLogAt > 10_000) { // at most one every 10s
    console.log(...args);
    lastLogAt = t;
  }
}

function fmtUsd(n) {
  if (!isFinite(n)) return '$—';
  if (n >= 100000) return `$${Math.round(n).toLocaleString('en-US')}`;
  if (n >= 1000) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  if (n >= 100)  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function arrowFor(symbol, price) {
  const prev = lastPrices[symbol];
  if (typeof prev !== 'number') return '→';
  if (price > prev) return '↗';
  if (price < prev) return '↘';
  return '→';
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 12_000) {
  const hasAbort = typeof globalThis.AbortController === 'function';
  if (!hasAbort) {
    return await Promise.race([
      (async () => {
        const res = await fetch(url, opts);
        const text = await res.text();
        return { res, text };
      })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeoutMs))
    ]);
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

async function fetchPricesCoingecko() {
  const ids = ASSETS.map(a => a.coingeckoId).join(',');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids)}&vs_currencies=usd`;
  const { res, text } = await fetchWithTimeout(url, {}, 12_000);
  if (!res.ok) throw new Error(`coingecko ${res.status}: ${text?.slice(0,200)}`);
  const data = safeJson(text);
  const out = {};
  for (const a of ASSETS) {
    const p = data?.[a.coingeckoId]?.usd;
    if (typeof p === 'number') out[a.symbol] = p;
  }
  return out;
}

async function fetchPricesCoincap() {
  const ids = ASSETS.map(a => a.coincapId).join(',');
  const url = `https://api.coincap.io/v2/assets?ids=${encodeURIComponent(ids)}`;
  const { res, text } = await fetchWithTimeout(url, {}, 12_000);
  if (!res.ok) throw new Error(`coincap ${res.status}: ${text?.slice(0,200)}`);
  const data = safeJson(text);
  const out = {};
  for (const row of (data?.data || [])) {
    const a = ASSETS.find(x => x.coincapId === row.id);
    if (!a) continue;
    const p = Number(row.priceUsd);
    if (isFinite(p)) out[a.symbol] = p;
  }
  return out;
}

async function getPrices() {
  try {
    if (SOURCE === 'coincap') return await fetchPricesCoincap();
    // default to coingecko, fallback to coincap
    try {
      return await fetchPricesCoingecko();
    } catch (e) {
      nowLog('⚠️ Coingecko fetch failed; falling back to CoinCap:', e.message);
      return await fetchPricesCoincap();
    }
  } catch (e) {
    throw e;
  }
}

function makeActivity(mode, prices) {
  if (mode === 'pair' && ASSETS.length >= 2) {
    // BTC $xx | ETH $yy
    const parts = ASSETS.slice(0, 2).map(a => {
      const sym = a.symbol;
      const p = prices[sym];
      const arr = arrowFor(sym, p);
      return `${sym} ${arr} ${fmtUsd(p)}`;
    });
    return parts.join(' | ').slice(0, 120); // presence name limit ~128
  }

  // rotate one at a time
  const a = ASSETS[rotateIndex % ASSETS.length];
  const sym = a.symbol;
  const p = prices[sym];
  const arr = arrowFor(sym, p);
  return `${sym} ${arr} ${fmtUsd(p)}`.slice(0, 120);
}

async function tick(client) {
  if (!client?.user) return;
  try {
    const prices = await getPrices();
    // remember for deltas:
    for (const [sym, p] of Object.entries(prices)) lastPrices[sym] = p;

    const name = makeActivity(MODE, prices);
    // Watch "BTC ↗ $xx" etc.
    client.user.setPresence({
      status: 'online',
      activities: [{ name, type: ActivityType.Watching }]
    }).catch(() => {});

    rotateIndex++;
  } catch (e) {
    nowLog('⚠️ Price ticker error:', e.message);
    // Optional: set an "offline" hint only if repeated failures
    // client.user.setPresence({ status: 'idle', activities: [{ name: 'price feed…', type: ActivityType.Watching }] }).catch(()=>{});
  }
}

function startPresenceTicker(client) {
  if (!ENABLED) {
    console.log('ℹ️ Price ticker disabled (TICKER_ENABLED=false).');
    return;
  }
  if (!ASSETS.length) {
    console.log('ℹ️ Price ticker has no valid assets; set TICKER_ASSETS=btc,eth');
    return;
  }
  // First tick quickly, then at interval
  tick(client);
  timer = setInterval(() => tick(client), INTERVAL_MS);
  console.log(`📈 Presence ticker ON (${MODE}) every ${INTERVAL_MS}ms via ${SOURCE}.`);
}

function stopPresenceTicker() {
  if (timer) clearInterval(timer);
  timer = null;
  console.log('📉 Presence ticker OFF.');
}

module.exports = { startPresenceTicker, stopPresenceTicker };
