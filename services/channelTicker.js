// services/channelTicker.js
const fetch = require("node-fetch");

/**
 * Channel Name Price Ticker
 *
 * Key reality:
 * - TEXT channel names are sanitized by Discord (no $, %, . and spaces become hyphens)
 * - VOICE channel names support richer characters and look much better
 *
 * ENV:
 *   CHANNEL_TICKER_ENABLED=true|false
 *   CHANNEL_TICKER_CHANNEL_IDS=123,456
 *   CHANNEL_TICKER_ASSET=adrian
 *   CHANNEL_TICKER_INTERVAL_MS=300000   (min 2m; recommend 5m+)
 *
 *   CHANNEL_TICKER_FORMAT=auto|pretty|safe
 *     - auto   (default): pretty for voice, safe for text
 *     - pretty: force pretty everywhere (text channels will still get sanitized by Discord)
 *     - safe  : force text-safe everywhere
 *
 *   CHANNEL_TICKER_BASE_NAME=ticker      (optional override, keeps channel name clean)
 *   CHANNEL_TICKER_PREFIX=📈             (default 📈)
 *
 * Maps:
 *   TICKER_GT_MAP=adrian=base:POOLID;btc=ethereum:0xPOOL
 */

let timer = null;

const ENABLED = /^true$/i.test(process.env.CHANNEL_TICKER_ENABLED || "false");
const CHANNEL_IDS = (process.env.CHANNEL_TICKER_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ASSET = String(process.env.CHANNEL_TICKER_ASSET || "adrian").trim().toLowerCase();

const INTERVAL = Math.max(
  120000,
  Number(process.env.CHANNEL_TICKER_INTERVAL_MS || "300000")
);

const FORMAT = String(process.env.CHANNEL_TICKER_FORMAT || "auto").trim().toLowerCase(); // auto|pretty|safe
const BASE_OVERRIDE = String(process.env.CHANNEL_TICKER_BASE_NAME || "").trim(); // optional
const PREFIX = String(process.env.CHANNEL_TICKER_PREFIX || "📈").trim();

const DEBUG = String(process.env.CHANNEL_TICKER_DEBUG || "").trim() === "1";

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
  Number(process.env.CHANNEL_TICKER_WARN_DEBOUNCE_MS || 900000)
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

// ---------------- format helpers ----------------
function shortUSD(n) {
  const x = Number(n);
  if (!isFinite(x)) return "?";
  if (x >= 1_000_000) return (x / 1_000_000).toFixed(x >= 10_000_000 ? 0 : 1) + "M";
  if (x >= 1_000) return (x / 1_000).toFixed(x >= 10_000 ? 0 : 1) + "k";
  if (x >= 100) return x.toFixed(2);
  if (x >= 1) return x.toFixed(4);      // a bit more precision for small caps
  if (x >= 0.01) return x.toFixed(6);
  return x.toFixed(8);
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

/**
 * TEXT channels get sanitized. Build a “safe” string that survives:
 * - remove $, %, .
 * - use hyphen as decimal separator
 * - keep it short
 */
function toTextSafe(sym, price, pct) {
  const symL = String(sym || "").toLowerCase();
  const p = Number(price);
  const pctN = Number(pct);

  // represent price as fixed 8 decimals but with "-" instead of "."
  let priceSafe = "?";
  if (isFinite(p)) {
    // keep leading 0-000038 style (good for tiny tokens)
    const fixed = p < 1 ? p.toFixed(8) : p.toFixed(4);
    // "0.00003800" -> "0-00003800"
    priceSafe = fixed.replace(".", "-").replace(/0+$/g, ""); // trim trailing zeros
    if (priceSafe.endsWith("-")) priceSafe = priceSafe.slice(0, -1);
  }

  let pctSafe = "";
  if (isFinite(pctN)) {
    const sign = pctN > 0 ? "p" : pctN < 0 ? "m" : "";
    const abs = Math.abs(pctN);
    const fixed = abs.toFixed(abs >= 1 ? 1 : 2).replace(".", "-");
    pctSafe = `${sign}${fixed}`; // p1-2 = +1.2, m0-33 = -0.33
  }

  const arrow = trendArrow(pctN);
  return pctSafe ? `${symL}-${priceSafe}-${arrow}-${pctSafe}` : `${symL}-${priceSafe}-${arrow}`;
}

function buildPretty(sym, row) {
  const symU = String(sym || "").toUpperCase();
  const price = row?.price;
  const pct = row?.change24h;
  const arrow = trendArrow(pct);
  const pctS = fmtPct(pct);
  return `${symU} $${shortUSD(price)} ${arrow}${pctS ? " " + pctS : ""}`.trim();
}

// ---------------- env map parsing ----------------
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

// ---------------- GeckoTerminal fetch ----------------
async function fetchGeckoTerminal(sym) {
  const cfg = GT_MAP[sym];
  if (!cfg) return null;

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

    // GeckoTerminal often provides 24h change under various fields depending on endpoint,
    // but we keep null so arrow becomes "•" unless you wire a change source.
    if (isFinite(price)) {
      if (DEBUG) console.log(`[CHANNEL_TICKER][GT] ok sym=${sym} price=${price} url=${url}`);
      return { price, change24h: Number(attr?.price_change_percentage_h24) || null };
    }

    if (DEBUG) console.log(`[CHANNEL_TICKER][GT] no price fields sym=${sym} url=${url}`);
  }

  return null;
}

async function getPrice(sym) {
  // You said you only have GeckoTerminal, so this module uses GT for channel ticker.
  // (Your presenceTicker handles multi-source; channel ticker kept lean & reliable.)
  const row = await fetchGeckoTerminal(sym);
  if (row && typeof row.price === "number" && isFinite(row.price)) return row;
  throw new Error(`No price sources succeeded for "${sym}". Check TICKER_GT_MAP formatting.`);
}

// ---------------- channel name logic ----------------
const baseNames = new Map();  // channelId -> baseName
const lastApplied = new Map();

function isVoiceish(ch) {
  // djs v14: voice channels are voice-based
  try {
    if (typeof ch.isVoiceBased === "function") return ch.isVoiceBased();
  } catch {}
  // fallback: type 2 is GuildVoice (covers most common)
  return Number(ch?.type) === 2;
}

function normalizeBaseName(name) {
  let s = String(name || "").trim();

  // Remove repeated PREFIX emojis from front (prevents 📈📈📈)
  if (PREFIX) {
    const escaped = PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(?:${escaped})+`, "u");
    s = s.replace(re, "").trim();
  }

  // Remove common separators people use
  s = s.replace(/^[-•|]+/, "").trim();
  s = s.replace(/[-•|]+$/, "").trim();

  // If it’s a text channel, Discord may have auto-hyphenated. Keep it simple.
  return s || "ticker";
}

function cropName(name, voiceMode) {
  // Keep under limit with margin
  const limit = voiceMode ? 95 : 90; // text channels get hyphenated -> can grow visually
  if (name.length <= limit) return name;
  return name.slice(0, limit - 1) + "…";
}

async function updateOneChannel(client, channelId, row) {
  let ch = client.channels.cache.get(channelId);
  if (!ch) {
    try {
      ch = await client.channels.fetch(channelId);
    } catch (e) {
      warnDebounced(`fetch:${channelId}`, `⚠️ Channel ticker: cannot fetch channel ${channelId}: ${e?.message || e}`);
      return;
    }
  }
  if (!ch || typeof ch.setName !== "function") return;

  const voiceMode = isVoiceish(ch);

  // Base name selection
  if (BASE_OVERRIDE) {
    baseNames.set(channelId, normalizeBaseName(BASE_OVERRIDE));
  } else if (!baseNames.has(channelId)) {
    baseNames.set(channelId, normalizeBaseName(ch.name || "ticker"));
  }

  const base = baseNames.get(channelId) || "ticker";

  // Build suffix
  const pretty = buildPretty(ASSET, row);
  const safe = toTextSafe(ASSET, row?.price, row?.change24h);

  let nextName;
  const mode = FORMAT;

  if (mode === "safe") {
    // Safe for text channels
    nextName = `${PREFIX}${base}-${safe}`;
  } else if (mode === "pretty") {
    // Pretty (best for voice)
    nextName = `${PREFIX} ${base} • ${pretty}`;
  } else {
    // auto
    nextName = voiceMode
      ? `${PREFIX} ${base} • ${pretty}`
      : `${PREFIX}${base}-${safe}`;
  }

  nextName = cropName(nextName, voiceMode);

  const prev = lastApplied.get(channelId);
  if (prev === nextName) return;

  try {
    await ch.setName(nextName, "Channel price ticker update");
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
      console.log(`📌 Channel ticker started (asset=${ASSET}, every ${INTERVAL}ms, channels=${CHANNEL_IDS.join(",")}, format=${FORMAT})`);
    } catch (e) {
      warnDebounced(`channelTicker:init:${String(e?.message || e)}`, `⚠️ Channel ticker error (initial): ${e?.message || e}`);
      if (DEBUG) console.log(`[CHANNEL_TICKER][DEBUG] GT_MAP raw="${process.env.TICKER_GT_MAP || ""}" keys=${Object.keys(GT_MAP).join(",") || "(none)"}`);
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

