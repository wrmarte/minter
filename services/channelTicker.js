// services/channelTicker.js
const fetch = require("node-fetch");

/**
 * Channel Name Price Ticker
 * - Updates one or more channel NAMES to include a live price (ex: ADRIAN).
 * - This is the only real way to show a “ticker” in the left channel list.
 *
 * Uses same source strategy style as presenceTicker:
 *   Coingecko -> CoinCap -> GeckoTerminal (mapped) -> Dexscreener (mapped)
 *
 * ENV:
 *   CHANNEL_TICKER_ENABLED=true|false
 *   CHANNEL_TICKER_CHANNEL_IDS=123,456
 *   CHANNEL_TICKER_ASSET=adrian
 *   CHANNEL_TICKER_INTERVAL_MS=300000   (min 2m; recommend 5m+)
 *   CHANNEL_TICKER_SEPARATOR=" • "      (default " • ")
 *   CHANNEL_TICKER_PREFIX="📈 "         (default "📈 ")
 *
 * Reuse your existing maps if you already have them:
 *   TICKER_GT_MAP="adrian=base:POOLID"
 *   TICKER_DS_MAP="adrian=base:PAIRADDR"
 * Optional centralized IDs:
 *   TICKER_CG_IDS="adrian=coingecko-id"
 *   TICKER_CC_IDS="adrian=coincap-id"
 */

let timer = null;

const ENABLED = /^true$/i.test(process.env.CHANNEL_TICKER_ENABLED || "false");
const CHANNEL_IDS = (process.env.CHANNEL_TICKER_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ASSET = String(process.env.CHANNEL_TICKER_ASSET || "adrian")
  .trim()
  .toLowerCase();

const INTERVAL = Math.max(
  120000, // hard minimum 2 minutes
  Number(process.env.CHANNEL_TICKER_INTERVAL_MS || "300000") // default 5m
);

const SEPARATOR = String(process.env.CHANNEL_TICKER_SEPARATOR || " • ");
const PREFIX = String(process.env.CHANNEL_TICKER_PREFIX || "📈 ");

const SOURCE_LIST = (
  process.env.TICKER_SOURCES ||
  process.env.TICKER_SOURCE ||
  "coingecko,coincap,geckoterminal,dexscreener"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const WARN_DEBOUNCE_MS = Math.max(
  30000,
  Number(process.env.CHANNEL_TICKER_WARN_DEBOUNCE_MS || 900000) // 15m
);
const _warnMemo = new Map(); // key -> ts

function warnDebounced(key, msg) {
  const t = Date.now();
  const last = _warnMemo.get(key) || 0;
  if (t - last >= WARN_DEBOUNCE_MS) {
    _warnMemo.set(key, t);
    console.warn(msg);
  }
}

// --- helpers (format) ---
function shortUSD(n) {
  const x = Number(n);
  if (!isFinite(x)) return "?";
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1) + "M";
  if (x >= 1_000) return (x / 1_000).toFixed(x >= 10_000 ? 0 : 1) + "k";
  if (x >= 100) return x.toFixed(2);
  if (x >= 1) return x.toFixed(2);
  if (x >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}

function fmtPct(n) {
  const x = Number(n);
  if (!isFinite(x)) return "";
  const sign = x > 0 ? "+" : "";
  return `${sign}${x.toFixed(Math.abs(x) >= 1 ? 1 : 2)}%`;
}

function trendArrow(pct) {
  const x = Number(pct);
  if (!isFinite(x)) return "•";
  if (x > 0.2) return "▲";
  if (x < -0.2) return "▼";
  return "↔";
}

// --- map env parsing (reuse your existing TICKER_GT_MAP / TICKER_DS_MAP) ---
function parseIdMapEnv(envVal) {
  // "adrian=some-id;btc=bitcoin"
  const map = Object.create(null);
  if (!envVal) return map;
  for (const part of envVal.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const [sym, id] = p.split("=");
    if (!sym || !id) continue;
    map[sym.trim().toLowerCase()] = id.trim();
  }
  return map;
}

function parseMapEnv(envVal) {
  // "adrian=base:POOLID;eth=ethereum:0xPOOL"
  const map = Object.create(null);
  if (!envVal) return map;
  for (const part of envVal.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const [sym, rest] = p.split("=");
    if (!sym || !rest) continue;
    const [network, id] = rest.split(":");
    if (!network || !id) continue;
    map[sym.trim().toLowerCase()] = { network: network.trim().toLowerCase(), id: id.trim() };
  }
  return map;
}

const CG_IDS_BASE = { btc: "bitcoin", eth: "ethereum", sol: "solana", ape: "apecoin" };
const CC_IDS_BASE = { btc: "bitcoin", eth: "ethereum", sol: "solana", ape: "apecoin" };

const CG_IDS = { ...CG_IDS_BASE, ...parseIdMapEnv(process.env.TICKER_CG_IDS || "") };
const CC_IDS = { ...CC_IDS_BASE, ...parseIdMapEnv(process.env.TICKER_CC_IDS || "") };

const GT_MAP = parseMapEnv(process.env.TICKER_GT_MAP || "");
const DS_MAP = parseMapEnv(process.env.TICKER_DS_MAP || "");

// --- sources ---
async function fetchCoingecko(sym) {
  const id = CG_IDS[sym];
  if (!id) return null;
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(
    id
  )}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Coingecko HTTP ${res.status}`);
  const data = await res.json();
  const row = data?.[id];
  if (row && typeof row.usd === "number") {
    return { price: row.usd, change24h: Number(row.usd_24h_change) };
  }
  return null;
}

async function fetchCoincap(sym) {
  const id = CC_IDS[sym];
  if (!id) return null;
  const url = `https://api.coincap.io/v2/assets?ids=${encodeURIComponent(id)}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`CoinCap HTTP ${res.status}`);
  const data = await res.json();
  const row = (data?.data || [])[0];
  if (row && row.priceUsd) {
    return { price: Number(row.priceUsd), change24h: Number(row.changePercent24Hr) };
  }
  return null;
}

async function fetchGeckoTerminal(sym) {
  const cfg = GT_MAP[sym];
  if (!cfg) return null;
  const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(
    cfg.network
  )}/pools/${encodeURIComponent(cfg.id)}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) return null;
  const json = await res.json();
  const attr = json?.data?.attributes;
  const price =
    Number(attr?.price_in_usd) ||
    Number(attr?.base_token_price_usd) ||
    Number(attr?.quote_token_price_usd) ||
    NaN;
  if (isFinite(price)) return { price, change24h: null };
  return null;
}

