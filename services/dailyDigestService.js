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

function titleCase(s) {
  return String(s || "")
    .split(" ")
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ""))
    .join(" ")
    .trim();
}

async function fetchDigestWindow(pg, guildId, hours = 24) {
  const q = `
    SELECT *
    FROM digest_events
    WHERE guild_id = $1
      AND ts >= NOW() - ($2::text || ' hours')::interval
    ORDER BY ts DESC
  `;
  const r = await pg.query(q, [String(guildId), String(hours)]);
  return r.rows || [];
}

function computeDigestStats(rows) {
  const mints = rows.filter(r => r.event_type === "mint");
  const sales = rows.filter(r => r.event_type === "sale");

  const sum = (arr, key) => arr.reduce((a, r) => a + num(r[key], 0), 0);

  const totalMints = mints.length;
  const totalSales = sales.length;

  const totalSalesEth = sum(sales, "amount_eth");
  const totalSalesUsd = sum(sales, "amount_usd");

  // most active contract by count (mints + sales)
  const byContract = new Map();
  for (const r of rows) {
    const c = (r.contract || "").toLowerCase() || "unknown";
    byContract.set(c, (byContract.get(c) || 0) + 1);
  }
  let mostActive = { contract: "", count: 0 };
  for (const [contract, count] of byContract.entries()) {
    if (count > mostActive.count) mostActive = { contract, count };
  }

  // top sale by ETH
  let topSale = null;
  for (const r of sales) {
    const v = num(r.amount_eth, 0);
    if (!topSale || v > num(topSale.amount_eth, 0)) topSale = r;
  }

  // chains breakdown
  const byChain = new Map();
  for (const r of rows) {
    const ch = (r.chain || "unknown").toLowerCase();
    byChain.set(ch, (byChain.get(ch) || 0) + 1);
  }

  return {
    totalMints,
    totalSales,
    totalSalesEth,
    totalSalesUsd,
    mostActive,
    topSale,
    byChain,
  };
}

function buildDigestEmbed({
  guildName,
  hours,
  stats,
  rows,
  settings,
}) {
  const { totalMints, totalSales, totalSalesEth, totalSalesUsd, mostActive, topSale, byChain } = stats;

  const chainLine = [...byChain.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, v]) => `${k}:${v}`)
    .join(" • ");

  const activeContract = mostActive.contract && mostActive.contract !== "unknown"
    ? `${mostActive.contract.slice(0, 6)}…${mostActive.contract.slice(-4)} (${mostActive.count})`
    : "N/A";

  const topSaleLine = (() => {
    if (!topSale) return "N/A";
    const c = (topSale.contract || "").toLowerCase();
    const t = topSale.token_id != null ? `#${topSale.token_id}` : "";
    const eth = fmtEth(topSale.amount_eth, 4);
    const usd = num(topSale.amount_usd, 0) > 0 ? `$${fmtMoney(topSale.amount_usd, 2)}` : "";
    const chain = topSale.chain ? `(${topSale.chain})` : "";
    const who = topSale.buyer ? `→ ${safeStr(topSale.buyer, 20)}` : "";
    const cshort = c ? `${c.slice(0, 6)}…${c.slice(-4)}` : "unknown";
    return `${cshort} ${t} ${chain} — ${eth} ETH ${usd ? `(${usd})` : ""} ${who}`.trim();
  })();

  const embed = new EmbedBuilder()
    .setColor("#00b894")
    .setTitle(`📊 Daily Digest — ${safeStr(guildName, 60)}`)
    .setDescription(`Last **${hours}h** recap. ${settings?.tz ? `Timezone: **${settings.tz}**` : ""}`.trim())
    .addFields(
      { name: "Mints", value: `**${totalMints.toLocaleString()}**`, inline: true },
      { name: "Sales", value: `**${totalSales.toLocaleString()}**`, inline: true },
      { name: "Volume", value: `**${fmtEth(totalSalesEth, 4)} ETH**\n${num(totalSalesUsd, 0) > 0 ? `~ **$${fmtMoney(totalSalesUsd, 2)}**` : ""}`.trim(), inline: true },
      { name: "Most Active", value: activeContract, inline: false },
      { name: "Top Sale", value: topSaleLine, inline: false },
      { name: "Chains", value: chainLine || "N/A", inline: false }
    )
    .setFooter({ text: "MB Digest • powered by your tracker logs" })
    .setTimestamp(new Date());

  // Add “recent highlights” (last 5 sales)
  const recentSales = rows
    .filter(r => r.event_type === "sale")
    .slice(0, 5)
    .map(r => {
      const c = (r.contract || "").toLowerCase();
      const cshort = c ? `${c.slice(0, 6)}…${c.slice(-4)}` : "unknown";
      const tid = r.token_id != null ? `#${r.token_id}` : "";
      const eth = num(r.amount_eth, 0) > 0 ? `${fmtEth(r.amount_eth, 4)} ETH` : "";
      const usd = num(r.amount_usd, 0) > 0 ? `$${fmtMoney(r.amount_usd, 2)}` : "";
      const chain = r.chain ? `(${r.chain})` : "";
      return `• ${cshort} ${tid} ${chain} ${eth} ${usd ? `(${usd})` : ""}`.replace(/\s+/g, " ").trim();
    });

  if (recentSales.length) {
    embed.addFields({ name: "Recent Sales", value: recentSales.join("\n").slice(0, 1024) });
  }

  return embed;
}

async function generateDailyDigest({ pg, guild, settings, hours = 24 }) {
  const rows = await fetchDigestWindow(pg, guild.id, hours);
  const stats = computeDigestStats(rows);

  return buildDigestEmbed({
    guildName: guild.name,
    hours,
    stats,
    rows,
    settings,
  });
}

module.exports = {
  generateDailyDigest,
};
