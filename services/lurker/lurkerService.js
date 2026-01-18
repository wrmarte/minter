// services/lurker/lurkerService.js
// ======================================================
// LURKER: Background poller
// FIXES:
// - Always fetch newest page (NO continuation/cursor for live polling)
// - Uses lurker_seen for dedupe (already in DB)
// - If rarityRank missing, fetch token rarity (rate-limited) before filtering
// - Throttles repeated errors (prevents log spam)
// ======================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { ensureLurkerSchema } = require("./schema");

const {
  fetchListings: reservoirFetchListings,
  fetchTokenRarity: reservoirFetchTokenRarity
} = require("./sources/reservoir");

const LURKER_COLOR = 0x00c853; // emerald

// Error throttling per rule
const RULE_ERR_STATE = new Map(); // ruleId -> { lastLogMs, count }

// Rate limit token rarity lookups (avoid hammering)
let rarityLookupsThisTick = 0;

function jparse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function traitsMatch(ruleTraits, nftTraits) {
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
  const url = listing.openseaUrl || null;

  const embed = new EmbedBuilder()
    .setColor(LURKER_COLOR)
    .setTitle(title)
    .setDescription(
      [
        `**Chain:** \`${listing.chain}\``,
        `**Contract:** \`${listing.contract}\``,
        listing.name ? `**Name:** ${listing.name}` : null,
        listing.priceNative != null ? `**Price:** ${listing.priceNative} ${listing.priceCurrency || ""}`.trim() : null,
        listing.rarityRank != null ? `**Rarity Rank:** **${listing.rarityRank}**` : `**Rarity Rank:** \`N/A\``,
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

async function fetchFromSource(rule) {
  const source = String(process.env.LURKER_SOURCE || "reservoir").toLowerCase();
  if (source === "reservoir") {
    return reservoirFetchListings({
      chain: rule.chain,
      contract: rule.contract,
      limit: 20,
    });
  }
  return { listings: [] };
}

function throttleRuleError(ruleId, err) {
  const now = Date.now();
  const st = RULE_ERR_STATE.get(ruleId) || { lastLogMs: 0, count: 0 };
  st.count += 1;

  if (now - st.lastLogMs > 60000) {
    st.lastLogMs = now;
    const msg = err?.message || String(err || "unknown error");
    console.log(`[LURKER] rule#${ruleId} error (x${st.count}): ${msg}`);
    st.count = 0;
  }

  RULE_ERR_STATE.set(ruleId, st);
}

async function ensureRarityIfNeeded(rule, listing) {
  const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
  if (!rarityMax || !Number.isFinite(rarityMax)) return listing;

  if (listing.rarityRank != null) return listing;

  // Rate limit these lookups hard
  const maxPerTick = Number(process.env.LURKER_RARITY_LOOKUPS_PER_TICK || 5);
  if (rarityLookupsThisTick >= maxPerTick) return listing;

  try {
    rarityLookupsThisTick += 1;
    const rank = await reservoirFetchTokenRarity({
      chain: listing.chain,
      contract: listing.contract,
      tokenId: listing.tokenId
    });
    if (rank != null) listing.rarityRank = rank;
  } catch {
    // ignore
  }

  return listing;
}

async function processRule(client, rule, debug) {
  const { listings } = await fetchFromSource(rule);

  if (debug) {
    console.log(`[LURKER] rule#${rule.id} chain=${rule.chain} contract=${String(rule.contract).slice(0, 10)}.. listings=${listings.length}`);
  }

  for (const listing of listings) {
    if (await isSeen(client, rule.id, listing.listingId)) continue;

    // Mark as seen ONLY after we evaluate it (so we don't lose it before rarity fallback)
    let evaluated = listing;

    // If rarity rank missing but rule needs it, fetch it (rate-limited)
    evaluated = await ensureRarityIfNeeded(rule, evaluated);

    const ruleTraits = jparse(rule.traits_json || "", null);
    const traitHit = traitsMatch(ruleTraits, evaluated.traits);

    const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
    const rank = evaluated.rarityRank != null ? Number(evaluated.rarityRank) : null;
    const rarityHit = (rarityMax != null && rank != null && rank <= rarityMax);

    if (!passesFilters(rule, evaluated)) {
      await markSeen(client, rule.id, evaluated.listingId);
      continue;
    }

    const why = rarityHit
      ? `Rarity rank **${rank}** ≤ **${rarityMax}**`
      : `Trait match (${Object.keys(ruleTraits || {}).length} configured)`;

    await postAlert(client, rule, evaluated, why);
    await markSeen(client, rule.id, evaluated.listingId);
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
    rarityLookupsThisTick = 0;

    try {
      const rules = await getEnabledRules(client);
      if (debug) console.log(`[LURKER] rules enabled=${rules.length}`);

      for (const r of rules) {
        try {
          await processRule(client, r, debug);
        } catch (e) {
          throttleRuleError(r.id, e);
        }
      }
    } catch (e) {
      console.log("[LURKER] tick error:", e?.message || e);
    } finally {
      running = false;
    }
  };

  setTimeout(tick, 2500);
  setInterval(tick, pollMs);
}

module.exports = { startLurker };

