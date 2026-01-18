// services/lurker/lurkerService.js
// ======================================================
// LURKER: Background poller
// - Loads enabled rules from DB
// - Pulls listings from source adapter
// - Filters by rarity/traits/max price
// - Posts emerald alerts with Buy button
// ======================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { ensureLurkerSchema } = require("./schema");

const { fetchListings: reservoirFetchListings } = require("./sources/reservoir");

const LURKER_COLOR = 0x00c853; // emerald

function jparse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function traitsMatch(ruleTraits, nftTraits) {
  // ruleTraits: { "Hat": ["Beanie","Crown"], "Eyes": ["Laser"] }
  // nftTraits:  { "Hat": ["Beanie"], "Eyes": ["Normal"] }
  if (!ruleTraits || typeof ruleTraits !== "object") return false;

  for (const [k, wantedList] of Object.entries(ruleTraits)) {
    const wants = Array.isArray(wantedList) ? wantedList.map(x => String(x).toLowerCase()) : [];
    if (!wants.length) continue;

    const got = Array.isArray(nftTraits?.[k]) ? nftTraits[k].map(x => String(x).toLowerCase()) : [];
    for (const w of wants) {
      if (got.includes(w)) return true; // OR logic: any desired trait triggers
    }
  }
  return false;
}

function passesFilters(rule, listing) {
  const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
  const rank = listing.rarityRank != null ? Number(listing.rarityRank) : null;

  const ruleTraits = jparse(rule.traits_json || "", null);
  const traitHit = traitsMatch(ruleTraits, listing.traits);

  const rarityHit = (rarityMax != null && Number.isFinite(rarityMax) && rank != null && Number.isFinite(rank) && rank <= rarityMax);

  // If no rarity data exists from the source, rarityHit will be false — traits can still trigger.
  const allow = rarityHit || traitHit;
  if (!allow) return false;

  // Optional max price check (native)
  const maxPrice = rule.max_price_native ? numOrNull(rule.max_price_native) : null;
  const p = listing.priceNative != null ? numOrNull(listing.priceNative) : null;
  if (maxPrice != null && p != null && p > maxPrice) return false;

  return true;
}

async function postAlert(client, rule, listing, why) {
  const channelId = rule.channel_id || process.env.LURKER_DEFAULT_CHANNEL_ID;
  if (!channelId) return;

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return;

  const title = `🟢 LURKER HIT — ${listing.contract.slice(0, 6)}… #${listing.tokenId}`;
  const url = listing.openseaUrl || listing.externalUrl || null;

  const embed = new EmbedBuilder()
    .setColor(LURKER_COLOR)
    .setTitle(title)
    .setDescription(
      [
        `**Chain:** \`${listing.chain}\``,
        `**Contract:** \`${listing.contract}\``,
        listing.name ? `**Name:** ${listing.name}` : null,
        listing.priceNative != null ? `**Price:** ${listing.priceNative} ${listing.priceCurrency || ""}`.trim() : null,
        listing.rarityRank != null ? `**Rarity Rank:** **${listing.rarityRank}**` : `**Rarity Rank:** \`N/A\` (source didn’t return rank)`,
        `**Trigger:** ${why}`,
        url ? `**Link:** ${url}` : null,
      ].filter(Boolean).join("\n")
    )
    .setTimestamp(new Date());

  if (listing.image) embed.setThumbnail(listing.image);

  const buyBtn = new ButtonBuilder()
    .setCustomId(`lurker_buy:${rule.id}:${listing.listingId}`)
    .setLabel("Buy")
    .setStyle(ButtonStyle.Success);

  const ignoreBtn = new ButtonBuilder()
    .setCustomId(`lurker_ignore:${rule.id}:${listing.listingId}`)
    .setLabel("Ignore")
    .setStyle(ButtonStyle.Secondary);

  const row = new ActionRowBuilder().addComponents(buyBtn, ignoreBtn);

  await ch.send({ embeds: [embed], components: [row] }).catch(() => null);
}

