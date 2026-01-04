// services/dailyDigestService.js
const { EmbedBuilder } = require("discord.js");

function num(n, d = 0) {
  const x = Number(n);
  return Number.isFinite(x) ? x : d;
}

function fmtMoney(n, decimals = 2) {
  const x = num(n, 0);
  return x.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtEth(n, decimals = 4) {
  const x = num(n, 0);
  return x.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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

/* ===================== TABLE ENSURE (FIX) ===================== */

const DIGEST_EVENTS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS digest_events (
  id            BIGSERIAL PRIMARY KEY,
  guild_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL, -- 'mint' | 'sale'
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

async function ensureDigestEventsTable(pg) {
  if (!pg?.query) return false;
  try {
    await pg.query(DIGEST_EVENTS_TABLE_SQL);
    return true;
  } catch (e) {
    console.warn("[DAILY_DIGEST] failed to ensure digest_events table:", e?.message || e);
    return false;
  }
}

/* ===================== FETCH WINDOW ===================== */

async function fetchDigestWindow(pg, guildId, hours = 24) {
  await ensureDigestEventsTable(pg);

  const q = `
    SELECT *
    FROM digest_events
    WHERE guild_id = $1
      AND ts >= NOW() - ($2::text || ' hours')::interval
    ORDER BY ts DESC
  `;

  try {
    const r = await pg.query(q, [String(guildId), String(hours)]);
    return r.rows || [];
  } catch (e) {
    console.warn("[DAILY_DIGEST] fetchDigestWindow failed:", e?.message || e);
    return [];
  }
}

/* ===================== STATS ===================== */

function computeDigestStats(rows) {
  const mints = rows.filter(r => r.event_type === "mint");

  // sale split:
  // - NFT Sales = sale + token_id present
  // - Swaps = sale + token_id empty (how swaps were logged)
  const salesAll = rows.filter(r => r.event_type === "sale");
  const nftSales = salesAll.filter(r => r.token_id != null && String(r.token_id).trim() !== "");
  const swaps = salesAll.filter(r => r.token_id == null || String(r.token_id).trim() === "");

  const sum = (arr, key) => arr.reduce((a, r) => a + num(r[key], 0), 0);

  const totalMints = mints.length;
  const totalNftSales = nftSales.length;
  const totalSwaps = swaps.length;

  const nftVolEth = sum(nftSales, "amount_eth");
  const nftVolUsd = sum(nftSales, "amount_usd");

  const swapVolEth = sum(swaps, "amount_eth");
  const swapVolUsd = sum(swaps, "amount_usd");

  const totalVolEth = nftVolEth + swapVolEth;
  const totalVolUsd = nftVolUsd + swapVolUsd;

  const byContract = new Map();
  for (const r of rows) {
    const c = (r.contract || "").toLowerCase() || "unknown";
    byContract.set(c, (byContract.get(c) || 0) + 1);
  }
  let mostActive = { contract: "", count: 0 };
  for (const [contract, count] of byContract.entries()) {
    if (count > mostActive.count) mostActive = { contract, count };
  }

  let topNftSale = null;
  for (const r of nftSales) {
    const v = num(r.amount_eth, 0);
    if (!topNftSale || v > num(topNftSale.amount_eth, 0)) topNftSale = r;
  }

  let topSwap = null;
  for (const r of swaps) {
    const u = num(r.amount_usd, 0);
    const e = num(r.amount_eth, 0);
    const score = u > 0 ? u : e;
    if (!topSwap) topSwap = { row: r, score };
    else if (score > (topSwap.score || 0)) topSwap = { row: r, score };
  }

  const byChain = new Map();
  for (const r of rows) {
    const ch = (r.chain || "unknown").toLowerCase();
    byChain.set(ch, (byChain.get(ch) || 0) + 1);
  }

  return {
    totalMints,
    totalNftSales,
    totalSwaps,
    nftVolEth,
    nftVolUsd,
    swapVolEth,
    swapVolUsd,
    totalVolEth,
    totalVolUsd,
    mostActive,
    topNftSale,
    topSwapRow: topSwap?.row || null,
    byChain,
  };
}

/* ===================== EMBED BUILD ===================== */

function buildDigestEmbed({ guildName, hours, stats, rows, settings, hadQueryError = false }) {
  const {
    totalMints,
    totalNftSales,
    totalSwaps,
    nftVolEth,
    nftVolUsd,
    swapVolEth,
    swapVolUsd,
    totalVolEth,
    totalVolUsd,
    mostActive,
    topNftSale,
    topSwapRow,
    byChain
  } = stats;

  const chainLine = [...byChain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join(" • ");

  const activeContract = mostActive.contract && mostActive.contract !== "unknown"
    ? `${padAddr(mostActive.contract)} (${mostActive.count})`
    : "N/A";

  const topNftSaleLine = (() => {
    if (!topNftSale) return "N/A";
    const cshort = padAddr(topNftSale.contract);
    const t = topNftSale.token_id != null ? `#${topNftSale.token_id}` : "";
    const eth = fmtEth(topNftSale.amount_eth, 4);
    const usd = num(topNftSale.amount_usd, 0) > 0 ? `$${fmtMoney(topNftSale.amount_usd, 2)}` : "";
    const chain = topNftSale.chain ? `(${topNftSale.chain})` : "";
    const who = topNftSale.buyer ? `→ ${padWho(topNftSale.buyer, 20)}` : "";
    return `${cshort} ${t} ${chain} — ${eth} ETH ${usd ? `(${usd})` : ""} ${who}`.replace(/\s+/g, " ").trim();
  })();

  const topSwapLine = (() => {
    if (!topSwapRow) return "N/A";
    const cshort = padAddr(topSwapRow.contract);
    const eth = num(topSwapRow.amount_eth, 0) > 0 ? `${fmtEth(topSwapRow.amount_eth, 4)} ETH` : "";
    const usd = num(topSwapRow.amount_usd, 0) > 0 ? `$${fmtMoney(topSwapRow.amount_usd, 2)}` : "";
    const chain = topSwapRow.chain ? `(${topSwapRow.chain})` : "";
    const who = topSwapRow.buyer ? `buyer:${padWho(topSwapRow.buyer, 14)}` : (topSwapRow.seller ? `seller:${padWho(topSwapRow.seller, 14)}` : "");
    return `${cshort} ${chain} — ${eth} ${usd ? `(${usd})` : ""} ${who}`.replace(/\s+/g, " ").trim();
  })();

  const volumeLine = `**${fmtEth(totalVolEth, 4)} ETH**${
    num(totalVolUsd, 0) > 0 ? `\n~ **$${fmtMoney(totalVolUsd, 2)}**` : ""
  }`.trim();

  const breakdownLine = [
    `NFT: ${fmtEth(nftVolEth, 4)} ETH${nftVolUsd > 0 ? ` (~$${fmtMoney(nftVolUsd, 2)})` : ""}`,
    `Swaps: ${fmtEth(swapVolEth, 4)} ETH${swapVolUsd > 0 ? ` (~$${fmtMoney(swapVolUsd, 2)})` : ""}`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setColor("#00b894")
    .setTitle(`📊 Daily Digest — ${safeStr(guildName, 60)}`)
    .setDescription(
      `Last **${hours}h** recap.${settings?.tz ? ` Timezone: **${settings.tz}**` : ""}`.trim()
    )
    .addFields(
      { name: "Mints", value: `**${totalMints.toLocaleString()}**`, inline: true },
      { name: "NFT Sales", value: `**${totalNftSales.toLocaleString()}**`, inline: true },
      { name: "Swaps", value: `**${totalSwaps.toLocaleString()}**`, inline: true },

      { name: "Total Volume", value: volumeLine, inline: true },
      { name: "Breakdown", value: breakdownLine.slice(0, 1024) || "N/A", inline: true },
      { name: "Chains", value: chainLine || "N/A", inline: true },

      { name: "Most Active", value: activeContract, inline: false },
      { name: "Top NFT Sale", value: topNftSaleLine || "N/A", inline: false },
      { name: "Top Swap", value: topSwapLine || "N/A", inline: false },
    )
    .setFooter({ text: hadQueryError ? "MB Digest • (warning: digest query error)" : "MB Digest • powered by your tracker logs" })
    .setTimestamp(new Date());

  const recentNftSales = rows
    .filter(r => r.event_type === "sale" && r.token_id != null && String(r.token_id).trim() !== "")
    .slice(0, 5)
    .map(r => {
      const cshort = padAddr(r.contract);
      const tid = r.token_id != null ? `#${r.token_id}` : "";
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      return `• ${cshort} ${tid} ${chain} ${eth} ${usd ? `(${usd})` : ""}`.replace(/\s+/g, " ").trim();
    });

  if (recentNftSales.length) {
    embed.addFields({ name: "Recent NFT Sales", value: recentNftSales.join("\n").slice(0, 1024) });
  }

  const recentSwaps = rows
    .filter(r => r.event_type === "sale" && (r.token_id == null || String(r.token_id).trim() === ""))
    .slice(0, 5)
    .map(r => {
      const cshort = padAddr(r.contract);
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      return `• ${cshort} ${chain} ${eth} ${usd ? `(${usd})` : ""}`.replace(/\s+/g, " ").trim();
    });

  if (recentSwaps.length) {
    embed.addFields({ name: "Recent Swaps", value: recentSwaps.join("\n").slice(0, 1024) });
  }

  return embed;
}

/* ===================== MAIN ===================== */

async function generateDailyDigest({ pg, guild, settings, hours = 24 }) {
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
  // main
  generateDailyDigest,

  // exported helpers (for scheduler + debugging)
  ensureDigestEventsTable,
  fetchDigestWindow,
  computeDigestStats,
  buildDigestEmbed,
};

