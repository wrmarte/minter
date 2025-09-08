// services/presenceTicker.js
const fetch = require('node-fetch');

/**
 * Presence Price Ticker
 * - Shows BTC/ETH/SOL (or any listed) prices in the member list presence.
 * - Sources: Coingecko (primary) -> CoinCap (fallback)
 * - Modes: rotate (one asset) | pair (N assets together)
 * - Up/down style: 24h change (API) or tick-to-tick since the last poll
 */

let timer = null;
let rotatingIndex = 0;
const lastTick = Object.create(null); // symbol -> last price

// ----------- ENV -----------
const ENABLED     = /^true$/i.test(process.env.TICKER_ENABLED || 'true');
const MODE        = (process.env.TICKER_MODE || 'rotate').toLowerCase(); // rotate | pair
const INTERVAL    = Math.max(15000, Number(process.env.TICKER_INTERVAL_MS || '60000')); // >=15s
const SOURCE      = (process.env.TICKER_SOURCE || 'coingecko').toLowerCase(); // coingecko | coincap
const STATUS      = (process.env.TICKER_STATUS || 'online').toLowerCase();
const UPDOWN_MODE = (process.env.TICKER_UPDOWN || '24h').toLowerCase(); // 24h | tick
const PAIR_COUNT  = Math.max(1, Number(process.env.TICKER_PAIR_COUNT || '2')); // how many to show in pair mode

const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
const ACTIVITY_TYPE  = ACTIVITY_TYPES[process.env.TICKER_ACTIVITY_TYPE || 'Watching'] ?? 3;

const RAW_ASSETS = (process.env.TICKER_ASSETS || 'btc,eth,sol,ape')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// Maps for both sources (extend as needed)
const CG_IDS = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', doge: 'dogecoin', link: 'chainlink', pepe: 'pepe' };
const CC_IDS = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', doge: 'dogecoin', link: 'chainlink', pepe: 'pepe' };

// ----------- helpers -----------
function pickSourceIds(source, assets) {
  const map = source === 'coincap' ? CC_IDS : CG_IDS;
  return assets.map(a => map[a]).filter(Boolean);
}

function shortUSD(n) {
  const x = Number(n);
  if (!isFinite(x)) return '?';
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1) + 'M';
  if (x >= 1_000)     return (x / 1_000).toFixed(x >= 10_000 ? 0 : 1) + 'k';
  if (x >= 100)       return x.toFixed(2);
  if (x >= 1)         return x.toFixed(2);
  if (x >= 0.01)      return x.toFixed(4);
  return x.toFixed(6);
}

function fmtPct(n) {
  const x = Number(n);
  if (!isFinite(x)) return '';
  const sign = x > 0 ? '+' : '';
  // clamp to keep presence string short
  return `${sign}${x.toFixed(Math.abs(x) >= 1 ? 1 : 2)}%`;
}

function trendArrow(pct) {
  const x = Number(pct);
  if (!isFinite(x)) return '•';
  if (x > 0.2)  return '▲';
  if (x < -0.2) return '▼';
  return '↔';
}

function toActivities(text) {
  return [{ type: ACTIVITY_TYPE, name: text }];
}

function safeSetPresence(client, presence) {
  if (!client?.user) return;
  try {
    client.user.setPresence(presence); // djs v14: not a Promise
  } catch (e) {
    throw e;
  }
}

// ----------- fetching -----------
async function fetchCoingecko(assets) {
  const ids = pickSourceIds('coingecko', assets);
  if (!ids.length) throw new Error('No supported assets for Coingecko');
  // include 24h % change
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Coingecko HTTP ${res.status}`);
  const data = await res.json();
  const out = {};
  for (const sym of assets) {
    const id = CG_IDS[sym];
    const row = data?.[id];
    if (row && typeof row.usd === 'number') {
      out[sym] = { price: row.usd, change24h: Number(row.usd_24h_change) };
    }
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
    const sym = Object.keys(CC_IDS).find(k => CC_IDS[k] === row.id);
    if (!sym) continue;
    out[sym] = { price: Number(row.priceUsd), change24h: Number(row.changePercent24Hr) };
  }
  return out;
}

async function getPrices(assets) {
  const primary   = SOURCE === 'coincap' ? 'coincap' : 'coingecko';
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

// Build label for one symbol
function labelFor(sym, row) {
  const price = row?.price;
  const pct24 = row?.change24h;

  // choose source of %: 24h API vs tick-to-tick
  let pct;
  if (UPDOWN_MODE === 'tick' && typeof lastTick[sym] === 'number' && lastTick[sym] > 0) {
    pct = ((price - lastTick[sym]) / lastTick[sym]) * 100;
  } else {
    pct = pct24;
  }

  const arrow = trendArrow(pct);
  const pctS  = fmtPct(pct);
  const symU  = sym.toUpperCase();
  return `${symU} $${shortUSD(price)} ${arrow} ${pctS}`;
}

// ----------- ticker logic -----------
async function tickOnce(client) {
  const rows = await getPrices(RAW_ASSETS);
  const ready = RAW_ASSETS.filter(a => rows[a] && typeof rows[a].price === 'number');

  // update tick memory for next time
  for (const a of ready) lastTick[a] = rows[a].price;

  if (!ready.length) {
    safeSetPresence(client, { activities: [], status: STATUS });
    return;
  }

  if (MODE === 'pair') {
    const count = Math.min(Math.max(1, PAIR_COUNT), ready.length);
    const slice = ready.slice(0, count);
    const text = slice.map(sym => labelFor(sym, rows[sym])).join(' | ');
    safeSetPresence(client, { activities: toActivities(text), status: STATUS });
    return;
  }

  // rotate (default)
  if (rotatingIndex >= ready.length) rotatingIndex = 0;
  const a = ready[rotatingIndex++];
  const text = labelFor(a, rows[a]);
  safeSetPresence(client, { activities: toActivities(text), status: STATUS });
}

function startPresenceTicker(client) {
  if (!ENABLED) {
    console.log('⏭️ Presence ticker disabled by TICKER_ENABLED=false');
    return;
  }
  if (timer) return;

  // initial run
  setTimeout(async () => {
    try { await tickOnce(client); }
    catch (e) { console.warn('⚠️ Price ticker error (initial):', e?.message || e); }
  }, 1200 + Math.floor(Math.random() * 800));

  timer = setInterval(async () => {
    try { await tickOnce(client); }
    catch (e) { console.warn('⚠️ Price ticker error:', e?.message || e); }
  }, INTERVAL);

  console.log(`📈 Presence ticker started (${MODE}, ${INTERVAL}ms, ${UPDOWN_MODE} Δ, source=${SOURCE}, assets=${RAW_ASSETS.join(',')}, pair=${PAIR_COUNT})`);
}

function stopPresenceTicker() {
  if (timer) { clearInterval(timer); timer = null; console.log('🛑 Presence ticker stopped'); }
}

module.exports = { startPresenceTicker, stopPresenceTicker };