async function fetchDexScreener(sym) {
  const cfg = DS_MAP[sym];
  if (!cfg) return null;
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(
    cfg.network
  )}/${encodeURIComponent(cfg.id)}`;
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) return null;
  const json = await res.json();
  const pair = json?.pair || (json?.pairs && json.pairs[0]);
  const price = Number(pair?.priceUsd);
  if (isFinite(price)) return { price, change24h: null };
  return null;
}

async function getPrice(sym) {
  const cascade = [...SOURCE_LIST];
  for (const s of ["coingecko", "coincap", "geckoterminal", "dexscreener"]) {
    if (!cascade.includes(s)) cascade.push(s);
  }

  let lastErr = null;
  for (const src of cascade) {
    try {
      let row = null;
      if (src === "coingecko") row = await fetchCoingecko(sym);
      if (src === "coincap") row = await fetchCoincap(sym);
      if (src === "geckoterminal") row = await fetchGeckoTerminal(sym);
      if (src === "dexscreener") row = await fetchDexScreener(sym);

      if (row && typeof row.price === "number" && isFinite(row.price)) return row;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error("No price sources succeeded");
}

// --- channel name logic ---
const baseNames = new Map(); // channelId -> baseName (without ticker suffix)
const lastApplied = new Map(); // channelId -> last full name applied

function stripOldTicker(name) {
  // If we previously added: "something • ADRIAN $0.0123 ..."
  // We try to remove suffix after our SEPARATOR if present.
  if (!name) return "";
  const idx = name.indexOf(SEPARATOR);
  if (idx > -1) return name.slice(0, idx).trim();
  return name.trim();
}

function buildSuffix(sym, row) {
  const symU = sym.toUpperCase();
  const price = row?.price;
  const pct = row?.change24h;
  const arrow = trendArrow(pct);
  const pctS = fmtPct(pct);
  return `${symU} $${shortUSD(price)} ${arrow}${pctS ? " " + pctS : ""}`.trim();
}

function cropName(name) {
  // Discord channel name limit is ~100 chars. Keep a cushion.
  if (name.length <= 98) return name;
  return name.slice(0, 97) + "…";
}

async function updateOneChannel(client, channelId, suffix) {
  let ch = client.channels.cache.get(channelId);
  if (!ch) {
    try {
      ch = await client.channels.fetch(channelId);
    } catch (e) {
      warnDebounced(`fetch:${channelId}`, `⚠️ Channel ticker: cannot fetch channel ${channelId}: ${e?.message || e}`);
      return;
    }
  }
  if (!ch) return;

  // must be a guild channel with setName
  if (typeof ch.setName !== "function") return;

  // figure out stable base name
  if (!baseNames.has(channelId)) {
    const base = stripOldTicker(ch.name || "");
    baseNames.set(channelId, base || ch.name || "ticker");
  }

  const base = baseNames.get(channelId) || "ticker";
  const nextName = cropName(`${PREFIX}${base}${SEPARATOR}${suffix}`);

  // avoid useless updates
  const prev = lastApplied.get(channelId);
  if (prev === nextName) return;

  try {
    await ch.setName(nextName, "Channel price ticker update");
    lastApplied.set(channelId, nextName);
  } catch (e) {
    const msg = String(e?.message || e);
    warnDebounced(`setName:${channelId}:${msg}`, `⚠️ Channel ticker: setName failed for ${channelId}: ${msg}`);
  }
}

async function tickOnce(client) {
  if (!CHANNEL_IDS.length) return;

  const row = await getPrice(ASSET);
  const suffix = buildSuffix(ASSET, row);

  // update all configured channels
  await Promise.all(CHANNEL_IDS.map((id) => updateOneChannel(client, id, suffix)));
}

function startChannelTicker(client) {
  if (!ENABLED) {
    console.log("⏭️ Channel ticker disabled (set CHANNEL_TICKER_ENABLED=true to enable)");
    return;
  }
  if (!client?.user) return;
  if (timer) return;

  // initial tick
  setTimeout(async () => {
    try {
      await tickOnce(client);
      console.log(`📌 Channel ticker started (asset=${ASSET}, every ${INTERVAL}ms, channels=${CHANNEL_IDS.join(",")})`);
    } catch (e) {
      warnDebounced(`channelTicker:init:${String(e?.message || e)}`, `⚠️ Channel ticker error (initial): ${e?.message || e}`);
    }
  }, 1500);

  timer = setInterval(async () => {
    try {
      await tickOnce(client);
    } catch (e) {
      warnDebounced(`channelTicker:${String(e?.message || e)}`, `⚠️ Channel ticker error: ${e?.message || e}`);
    }
  }, INTERVAL);
}

function stopChannelTicker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
    console.log("🛑 Channel ticker stopped");
  }
}

module.exports = { startChannelTicker, stopChannelTicker };
