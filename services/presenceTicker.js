// services/presenceTicker.js
const fetch = require('node-fetch');

/**
 * Presence Price Ticker
 * - Shows BTC/ETH prices in the member list presence
 * - Source: coingecko (primary) -> coincap (fallback)
 * - Modes: rotate (show one asset at a time) | pair (both in one line)
 *
 * ENV (optional):
 *   TICKER_ENABLED=true
 *   TICKER_MODE=rotate           # rotate | pair
 *   TICKER_INTERVAL_MS=60000     # 60s (avoid spamming to respect Discord rate limits)
 *   TICKER_SOURCE=coingecko      # coingecko | coincap
 *   TICKER_ASSETS=btc,eth        # comma list
 *   TICKER_STATUS=online         # online | idle | dnd | invisible
 *   TICKER_ACTIVITY_TYPE=Watching # Playing | Streaming | Listening | Watching | Competing
 */

let timer = null;
let rotatingIndex = 0;

const DEFAULT_ENABLED = /^true$/i.test(process.env.TICKER_ENABLED || 'true');
const MODE = (process.env.TICKER_MODE || 'rotate').toLowerCase();
const INTERVAL = Math.max(15000, Number(process.env.TICKER_INTERVAL_MS || '60000')); // >=15s
const SOURCE = (process.env.TICKER_SOURCE || 'coingecko').toLowerCase();
const RAW_ASSETS = (process.env.TICKER_ASSETS || 'btc,eth').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const STATUS = (process.env.TICKER_STATUS || 'online').toLowerCase();

const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
const ACTIVITY_TYPE = ACTIVITY_TYPES[process.env.TICKER_ACTIVITY_TYPE || 'Watching'] ?? 3;

// Minimal common asset id maps
const CG_IDS = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  doge: 'dogecoin',
  link: 'chainlink',
  pepe: 'pepe'
};
const CC_IDS = {
  btc: 'bitcoin',
  eth: 'ethereum',
  sol: 'solana',
  doge: 'dogecoin',
  link: 'chainlink',
  pepe: 'pepe'
};

// -------------- helpers --------------
function pickSourceIds(source, assets) {
  const map = source === 'coincap' ? CC_IDS : CG_IDS;
  return assets.map(a => map[a]).filter(Boolean);
}

function formatUSD(n) {
  const x = Number(n);
  if (!isFinite(x)) return '?';
  if (x >= 1000) return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (x >= 100)  return x.toFixed(2);
  if (x >= 1)    return x.toFixed(2);
  if (x >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}

async function fetchCoingecko(assets) {
  const ids = pickSourceIds('coingecko', assets);
  if (!ids.length) throw new Error('No supported assets for Coingecko');
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Coingecko HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (let i = 0; i < assets.length; i++) {
    const a = assets[i];
    const id = CG_IDS[a];
    const p = data?.[id]?.usd;
    if (typeof p === 'number') out[a] = p;
  }
  return out;
}

async function fetchCoincap(assets) {
  const ids = pickSourceIds('coincap', assets);
  if (!ids.length) throw new Error('No supported assets for CoinCap');
  const url = `https://api.coincap.io/v2/assets?ids=${encodeURIComponent(ids.join(','))}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`CoinCap HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const row of data?.data || []) {
    // reverse-map to our symbol
    const sym = Object.keys(CC_IDS).find(k => CC_IDS[k] === row.id);
    if (sym) out[sym] = Number(row.priceUsd);
  }
  return out;
}

async function getPrices(assets) {
  // primary chosen by env; fallback to the other source if primary fails
  const primary = SOURCE === 'coincap' ? 'coincap' : 'coingecko';
  const secondary = primary === 'coincap' ? 'coingecko' : 'coincap';

  try {
    return primary === 'coincap' ? await fetchCoincap(assets) : await fetchCoingecko(assets);
  } catch (e1) {
    try {
      return secondary === 'coincap' ? await fetchCoincap(assets) : await fetchCoingecko(assets);
    } catch (e2) {
      throw new Error(`${e1.message} | fallback failed: ${e2.message}`);
    }
  }
}

function labelFor(asset, price) {
  const upper = asset.toUpperCase();
  return `${upper} $${formatUSD(price)}`;
}

function toPresenceActivities(text) {
  return [{ type: ACTIVITY_TYPE, name: text }];
}

function safeSetPresence(client, presence) {
  if (!client?.user) return;
  try {
    client.user.setPresence(presence); // NOT a Promise in djs v14
  } catch (e) {
    // surface upstream; caller can decide
    throw e;
  }
}

// -------------- ticker logic --------------
async function tickOnce(client) {
  const prices = await getPrices(RAW_ASSETS);
  const have = RAW_ASSETS.filter(a => typeof prices[a] === 'number');

  if (!have.length) {
    // nothing fetched; clear activity but keep status
    safeSetPresence(client, { activities: [], status: STATUS });
    return;
  }

  if (MODE === 'pair' && have.length >= 2) {
    // show first two
    const a = have[0], b = have[1];
    const text = `${labelFor(a, prices[a])} | ${labelFor(b, prices[b])}`;
    safeSetPresence(client, { activities: toPresenceActivities(text), status: STATUS });
    return;
  }

  // rotate mode (default)
  if (rotatingIndex >= have.length) rotatingIndex = 0;
  const a = have[rotatingIndex++];
  const text = labelFor(a, prices[a]);
  safeSetPresence(client, { activities: toPresenceActivities(text), status: STATUS });
}

function startPresenceTicker(client) {
  if (!DEFAULT_ENABLED) {
    console.log('⏭️ Presence ticker disabled by TICKER_ENABLED=false');
    return;
  }
  if (timer) return; // already running
  if (!client?.isReady?.()) {
    console.warn('⚠️ Presence ticker started before client ready; it will update on next interval.');
  }

  // First run asap with a tiny jitter to avoid starting at the same time as other tasks
  setTimeout(async () => {
    try { await tickOnce(client); }
    catch (e) { console.warn('⚠️ Price ticker error (initial):', e?.message || e); }
  }, 1500 + Math.floor(Math.random() * 800));

  timer = setInterval(async () => {
    try { await tickOnce(client); }
    catch (e) { console.warn('⚠️ Price ticker error:', e?.message || e); }
  }, INTERVAL);

  console.log(`📈 Presence ticker started (${MODE}, ${INTERVAL}ms, source=${SOURCE}, assets=${RAW_ASSETS.join(',')})`);
}

function stopPresenceTicker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log('🛑 Presence ticker stopped');
  }
}

module.exports = { startPresenceTicker, stopPresenceTicker };

