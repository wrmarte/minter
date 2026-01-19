// services/lurker/lurkerService.js
// ======================================================
// LURKER: Background poller (OpenSea + Moralis + Local Rarity)
// FIXES/UPGRADES:
// - OpenSea v2 feed via opensea_slug when present
// - Traits: Moralis token metadata fetch (reliable)
// - Rarity: local OpenRarity-style build + DB rank/score
// - Starts rarity builder automatically
// - Throttles errors per rule (prevents spam)
// - NEW: per-tick metadata cache to prevent duplicate Moralis calls
// ======================================================

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { ensureLurkerSchema } = require("./schema");

const { fetchListings: openseaFetchListings } = require("./sources/opensea");
const { fetchTokenMetadata } = require("./metadata/moralis");

const { startRarityBuilder } = require("./rarity/rarityBuilder");
const { getTokenRarity, getBuildStatus } = require("./rarity/rarityEngine");

const LURKER_COLOR = 0x00c853; // emerald

// Error throttling per rule
const RULE_ERR_STATE = new Map(); // ruleId -> { lastLogMs, count }

// Rate limit Moralis token metadata fetches per tick
let metadataLookupsThisTick = 0;

// Per-tick metadata cache: key = chain:contract:tokenId -> {name,image,traits}
let META_CACHE = new Map();

