// services/presenceTicker.js
const fetch = require('node-fetch');

/**
 * Presence Price Ticker
 * - Shows BTC/ETH/SOL (or any listed) prices in the member list presence.
 * - Sources (per-asset fallback now): Coingecko (primary) -> CoinCap (fallback) -> GeckoTerminal (pools) -> Dexscreener (pairs)
 * - Modes: rotate (one asset) | pair (N assets together)
 * - Up/down style: 24h change (API) or tick-to-tick since the last poll
 *
 * Extra env for DEX sources:
 *   TICKER_GT_MAP="btc=ethereum:0xPOOL;eth=ethereum:0xPOOL;sol=solana:POOLID;adrian=base:POOLID"
 *   TICKER_DS_MAP="btc=ethereum:0xPAIR;eth=ethereum:0xPAIR;sol=solana:0xPAIR;adrian=base:0xPAIR"
 *
 * Optional custom ID maps for centralized sources (so you can add custom tickers if listed there):
 *   TICKER_CG_IDS="ape=apecoin;adrian=some-coingecko-id"
 *   TICKER_CC_IDS="ape=apecoin;adrian=some-coincap-id"
 */

let timer = null;
let rotatingIndex = 0;
const lastTick = Object.create(null); // symbol -> last price

// ----------- ENV -----------
const ENABLED     = /^true$/i.test(process.env.TICKER_ENABLED || 'true');
const MODE        = (process.env.TICKER_MODE || 'rotate').toLowerCase(); // rotate | pair
const INTERVAL    = Math.max(15000, Number(process.env.TICKER_INTERVAL_MS || '60000')); // >=15s
const STATUS      = (process.env.TICKER_STATUS || 'online').toLowerCase();
const UPDOWN_MODE = (process.env.TICKER_UPDOWN || '24h').toLowerCase(); // 24h | tick
const PAIR_COUNT  = Math.max(1, Number(process.env.TICKER_PAIR_COUNT || '1')); // how many to show in pair mode

// Primary sources list (priority). Back-compat: falls back to TICKER_SOURCE if set.
const SOURCE_LIST = (process.env.TICKER_SOURCES || process.env.TICKER_SOURCE || 'coingecko,coincap,geckoterminal,dexscreener')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

const ACTIVITY_TYPES = { Playing: 0, Streaming: 1, Listening: 2, Watching: 3, Competing: 5 };
const ACTIVITY_TYPE  = ACTIVITY_TYPES[process.env.TICKER_ACTIVITY_TYPE || 'Watching'] ?? 3;

// ✅ Added adrian to default list
const RAW_ASSETS = (process.env.TICKER_ASSETS || 'btc,eth,sol,ape,adrian')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

// ---------- ID maps (centralized sources) ----------
function parseIdMapEnv(envVal) {
  // "btc=bitcoin;eth=ethereum;adrian=some-id"
  const map = Object.create(null);
  if (!envVal) return map;
  for (const part of envVal.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const [sym, id] = p.split('=');
    if (!sym || !id) continue;
    map[sym.trim().toLowerCase()] = id.trim();
  }
  return map;
}

const CG_IDS_BASE = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', doge: 'dogecoin', link: 'chainlink', ape: 'apecoin' };
const CC_IDS_BASE = { btc: 'bitcoin', eth: 'ethereum', sol: 'solana', doge: 'dogecoin', link: 'chainlink', ape: 'apecoin' };

// Optional overrides/additions via env
const CG_IDS = { ...CG_IDS_BASE, ...parseIdMapEnv(process.env.TICKER_CG_IDS || '') };
const CC_IDS = { ...CC_IDS_BASE, ...parseIdMapEnv(process.env.TICKER_CC_IDS || '') };

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
  return `${sign}${x.toFixed(Math.abs(x) >= 1 ? 1 : 2)}%`;
}

function trendArrow(pct) {
  const x = Number(pct);
  if (!isFinite(x)) return '•';
  if (x > 0.2)  return '▲';
  if (x < -0.2) return '▼';
  return '↔';
}

function cropActivity(text) {
  // Discord activity name practical limit ~128 chars. Keep a bit margin.
  return text.length <= 120 ? text : (text.slice(0, 117) + '…');
}

function toActivities(text) {
  return [{ type: ACTIVITY_TYPE, name: cropActivity(text) }];
}

function safeSetPresence(client, presence) {
  if (!client?.user) return;
  client.user.setPresence(presence); // djs v14: not a Promise
}

function parseMapEnv(envVal) {
  // "btc=ethereum:0xPOOL;eth=ethereum:0xPOOL;sol=solana:POOLID"
  const map = Object.create(null);
  if (!envVal) return map;
  for (const part of envVal.split(';')) {
    const p = part.trim();
    if (!p) continue;
    const [sym, rest] = p.split('=');
    if (!sym || !rest) continue;
    const [network, id] = rest.split(':');
    if (!network || !id) continue;
    map[sym.trim().toLowerCase()] = { network: network.trim().toLowerCase(), id: id.trim() };
  }
  return map;
}

const GT_MAP = parseMapEnv(process.env.TICKER_GT_MAP || ''); // geckoterminal
const DS_MAP = parseMapEnv(process.env.TICKER_DS_MAP || ''); // dex screener

// ----------- debounced warnings (anti-spam) -----------
const WARN_DEBOUNCE_MS = Math.max(30_000, Number(process.env.TICKER_WARN_DEBOUNCE_MS || 900_000)); // default 15m
const _warnMemo = new Map(); // key(string) -> ts

