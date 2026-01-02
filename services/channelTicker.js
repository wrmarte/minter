// services/channelTicker.js
const fetch = require("node-fetch");

/**
 * Voice Channel Ticker (MINIMAL)
 * Format:
 *   📈 $ADRIAN $0.00003800 ↔
 *
 * ENV (required):
 *   CHANNEL_TICKER_ENABLED=true
 *   CHANNEL_TICKER_CHANNEL_IDS=<voiceChannelId>
 *   CHANNEL_TICKER_ASSET=adrian
 *   CHANNEL_TICKER_INTERVAL_MS=300000
 *
 * GeckoTerminal map:
 *   TICKER_GT_MAP=adrian=base:POOLID
 *
 * Optional:
 *   CHANNEL_TICKER_PREFIX=📈
 *   CHANNEL_TICKER_DEBUG=1
 */

let timer = null;

const ENABLED = /^true$/i.test(process.env.CHANNEL_TICKER_ENABLED || "false");
const CHANNEL_IDS = (process.env.CHANNEL_TICKER_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ASSET = String(process.env.CHANNEL_TICKER_ASSET || "adrian").trim().toLowerCase();

const INTERVAL = Math.max(
  120000, // hard minimum 2 minutes
  Number(process.env.CHANNEL_TICKER_INTERVAL_MS || "300000") // default 5m
);

const PREFIX = String(process.env.CHANNEL_TICKER_PREFIX || "📈").trim();
const DEBUG = String(process.env.CHANNEL_TICKER_DEBUG || "").trim() === "1";

// Debounced warnings
const WARN_DEBOUNCE_MS = Math.max(
  30000,
  Number(process.env.CHANNEL_TICKER_WARN_DEBOUNCE_MS || 900000) // 15m
);
const _warnMemo = new Map();
function warnDebounced(key, msg) {
  const t = Date.now();
  const last = _warnMemo.get(key) || 0;
  if (t - last >= WARN_DEBOUNCE_MS) {
    _warnMemo.set(key, t);
    console.warn(msg);
  }
}

// -------- format helpers --------
function shortUSD(n) {
  const x = Number(n);
  if (!isFinite(x)) return "?";
  // Force 8 decimals for tiny tokens, else 4.
  if (x < 1) return x.toFixed(8);
  return x.toFixed(4);
}

function trendArrow(pct) {
  const x = Number(pct);
  if (!isFinite(x)) return "•";
  if (x > 0.2) return "▲";
  if (x < -0.2) return "▼";
  return "↔";
}

// -------- env map parsing --------
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

const GT_MAP = parseMapEnv(process.env.TICKER_GT_MAP || "");

// -------- GeckoTerminal fetch --------
async function fetchGeckoTerminal(sym) {
  const cfg = GT_MAP[sym];
  if (!cfg) return null;

  // Try id as-is and without 0x (some endpoints accept either)
  const candidates = [];
  if (cfg.id) candidates.push(cfg.id);
  if (cfg.id && cfg.id.startsWith("0x")) candidates.push(cfg.id.slice(2));

  for (const id of candidates) {
    const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(
      cfg.network
    )}/pools/${encodeURIComponent(id)}`;

    let res;
    try {
      res = await fetch(url, { timeout: 10000 });
    } catch (e) {
      if (DEBUG) console.log(`[CHANNEL_TICKER][GT] fetch error url=${url} err=${e?.message || e}`);
      continue;
    }

    if (!res?.ok) {
      if (DEBUG) console.log(`[CHANNEL_TICKER][GT] HTTP ${res?.status} url=${url}`);
      continue;
    }

    let json;
    try {
      json = await res.json();
    } catch {
      if (DEBUG) console.log(`[CHANNEL_TICKER][GT] bad json url=${url}`);
      continue;
    }

    const attr = json?.data?.attributes;
    const price =
      Number(attr?.price_in_usd) ||
      Number(attr?.base_token_price_usd) ||
      Number(attr?.quote_token_price_usd) ||
      NaN;

    // 24h change field varies; if missing we still show arrow as •
    const pct24 =
      Number(attr?.price_change_percentage_h24) ||
      Number(attr?.price_change_percentage_24h) ||
      NaN;

    if (isFinite(price)) {
      if (DEBUG) console.log(`[CHANNEL_TICKER][GT] ok sym=${sym} price=${price} pct24=${pct24} url=${url}`);
      return { price, change24h: isFinite(pct24) ? pct24 : null };
    }

    if (DEBUG) console.log(`[CHANNEL_TICKER][GT] no price fields sym=${sym} url=${url}`);
  }

  return null;
}

async function getPrice(sym) {
  const row = await fetchGeckoTerminal(sym);
  if (row && typeof row.price === "number" && isFinite(row.price)) return row;
  throw new Error(
    `No price sources succeeded for "${sym}". Check TICKER_GT_MAP formatting (NO quotes, ';' separator).`
  );
}

// -------- channel update --------
function cropName(name) {
  // Voice channel name limit ~100 chars; keep margin
  const limit = 95;
  if (name.length <= limit) return name;
  return name.slice(0, limit - 1) + "…";
}

const lastApplied = new Map();

async function updateOneChannel(client, channelId, row) {
  let ch = client.channels.cache.get(channelId);
  if (!ch) {
    try {
      ch = await client.channels.fetch(channelId);
    } catch (e) {
      warnDebounced(
        `fetch:${channelId}`,
        `⚠️ Channel ticker: cannot fetch channel ${channelId}: ${e?.message || e}`
      );
      return;
    }
  }
  if (!ch || typeof ch.setName !== "function") return;

  const symU = ASSET.toUpperCase();
  const priceStr = shortUSD(row?.price);
  const arrow = trendArrow(row?.change24h);

  const nextName = cropName(`${PREFIX} $${symU} $${priceStr} ${arrow}`.trim());

  const prev = lastApplied.get(channelId);
  if (prev === nextName) return;

  try {
    await ch.setName(nextName, "Voice channel ticker update");
    lastApplied.set(channelId, nextName);
    if (DEBUG) console.log(`[CHANNEL_TICKER] setName ok channel=${channelId} name="${nextName}"`);
  } catch (e) {
    const msg = String(e?.message || e);
    warnDebounced(`setName:${channelId}:${msg}`, `⚠️ Channel ticker: setName failed for ${channelId}: ${msg}`);
  }
}

async function tickOnce(client) {
  if (!CHANNEL_IDS.length) return;
  const row = await getPrice(ASSET);
  await Promise.all(CHANNEL_IDS.map((id) => updateOneChannel(client, id, row)));
}

function startChannelTicker(client) {
  if (!ENABLED) {
    console.log("⏭️ Channel ticker disabled (set CHANNEL_TICKER_ENABLED=true to enable)");
    return;
  }
  if (!client?.user) return;
  if (timer) return;

  setTimeout(async () => {
    try {
      await tickOnce(client);
      console.log(`📌 Channel ticker started (asset=${ASSET}, every ${INTERVAL}ms, channels=${CHANNEL_IDS.join(",")})`);
    } catch (e) {
      warnDebounced(
        `channelTicker:init:${String(e?.message || e)}`,
        `⚠️ Channel ticker error (initial): ${e?.message || e}`
      );
      if (DEBUG) {
        console.log(
          `[CHANNEL_TICKER][DEBUG] GT_MAP raw="${process.env.TICKER_GT_MAP || ""}" keys=${Object.keys(GT_MAP).join(",") || "(none)"}`
        );
      }
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
