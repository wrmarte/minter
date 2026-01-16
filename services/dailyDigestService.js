// services/dailyDigestService.js
const { EmbedBuilder } = require("discord.js");

function num(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function fmtMoney(n, decimals = 2) {
  const x = num(n, 0);
  return x.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtEth(n, decimals = 4) {
  const x = num(n, 0);
  return x.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function safeStr(s, max = 120) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

function padAddr(addr) {
  const a = String(addr || "").trim();
  if (!a) return "";
  const low = a.toLowerCase();
  if (low.length < 12) return low;
  return `${low.slice(0, 6)}…${low.slice(-4)}`;
}

function padWho(who, max = 22) {
  const w = String(who || "").trim();
  if (!w) return "";
  return w.length > max ? w.slice(0, max - 1) + "…" : w;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/* ===================== LABELS (NAMES INSTEAD OF CA) ===================== */

const ADRIAN_TOKEN_CA = String(
  process.env.ADRIAN_TOKEN_CA || "0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea"
).toLowerCase();

const ENGINE_CA = String(
  process.env.ENGINE_CA || "0x0351f7cba83277e891d4a85da498a7eacd764d58"
).toLowerCase();

// ✅ You provided this
const ADRIANBOT_CA = String(
  process.env.ADRIANBOT_CA || "0xa41D5fAF7BA8B82E276125dE2a053216e91f4814"
).toLowerCase();

// Optional extra labels:
// DIGEST_ADDR_LABELS="0xabc=User,0xdef=SomeName"
function parseExtraLabels() {
  const raw = String(process.env.DIGEST_ADDR_LABELS || "").trim();
  const m = new Map();
  if (!raw) return m;
  for (const pair of raw.split(",")) {
    const [a, label] = pair.split("=").map((s) => String(s || "").trim());
    if (!a || !label) continue;
    m.set(a.toLowerCase(), label);
  }
  return m;
}
const EXTRA_LABELS = parseExtraLabels();

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!s) return "";
  return s.toLowerCase();
}

function labelAddr(addr) {
  const low = normalizeAddr(addr);
  if (!low) return "";

  // Core labels
  if (low === ADRIAN_TOKEN_CA) return "$ADRIAN";
  if (low === ENGINE_CA) return "ENGINE";
  if (low === ADRIANBOT_CA) return "AdrianBot";

  // Custom labels from env
  const extra = EXTRA_LABELS.get(low);
  if (extra) return extra;

  // fallback short address
  return padAddr(low);
}

function labelContract(contract) {
  return labelAddr(contract);
}

function labelWho(addr) {
  return labelAddr(addr);
}

/* ===================== TABLE ENSURE (SAFE) ===================== */
/**
 * NOTE:
 * - digestLogger.js is the authoritative schema initializer now (with token_id_norm dedupe).
 * - This ensure is kept as a safe fallback so scheduler won't silently fail.
 * - It will NOT drop/overwrite newer schema; it only creates missing basics.
 */

const DIGEST_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS digest_events (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL, -- 'mint' | 'sale' | 'token_buy' | 'token_sell'
  chain         TEXT,
  contract      TEXT,
  token_id      TEXT,
  amount_native NUMERIC,
  amount_eth    NUMERIC,
  amount_usd    NUMERIC,
  buyer         TEXT,
  seller        TEXT,
  tx_hash       TEXT,
  ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS digest_events_guild_ts_idx
  ON digest_events (guild_id, ts DESC);

CREATE INDEX IF NOT EXISTS digest_events_guild_type_ts_idx
  ON digest_events (guild_id, event_type, ts DESC);

CREATE INDEX IF NOT EXISTS digest_events_txhash_idx
  ON digest_events (tx_hash);
`;

// ✅ Cache ensure so we don't run DDL repeatedly (saves DB load)
let _ensureOk = false;
let _ensureLastAttemptMs = 0;
const ENSURE_RETRY_MS = Math.max(60000, Number(process.env.DAILY_DIGEST_ENSURE_RETRY_MS || 10 * 60 * 1000)); // 10m

async function ensureDigestEventsTable(pg) {
  if (!pg?.query) return false;

  const now = Date.now();
  if (_ensureOk) return true;

  // Avoid hammering if DB has temp issues
  if (_ensureLastAttemptMs && now - _ensureLastAttemptMs < ENSURE_RETRY_MS) {
    return false;
  }

  _ensureLastAttemptMs = now;

  try {
    await pg.query(DIGEST_EVENTS_TABLE_SQL);
    _ensureOk = true;
    return true;
  } catch (e) {
    console.warn("[DAILY_DIGEST] failed to ensure digest_events table:", e?.message || e);
    _ensureOk = false;
    return false;
  }
}

/* ===================== FETCH WINDOW ===================== */

// Hard cap to prevent huge memory pulls if a guild logs a lot
const MAX_ROWS = Math.max(200, Number(process.env.DAILY_DIGEST_MAX_ROWS || 2000));

async function fetchDigestWindow(pg, guildId, hours = 24) {
  // Ensure schema only if needed; cached above
  await ensureDigestEventsTable(pg);

  const q = `
    SELECT *
    FROM digest_events
    WHERE guild_id = $1
      AND ts >= NOW() - ($2 * INTERVAL '1 hour')
    ORDER BY ts DESC
    LIMIT $3
  `;

  try {
    const r = await pg.query(q, [String(guildId), Number(hours), Number(MAX_ROWS)]);
    return r.rows || [];
  } catch (e) {
    console.warn("[DAILY_DIGEST] fetchDigestWindow failed:", e?.message || e);
    return [];
  }
}

/* ===================== STATS ===================== */

function computeDigestStats(rows) {
  const byType = new Map();
  const bumpType = (t) => byType.set(t, (byType.get(t) || 0) + 1);

  for (const r of rows) {
    const t = String(r?.event_type || "").toLowerCase();
    bumpType(t || "unknown");
  }

  const mints = rows.filter((r) => String(r.event_type || "").toLowerCase() === "mint");

  // sale split:
  const salesAll = rows.filter((r) => String(r.event_type || "").toLowerCase() === "sale");
  const nftSales = salesAll.filter((r) => r.token_id != null && String(r.token_id).trim() !== "");
  const swaps = salesAll.filter((r) => r.token_id == null || String(r.token_id).trim() === "");

  // token trades:
  const tokenBuys = rows.filter((r) => String(r.event_type || "").toLowerCase() === "token_buy");
  const tokenSells = rows.filter((r) => String(r.event_type || "").toLowerCase() === "token_sell");
  const tokenTrades = [...tokenBuys, ...tokenSells];

  const sum = (arr, key) => arr.reduce((a, r) => a + num(r[key], 0), 0);

  const totalMints = mints.length;
  const totalNftSales = nftSales.length;
  const totalSwaps = swaps.length;
  const totalTokenBuys = tokenBuys.length;
  const totalTokenSells = tokenSells.length;

  const nftVolEth = sum(nftSales, "amount_eth");
  const nftVolUsd = sum(nftSales, "amount_usd");

  const swapVolEth = sum(swaps, "amount_eth");
  const swapVolUsd = sum(swaps, "amount_usd");

  const tokenVolEth = sum(tokenTrades, "amount_eth");
  const tokenVolUsd = sum(tokenTrades, "amount_usd");

  const totalVolEth = nftVolEth + swapVolEth + tokenVolEth;
  const totalVolUsd = nftVolUsd + swapVolUsd + tokenVolUsd;

  // most active contract by count
  const byContract = new Map();
  for (const r of rows) {
    const c = (r.contract || "").toLowerCase() || "unknown";
    byContract.set(c, (byContract.get(c) || 0) + 1);
  }
  let mostActive = { contract: "", count: 0 };
  for (const [contract, count] of byContract.entries()) {
    if (count > mostActive.count) mostActive = { contract, count };
  }

  // top NFT sale by ETH
  let topNftSale = null;
  for (const r of nftSales) {
    const v = num(r.amount_eth, 0);
    if (!topNftSale || v > num(topNftSale.amount_eth, 0)) topNftSale = r;
  }

  // top swap by USD (fallback ETH)
  let topSwap = null;
  for (const r of swaps) {
    const u = num(r.amount_usd, 0);
    const e = num(r.amount_eth, 0);
    const score = u > 0 ? u : e;
    if (!topSwap) topSwap = { row: r, score };
    else if (score > (topSwap.score || 0)) topSwap = { row: r, score };
  }

  // top token trade by USD (fallback ETH)
  let topTokenTrade = null;
  for (const r of tokenTrades) {
    const u = num(r.amount_usd, 0);
    const e = num(r.amount_eth, 0);
    const score = u > 0 ? u : e;
    if (!topTokenTrade) topTokenTrade = { row: r, score };
    else if (score > (topTokenTrade.score || 0)) topTokenTrade = { row: r, score };
  }

  // chains breakdown
  const byChain = new Map();
  for (const r of rows) {
    const ch = (r.chain || "unknown").toLowerCase();
    byChain.set(ch, (byChain.get(ch) || 0) + 1);
  }

  // window timing
  const newestTs = rows?.[0]?.ts ? new Date(rows[0].ts) : null;
  const oldestTs = rows?.length ? new Date(rows[rows.length - 1].ts) : null;

  return {
    totalMints,
    totalNftSales,
    totalSwaps,
    totalTokenBuys,
    totalTokenSells,

    nftVolEth,
    nftVolUsd,
    swapVolEth,
    swapVolUsd,
    tokenVolEth,
    tokenVolUsd,
    totalVolEth,
    totalVolUsd,

    mostActive,
    topNftSale,
    topSwapRow: topSwap?.row || null,
    topTokenTradeRow: topTokenTrade?.row || null,

    byChain,
    byType,

    newestTs,
    oldestTs,
  };
}

/* ===================== EMBED BUILD ===================== */

function buildDigestEmbed({ guildName, hours, stats, rows, settings, hadQueryError = false }) {
  const {
    totalMints,
    totalNftSales,
    totalSwaps,
    totalTokenBuys,
    totalTokenSells,

    nftVolEth,
    nftVolUsd,
    swapVolEth,
    swapVolUsd,
    tokenVolEth,
    tokenVolUsd,
    totalVolEth,
    totalVolUsd,

    mostActive,
    topNftSale,
    topSwapRow,
    topTokenTradeRow,

    byChain,
    byType,
    newestTs,
    oldestTs,
  } = stats;

  const chainLine = [...byChain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join(" • ");

  const activeContract =
    mostActive.contract && mostActive.contract !== "unknown"
      ? `${labelContract(mostActive.contract)} (${mostActive.count})`
      : "N/A";

  const topNftSaleLine = (() => {
    if (!topNftSale) return "N/A";
    const cshort = labelContract(topNftSale.contract);
    const t = topNftSale.token_id != null ? `#${topNftSale.token_id}` : "";
    const eth = fmtEth(topNftSale.amount_eth, 4);
    const usd = num(topNftSale.amount_usd, 0) > 0 ? `$${fmtMoney(topNftSale.amount_usd, 2)}` : "";
    const chain = topNftSale.chain ? `(${topNftSale.chain})` : "";
    const who = topNftSale.buyer ? `→ ${padWho(labelWho(topNftSale.buyer), 20)}` : "";
    return `${cshort} ${t} ${chain} — ${eth} ETH ${usd ? `(${usd})` : ""} ${who}`
      .replace(/\s+/g, " ")
      .trim();
  })();

  const topSwapLine = (() => {
    if (!topSwapRow) return "N/A";
    const cshort = labelContract(topSwapRow.contract);
    const eth = num(topSwapRow.amount_eth, 0) > 0 ? `${fmtEth(topSwapRow.amount_eth, 4)} ETH` : "";
    const usd = num(topSwapRow.amount_usd, 0) > 0 ? `$${fmtMoney(topSwapRow.amount_usd, 2)}` : "";
    const chain = topSwapRow.chain ? `(${topSwapRow.chain})` : "";
    const who = topSwapRow.buyer
      ? `buyer:${padWho(labelWho(topSwapRow.buyer), 14)}`
      : topSwapRow.seller
        ? `seller:${padWho(labelWho(topSwapRow.seller), 14)}`
        : "";
    return `${cshort} ${chain} — ${eth} ${usd ? `(${usd})` : ""} ${who}`
      .replace(/\s+/g, " ")
      .trim();
  })();

  const topTokenTradeLine = (() => {
    if (!topTokenTradeRow) return "N/A";
    const cshort = labelContract(topTokenTradeRow.contract);
    const eth = num(topTokenTradeRow.amount_eth, 0) > 0 ? `${fmtEth(topTokenTradeRow.amount_eth, 4)} ETH` : "";
    const usd = num(topTokenTradeRow.amount_usd, 0) > 0 ? `$${fmtMoney(topTokenTradeRow.amount_usd, 2)}` : "";
    const chain = topTokenTradeRow.chain ? `(${topTokenTradeRow.chain})` : "";
    const typ = String(topTokenTradeRow.event_type || "").toLowerCase();
    const tag = typ === "token_buy" ? "BUY" : typ === "token_sell" ? "SELL" : typ.toUpperCase() || "TOKEN";
    const who = topTokenTradeRow.buyer
      ? `buyer:${padWho(labelWho(topTokenTradeRow.buyer), 14)}`
      : topTokenTradeRow.seller
        ? `seller:${padWho(labelWho(topTokenTradeRow.seller), 14)}`
        : "";
    return `${tag} • ${cshort} ${chain} — ${eth} ${usd ? `(${usd})` : ""} ${who}`
      .replace(/\s+/g, " ")
      .trim();
  })();

  const volumeLine = `**${fmtEth(totalVolEth, 4)} ETH**${
    num(totalVolUsd, 0) > 0 ? `\n~ **$${fmtMoney(totalVolUsd, 2)}**` : ""
  }`.trim();

  const breakdownLine = [
    `NFT: ${fmtEth(nftVolEth, 4)} ETH${nftVolUsd > 0 ? ` (~$${fmtMoney(nftVolUsd, 2)})` : ""}`,
    `Swaps: ${fmtEth(swapVolEth, 4)} ETH${swapVolUsd > 0 ? ` (~$${fmtMoney(swapVolUsd, 2)})` : ""}`,
    `Tokens: ${fmtEth(tokenVolEth, 4)} ETH${tokenVolUsd > 0 ? ` (~$${fmtMoney(tokenVolUsd, 2)})` : ""}`,
  ].join("\n");

  const sched =
    settings && (settings.hour != null || settings.minute != null || settings.tz)
      ? `\n⏰ Scheduled: **${pad2(settings.hour ?? 0)}:${pad2(settings.minute ?? 0)}**`
      : "";

  const embed = new EmbedBuilder()
    .setColor("#00b894")
    .setTitle(`📊 Daily Digest — ${safeStr(guildName, 60)}`)
    .setDescription(`Last **${hours}h** recap.${sched}`.trim())
    .addFields(
      { name: "Mints", value: `**${totalMints.toLocaleString()}**`, inline: true },
      { name: "NFT Sales", value: `**${totalNftSales.toLocaleString()}**`, inline: true },
      { name: "Swaps", value: `**${totalSwaps.toLocaleString()}**`, inline: true },

      { name: "Token Buys", value: `**${totalTokenBuys.toLocaleString()}**`, inline: true },
      { name: "Token Sells", value: `**${totalTokenSells.toLocaleString()}**`, inline: true },
      { name: "Chains", value: chainLine || "N/A", inline: true },

      { name: "Total Volume", value: volumeLine, inline: true },
      { name: "Breakdown", value: breakdownLine.slice(0, 1024) || "N/A", inline: true },
      { name: "Most Active", value: activeContract, inline: true },

      { name: "Top NFT Sale", value: topNftSaleLine || "N/A", inline: false },
      { name: "Top Swap", value: topSwapLine || "N/A", inline: false },
      { name: "Top Token Trade", value: topTokenTradeLine || "N/A", inline: false }
    )
    .setFooter({
      text: hadQueryError
        ? "MB Digest • (warning: digest query error)"
        : "MB Digest • powered by your tracker logs",
    })
    .setTimestamp(new Date());

  const recentNftSales = rows
    .filter(
      (r) =>
        String(r.event_type || "").toLowerCase() === "sale" &&
        r.token_id != null &&
        String(r.token_id).trim() !== ""
    )
    .slice(0, 5)
    .map((r) => {
      const cshort = labelContract(r.contract);
      const tid = r.token_id != null ? `#${r.token_id}` : "";
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      const who = r.buyer ? `→ ${padWho(labelWho(r.buyer), 18)}` : "";
      return `• ${cshort} ${tid} ${chain} ${eth} ${usd ? `(${usd})` : ""} ${who}`.replace(/\s+/g, " ").trim();
    });

  if (recentNftSales.length) {
    embed.addFields({ name: "Recent NFT Sales", value: recentNftSales.join("\n").slice(0, 1024) });
  }

  const recentSwaps = rows
    .filter(
      (r) =>
        String(r.event_type || "").toLowerCase() === "sale" &&
        (r.token_id == null || String(r.token_id).trim() === "")
    )
    .slice(0, 5)
    .map((r) => {
      const cshort = labelContract(r.contract);
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      const who = r.buyer
        ? `buyer:${padWho(labelWho(r.buyer), 14)}`
        : r.seller
          ? `seller:${padWho(labelWho(r.seller), 14)}`
          : "";
      return `• ${cshort} ${chain} ${eth} ${usd ? `(${usd})` : ""} ${who}`.replace(/\s+/g, " ").trim();
    });

  if (recentSwaps.length) {
    embed.addFields({ name: "Recent Swaps", value: recentSwaps.join("\n").slice(0, 1024) });
  }

  const recentTokenTrades = rows
    .filter((r) => {
      const t = String(r.event_type || "").toLowerCase();
      return t === "token_buy" || t === "token_sell";
    })
    .slice(0, 5)
    .map((r) => {
      const t = String(r.event_type || "").toLowerCase();
      const tag = t === "token_buy" ? "BUY" : t === "token_sell" ? "SELL" : t.toUpperCase();
      const cshort = labelContract(r.contract);
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      const who = r.buyer
        ? `buyer:${padWho(labelWho(r.buyer), 14)}`
        : r.seller
          ? `seller:${padWho(labelWho(r.seller), 14)}`
          : "";
      return `• ${tag} ${cshort} ${chain} ${eth} ${usd ? `(${usd})` : ""} ${who}`.replace(/\s+/g, " ").trim();
    });

  if (recentTokenTrades.length) {
    embed.addFields({ name: "Recent Token Trades", value: recentTokenTrades.join("\n").slice(0, 1024) });
  }

  const DIGEST_DEBUG = String(process.env.DAILY_DIGEST_DEBUG || "").trim() === "1";
  if (DIGEST_DEBUG) {
    const typeLine = [...byType.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([k, v]) => `${k}:${v}`)
      .join(" • ");

    const newestLine = newestTs ? newestTs.toISOString() : "N/A";
    const oldestLine = oldestTs ? oldestTs.toISOString() : "N/A";

    embed.addFields({
      name: "Debug",
      value: [
        `types: ${typeLine || "N/A"}`,
        `newest: ${newestLine}`,
        `oldest: ${oldestLine}`,
        `rows: ${rows?.length || 0} (cap=${MAX_ROWS})`,
        `ensure_ok: ${_ensureOk ? "yes" : "no"}`,
      ].join("\n").slice(0, 1024),
      inline: false,
    });
  }

  return embed;
}

/* ===================== MAIN ===================== */

async function generateDailyDigest({ pg, guild, settings, hours = 24 }) {
  // Optional hard disable (scheduler can still call; it will return a small embed)
  const ENABLE_DAILY_DIGEST = String(process.env.ENABLE_DAILY_DIGEST ?? "1").trim() === "1";
  if (!ENABLE_DAILY_DIGEST) {
    return new EmbedBuilder()
      .setColor("#636e72")
      .setTitle(`📊 Daily Digest — ${safeStr(guild?.name || "Server", 60)}`)
      .setDescription("Daily Digest is currently disabled by `ENABLE_DAILY_DIGEST=0`.")
      .setTimestamp(new Date());
  }

  let rows = [];
  let hadQueryError = false;

  try {
    rows = await fetchDigestWindow(pg, guild.id, hours);
  } catch (e) {
    hadQueryError = true;
    rows = [];
  }

  const stats = computeDigestStats(rows);

  return buildDigestEmbed({
    guildName: guild.name,
    hours,
    stats,
    rows,
    settings,
    hadQueryError,
  });
}

module.exports = {
  generateDailyDigest,
  ensureDigestEventsTable,
  fetchDigestWindow,
  computeDigestStats,
  buildDigestEmbed,
};