function jparse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function s(v) {
  return String(v || "").trim();
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function debugOn() {
  return String(process.env.LURKER_DEBUG || "0").trim() === "1";
}

function chainNorm(v) {
  return s(v).toLowerCase();
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

  const rarityHit =
    (rarityMax != null &&
      Number.isFinite(rarityMax) &&
      rank != null &&
      Number.isFinite(rank) &&
      rank <= rarityMax);

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

  const rarityLine =
    listing.rarityRank != null
      ? `**Rarity Rank:** **${listing.rarityRank}**`
      : `**Rarity Rank:** \`building\``;

  const scoreLine =
    listing.rarityScore != null
      ? `**Rarity Score:** \`${Number(listing.rarityScore).toFixed(2)}\``
      : null;

  const embed = new EmbedBuilder()
    .setColor(LURKER_COLOR)
    .setTitle(title)
    .setDescription(
      [
        `**Chain:** \`${listing.chain}\``,
        `**Contract:** \`${listing.contract}\``,
        listing.name ? `**Name:** ${listing.name}` : null,
        listing.priceNative != null ? `**Price:** ${listing.priceNative} ${listing.priceCurrency || ""}`.trim() : null,
        rarityLine,
        scoreLine,
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
  // We pick source per-env, but OpenSea v2 uses opensea_slug when present.
  const source = String(process.env.LURKER_SOURCE || "opensea").toLowerCase();
  if (source === "opensea") {
    return openseaFetchListings({
      chain: rule.chain,
      contract: rule.contract,
      openseaSlug: rule.opensea_slug || null,
      limit: 25,
    });
  }
  // default to opensea
  return openseaFetchListings({
    chain: rule.chain,
    contract: rule.contract,
    openseaSlug: rule.opensea_slug || null,
    limit: 25,
  });
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

async function ensureTraitsIfNeeded(rule, listing) {
  // Only fetch traits if:
  // - rule has traits filter OR rule has rarity_max (rarity requires traits in our system)
  const hasRuleTraits = Boolean((rule.traits_json || "").trim());
  const needsRarity = rule.rarity_max != null;

  if (!hasRuleTraits && !needsRarity) return listing;
  if (listing?.traits && Object.keys(listing.traits).length) return listing;

  const maxPerTick = Number(process.env.LURKER_METADATA_LOOKUPS_PER_TICK || 8);
  if (metadataLookupsThisTick >= maxPerTick) return listing;

  const cacheKey = `${chainNorm(listing.chain)}:${s(listing.contract).toLowerCase()}:${s(listing.tokenId)}`;
  const cached = META_CACHE.get(cacheKey);
  if (cached) {
    if (!listing.traits || !Object.keys(listing.traits).length) listing.traits = cached.traits || listing.traits;
    if (!listing.name && cached.name) listing.name = cached.name;
    if (!listing.image && cached.image) listing.image = cached.image;
    return listing;
  }

  try {
    metadataLookupsThisTick += 1;
    const md = await fetchTokenMetadata({
      chain: listing.chain,
      contract: listing.contract,
      tokenId: listing.tokenId,
    });

    META_CACHE.set(cacheKey, md || {});

    if (md?.traits) listing.traits = md.traits;
    if (!listing.name && md?.name) listing.name = md.name;
    if (!listing.image && md?.image) listing.image = md.image;
  } catch (e) {
    if (debugOn()) console.log(`[LURKER][traits] fetch failed: ${e?.message || e}`);
  }

  return listing;
}

async function fillRarity(client, rule, listing) {
  const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
  if (!rarityMax || !Number.isFinite(rarityMax)) return listing;

  // Query DB
  const r = await getTokenRarity(client, {
    chain: listing.chain,
    contract: listing.contract,
    tokenId: listing.tokenId,
  });

  if (r.rank != null) listing.rarityRank = r.rank;
  if (r.score != null) listing.rarityScore = r.score;

  // Helpful debug if still missing
  if (listing.rarityRank == null && debugOn()) {
    const st = await getBuildStatus(client, { chain: listing.chain, contract: listing.contract });
    const status = st?.status || "unknown";
    const pc = st?.processed_count ?? 0;
    const err = st?.last_error ? ` err=${String(st.last_error).slice(0, 80)}` : "";
    console.log(`[LURKER][rarity] missing rank for ${listing.contract.slice(0, 10)}..#${listing.tokenId} | build=${status} processed=${pc}${err}`);
  }

  return listing;
}

async function processRule(client, rule, debug) {
  const out = await fetchFromSource(rule);
  const listings = Array.isArray(out?.listings) ? out.listings : [];

  if (debug) {
    console.log(
      `[LURKER] rule#${rule.id} src=${process.env.LURKER_SOURCE || "opensea"} chain=${rule.chain} contract=${String(rule.contract).slice(0, 10)}.. listings=${listings.length}${rule.opensea_slug ? ` os=${rule.opensea_slug}` : ""}`
    );
  }

  for (const listing of listings) {
    if (!listing?.listingId) continue;
    if (await isSeen(client, rule.id, listing.listingId)) continue;

    let evaluated = listing;
    evaluated.chain = chainNorm(evaluated.chain || rule.chain);
    evaluated.contract = s(evaluated.contract || rule.contract).toLowerCase();

    evaluated = await ensureTraitsIfNeeded(rule, evaluated);
    evaluated = await fillRarity(client, rule, evaluated);

    const ruleTraits = jparse(rule.traits_json || "", null);
    const traitHit = traitsMatch(ruleTraits, evaluated.traits);

    const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
    const rank = evaluated.rarityRank != null ? Number(evaluated.rarityRank) : null;
    const rarityHit = (rarityMax != null && rank != null && rank <= rarityMax);

    // If rule depends on rarity and we don't have rank yet, do NOT mark seen
    // (we want to catch it later once rarity builder finishes)
    if (rarityMax != null && rank == null && !traitHit) {
      if (debug) console.log(`[LURKER] rule#${rule.id} wait rarity build — listing=${evaluated.listingId}`);
      continue;
    }

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

  // Start background rarity builder
  try {
    startRarityBuilder(client);
  } catch (e) {
    console.warn("[LURKER] rarityBuilder failed to start:", e?.message || e);
  }

  console.log(`🟢 [LURKER] started pollMs=${pollMs}`);

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    // Reset per-tick counters & cache
    metadataLookupsThisTick = 0;
    META_CACHE = new Map();

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