function warnDebounced(key, msg) {
  const t = Date.now();
  const last = _warnMemo.get(key) || 0;
  if (t - last >= WARN_DEBOUNCE_MS) {
    _warnMemo.set(key, t);
    console.warn(msg);
  }
}

// ----------- fetching -----------
async function fetchCoingecko(assets) {
  const ids = pickSourceIds('coingecko', assets);
  if (!ids.length) return {}; // ✅ don’t throw; just means “not supported here”
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
  if (!ids.length) return {}; // ✅ don’t throw; just means “not supported here”
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

/**
 * GeckoTerminal pool fetch (per asset).
 * Requires TICKER_GT_MAP entry for each symbol: sym=network:poolId
 */
async function fetchGeckoTerminal(assets) {
  const out = {};
  // Only attempt mapped assets (avoid useless calls)
  const mapped = assets.filter(sym => GT_MAP[sym]);
  if (!mapped.length) return {}; // ✅ no mappings => no data
  for (const sym of mapped) {
    const cfg = GT_MAP[sym];
    const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(cfg.network)}/pools/${encodeURIComponent(cfg.id)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) continue;
    const json = await res.json();
    const attr = json?.data?.attributes;
    const price =
      Number(attr?.price_in_usd) ||
      Number(attr?.base_token_price_usd) ||
      Number(attr?.quote_token_price_usd) ||
      NaN;
    if (isFinite(price)) {
      out[sym] = { price, change24h: null }; // tick-mode will handle Δ if enabled
    }
  }
  return out;
}

/**
 * Dexscreener pair fetch (per asset).
 * Requires TICKER_DS_MAP entry for each symbol: sym=chain:pairAddress
 */
async function fetchDexScreener(assets) {
  const out = {};
  const mapped = assets.filter(sym => DS_MAP[sym]);
  if (!mapped.length) return {}; // ✅ no mappings => no data
  for (const sym of mapped) {
    const cfg = DS_MAP[sym];
    const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(cfg.network)}/${encodeURIComponent(cfg.id)}`;
    const res = await fetch(url, { timeout: 10000 });
    if (!res.ok) continue;
    const json = await res.json();
    const pair = json?.pair || (json?.pairs && json.pairs[0]);
    const price = Number(pair?.priceUsd);
    if (isFinite(price)) {
      out[sym] = { price, change24h: null };
    }
  }
  return out;
}

/**
 * ✅ NEW: per-asset fallback (merge sources)
 * This is what makes it possible to show BTC/ETH from Coingecko while also showing $ADRIAN from GeckoTerminal/Dexscreener.
 */
async function getPrices(assets) {
  const cascade = [...SOURCE_LIST];
  for (const s of ['coingecko', 'coincap', 'geckoterminal', 'dexscreener']) {
    if (!cascade.includes(s)) cascade.push(s);
  }

  const out = {};
  const remaining = new Set(assets);
  let lastErr = null;

  for (const src of cascade) {
    const missing = [...remaining];
    if (!missing.length) break;

    try {
      let part = {};
      if (src === 'coingecko')     part = await fetchCoingecko(missing);
      if (src === 'coincap')       part = await fetchCoincap(missing);
      if (src === 'geckoterminal') part = await fetchGeckoTerminal(missing);
      if (src === 'dexscreener')   part = await fetchDexScreener(missing);

      if (part && typeof part === 'object') {
        for (const [sym, row] of Object.entries(part)) {
          if (row && typeof row.price === 'number' && isFinite(row.price)) {
            out[sym] = row;
            remaining.delete(sym);
          }
        }
      }
    } catch (e) {
      lastErr = e;
      // continue to next source
    }
  }

  if (!Object.keys(out).length) throw (lastErr || new Error('No price sources succeeded'));
  return out;
}

// Build label for one symbol
function labelFor(sym, row) {
  const price = row?.price;
  const pct24 = row?.change24h;

  let pct;
  if (UPDOWN_MODE === 'tick' && typeof lastTick[sym] === 'number' && lastTick[sym] > 0) {
    pct = ((price - lastTick[sym]) / lastTick[sym]) * 100;
  } else {
    pct = pct24; // may be null for DEX sources -> arrow '•'
  }

  const arrow = trendArrow(pct);
  const pctS  = fmtPct(pct);
  const symU  = sym.toUpperCase();
  return `${symU} $${shortUSD(price)} ${arrow}${pctS ? ' ' + pctS : ''}`;
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
    catch (e) {
      const key = `ticker-initial:${String(e?.message || e)}`;
      warnDebounced(key, `⚠️ Price ticker error (initial): ${e?.message || e}`);
    }
  }, 1200 + Math.floor(Math.random() * 800));

  timer = setInterval(async () => {
    try { await tickOnce(client); }
    catch (e) {
      const key = `ticker:${String(e?.message || e)}`;
      warnDebounced(key, `⚠️ Price ticker error: ${e?.message || e}`);
    }
  }, INTERVAL);

  console.log(
    `📈 Presence ticker started (mode=${MODE}, every ${INTERVAL}ms, Δ=${UPDOWN_MODE}, sources=${SOURCE_LIST.join('>')}, assets=${RAW_ASSETS.join(',')}, pair=${PAIR_COUNT})`
  );
}

function stopPresenceTicker() {
  if (timer) { clearInterval(timer); timer = null; console.log('🛑 Presence ticker stopped'); }
}

module.exports = { startPresenceTicker, stopPresenceTicker };