async function getEnabledRules(client) {
  const ok = await ensureLurkerSchema(client);
  if (!ok) return [];
  const pg = client.pg;
  const res = await pg.query(
    `SELECT * FROM lurker_rules WHERE enabled = TRUE ORDER BY id DESC`
  );
  return res.rows || [];
}

async function getCursor(client, ruleId) {
  const pg = client.pg;
  const r = await pg.query(`SELECT cursor FROM lurker_checkpoints WHERE rule_id=$1`, [ruleId]);
  return r.rows?.[0]?.cursor || null;
}

async function setCursor(client, ruleId, cursor) {
  const pg = client.pg;
  await pg.query(
    `
    INSERT INTO lurker_checkpoints(rule_id, cursor, updated_at)
    VALUES($1, $2, NOW())
    ON CONFLICT (rule_id)
    DO UPDATE SET cursor=EXCLUDED.cursor, updated_at=NOW()
    `,
    [ruleId, cursor || null]
  );
}

async function markSeen(client, ruleId, listingId) {
  const pg = client.pg;
  await pg.query(
    `INSERT INTO lurker_seen(rule_id, listing_id) VALUES($1,$2) ON CONFLICT DO NOTHING`,
    [ruleId, listingId]
  );
}

async function isSeen(client, ruleId, listingId) {
  const pg = client.pg;
  const r = await pg.query(
    `SELECT 1 FROM lurker_seen WHERE rule_id=$1 AND listing_id=$2`,
    [ruleId, listingId]
  );
  return (r.rowCount || 0) > 0;
}

async function fetchFromSource(rule, cursor) {
  const source = String(process.env.LURKER_SOURCE || "reservoir").toLowerCase();
  if (source === "reservoir") {
    return reservoirFetchListings({
      chain: rule.chain,
      contract: rule.contract,
      cursor,
      limit: 20,
    });
  }
  // Future: opensea, magiceden, custom indexer
  return { listings: [], nextCursor: null };
}

async function processRule(client, rule) {
  const cursor = await getCursor(client, rule.id);
  const { listings, nextCursor } = await fetchFromSource(rule, cursor);

  for (const listing of listings) {
    if (await isSeen(client, rule.id, listing.listingId)) continue;

    const ruleTraits = jparse(rule.traits_json || "", null);
    const traitHit = traitsMatch(ruleTraits, listing.traits);

    const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
    const rank = listing.rarityRank != null ? Number(listing.rarityRank) : null;
    const rarityHit = (rarityMax != null && rank != null && rank <= rarityMax);

    if (!passesFilters(rule, listing)) {
      await markSeen(client, rule.id, listing.listingId);
      continue;
    }

    const why = rarityHit
      ? `Rarity rank **${rank}** ≤ **${rarityMax}**`
      : `Trait match (${Object.keys(ruleTraits || {}).length} configured)`;

    await postAlert(client, rule, listing, why);
    await markSeen(client, rule.id, listing.listingId);
  }

  if (nextCursor && nextCursor !== cursor) {
    await setCursor(client, rule.id, nextCursor);
  }
}

function startLurker(client) {
  const enabled = String(process.env.LURKER_ENABLED || "0").trim() === "1";
  if (!enabled) {
    console.log("🟢 [LURKER] disabled (LURKER_ENABLED!=1)");
    return;
  }

  const pollMs = Number(process.env.LURKER_POLL_MS || 15000);
  const debug = String(process.env.LURKER_DEBUG || "0").trim() === "1";

  if (client.__lurkerStarted) return;
  client.__lurkerStarted = true;

  console.log(`🟢 [LURKER] started pollMs=${pollMs}`);

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rules = await getEnabledRules(client);
      if (debug) console.log(`[LURKER] rules enabled=${rules.length}`);
      for (const r of rules) {
        try {
          await processRule(client, r);
        } catch (e) {
          console.log(`[LURKER] rule#${r.id} error:`, e?.message || e);
        }
      }
    } catch (e) {
      console.log("[LURKER] tick error:", e?.message || e);
    } finally {
      running = false;
    }
  };

  // run once soon, then interval
  setTimeout(tick, 2000);
  setInterval(tick, pollMs);
}

module.exports = { startLurker };
