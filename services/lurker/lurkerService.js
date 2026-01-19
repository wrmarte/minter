// services/lurker/lurkerService.js
// ======================================================
// LURKER: Background poller (OpenSea + Moralis + Local Rarity)
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

// Per-rule feed movement state (in-memory)
const RULE_FEED_STATE = new Map(); // ruleId -> { lastNewestId, lastNewestTsMs, sameNewestTicks, lastTickMs }

// Per-tick metadata rate limit
let metadataLookupsThisTick = 0;

// Per-tick metadata cache (fast)
let META_CACHE_TICK = new Map();

// Persistent metadata cache across ticks: key -> { tsMs, md }
const META_CACHE_PERSIST = new Map();

// Pending notified (in-memory): key = ruleId:listingId -> tsMs
const PENDING_NOTIFIED = new Map();

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

function chainNorm(v) {
  return s(v).toLowerCase();
}

function debugOn() {
  return String(process.env.LURKER_DEBUG || "0").trim() === "1";
}

function logSummaryOn() {
  const v = String(process.env.LURKER_LOG_SUMMARY || "").trim();
  if (v === "0") return false;
  return debugOn(); // default ON when debug=1
}

function logFeedOn() {
  const v = String(process.env.LURKER_LOG_FEED || "").trim();
  if (v === "0") return false;
  return debugOn(); // default ON when debug=1
}

function logAllUnseenOn() {
  return String(process.env.LURKER_LOG_ALL_UNSEEN || "0").trim() === "1";
}

function logWaitOn() {
  return String(process.env.LURKER_LOG_WAIT || "0").trim() === "1";
}

function dumpSampleOn() {
  return String(process.env.LURKER_DUMP_SAMPLE || "0").trim() === "1";
}

function pendingAlertOn() {
  return String(process.env.LURKER_PENDING_ALERT || "0").trim() === "1";
}

function staleWarnTicks() {
  const n = Number(process.env.LURKER_STALE_WARN_TICKS || 3);
  return Number.isFinite(n) && n > 0 ? n : 3;
}

function metaCacheTtlMs() {
  const n = Number(process.env.LURKER_META_CACHE_TTL_MS || (30 * 60 * 1000)); // default 30m
  return Number.isFinite(n) && n > 10_000 ? n : (30 * 60 * 1000);
}

function pendingTtlMs() {
  const n = Number(process.env.LURKER_PENDING_TTL_MS || (6 * 60 * 60 * 1000)); // default 6h
  return Number.isFinite(n) && n > 60_000 ? n : (6 * 60 * 60 * 1000);
}

// Try to extract a timestamp from unknown listing shapes
function extractTsMs(listing) {
  if (!listing || typeof listing !== "object") return null;

  const candidates = [
    listing.eventTimestamp,
    listing.event_timestamp,
    listing.timestamp,
    listing.createdAt,
    listing.created_at,
    listing.listedAt,
    listing.listed_at,
    listing.eventDate,
    listing.event_date,
    listing.time,
    listing.date,
  ];

  for (const c of candidates) {
    if (c == null) continue;

    if (typeof c === "number") {
      if (c > 1e12) return c;
      if (c > 1e9) return c * 1000;
    }

    if (typeof c === "string") {
      const t = Date.parse(c);
      if (!Number.isNaN(t)) return t;

      const n = Number(c);
      if (Number.isFinite(n)) {
        if (n > 1e12) return n;
        if (n > 1e9) return n * 1000;
      }
    }
  }

  return null;
}

function fmtTs(ms) {
  if (!ms || !Number.isFinite(ms)) return "n/a";
  try { return new Date(ms).toISOString(); } catch { return "n/a"; }
}

function traitsMatch(ruleTraits, nftTraits) {
  if (!ruleTraits || typeof ruleTraits !== "object") return false;

  for (const [k, wantedList] of Object.entries(ruleTraits)) {
    const wants = Array.isArray(wantedList) ? wantedList.map(x => String(x).toLowerCase()) : [];
    if (!wants.length) continue;

    const got = Array.isArray(nftTraits?.[k]) ? nftTraits[k].map(x => String(x).toLowerCase()) : [];
    for (const w of wants) {
      if (got.includes(w)) return true;
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

  const maxPrice = rule.max_price_native ? numOrNull(rule.max_price_native) : null;
  const p = listing.priceNative != null ? numOrNull(listing.priceNative) : null;
  if (maxPrice != null && p != null && p > maxPrice) return false;

  return true;
}

async function postAlert(client, rule, listing, why) {
  const channelId = rule.channel_id || process.env.LURKER_DEFAULT_CHANNEL_ID;
  if (!channelId) {
    if (debugOn()) console.warn(`[LURKER][post] rule#${rule.id} no channel_id and no LURKER_DEFAULT_CHANNEL_ID`);
    return false;
  }

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) {
    console.warn(`[LURKER][post] rule#${rule.id} failed to fetch channelId=${channelId}`);
    return false;
  }

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

  try {
    await ch.send({ embeds: [embed], components: [row] });
    return true;
  } catch (e) {
    console.warn(`[LURKER][post] send failed rule#${rule.id} channel=${channelId}: ${e?.message || e}`);
    return false;
  }
}

async function postPending(client, rule, listing) {
  const channelId = rule.channel_id || process.env.LURKER_DEFAULT_CHANNEL_ID;
  if (!channelId) return false;

  const ch = await client.channels.fetch(channelId).catch(() => null);
  if (!ch) return false;

  const embed = new EmbedBuilder()
    .setColor(0xffc107)
    .setTitle(`🟡 Listing detected — rarity building`)
    .setDescription(
      [
        `**Chain:** \`${listing.chain}\``,
        `**Contract:** \`${listing.contract}\``,
        `**Token:** #${listing.tokenId}`,
        listing.openseaUrl ? `**Link:** ${listing.openseaUrl}` : null,
        `**Note:** rarity ranks are still building for this collection. LURKER will re-check and alert if it becomes a hit.`,
      ].filter(Boolean).join("\n")
    )
    .setTimestamp(new Date());

  if (listing.image) embed.setThumbnail(listing.image);

  try {
    await ch.send({ embeds: [embed] });
    return true;
  } catch {
    return false;
  }
}

async function getEnabledRules(client) {
  const ok = await ensureLurkerSchema(client);
  if (!ok) return [];
  const pg = client.pg;
  const res = await pg.query(`SELECT * FROM lurker_rules WHERE enabled = TRUE ORDER BY id DESC`);
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
  const r = await pg.query(`SELECT 1 FROM lurker_seen WHERE rule_id=$1 AND listing_id=$2`, [ruleId, listingId]);
  return (r.rowCount || 0) > 0;
}

async function fetchFromSource(rule) {
  const source = String(process.env.LURKER_SOURCE || "opensea").toLowerCase();
  if (source === "opensea") {
    return openseaFetchListings({
      chain: rule.chain,
      contract: rule.contract,
      openseaSlug: rule.opensea_slug || null,
      limit: 25,
    });
  }
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

function getCachedMeta(cacheKey) {
  const now = Date.now();

  // tick cache
  const tick = META_CACHE_TICK.get(cacheKey);
  if (tick) return tick;

  // persistent cache
  const persisted = META_CACHE_PERSIST.get(cacheKey);
  if (persisted && (now - persisted.tsMs) <= metaCacheTtlMs()) {
    META_CACHE_TICK.set(cacheKey, persisted.md);
    return persisted.md;
  }

  // expired cleanup
  if (persisted) META_CACHE_PERSIST.delete(cacheKey);
  return null;
}

function setCachedMeta(cacheKey, md) {
  const now = Date.now();
  META_CACHE_TICK.set(cacheKey, md || {});
  META_CACHE_PERSIST.set(cacheKey, { tsMs: now, md: md || {} });
}

function gcPendingNotified() {
  const now = Date.now();
  const ttl = pendingTtlMs();
  for (const [k, ts] of PENDING_NOTIFIED.entries()) {
    if ((now - ts) > ttl) PENDING_NOTIFIED.delete(k);
  }
}

async function ensureTraitsIfNeeded(rule, listing) {
  const hasRuleTraits = Boolean((rule.traits_json || "").trim());
  const needsRarity = rule.rarity_max != null;

  if (!hasRuleTraits && !needsRarity) return listing;
  if (listing?.traits && Object.keys(listing.traits).length) return listing;

  const maxPerTick = Number(process.env.LURKER_METADATA_LOOKUPS_PER_TICK || 8);
  if (metadataLookupsThisTick >= maxPerTick) return listing;

  const cacheKey = `${chainNorm(listing.chain)}:${s(listing.contract).toLowerCase()}:${s(listing.tokenId)}`;
  const cached = getCachedMeta(cacheKey);
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

    setCachedMeta(cacheKey, md || {});
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

  const r = await getTokenRarity(client, {
    chain: listing.chain,
    contract: listing.contract,
    tokenId: listing.tokenId,
  });

  if (r.rank != null) listing.rarityRank = r.rank;
  if (r.score != null) listing.rarityScore = r.score;

  if (listing.rarityRank == null && debugOn()) {
    const st = await getBuildStatus(client, { chain: listing.chain, contract: listing.contract });
    const status = st?.status || "unknown";
    const pc = st?.processed_count ?? 0;
    const err = st?.last_error ? ` err=${String(st.last_error).slice(0, 80)}` : "";
    console.log(`[LURKER][rarity] missing rank for ${listing.contract.slice(0, 10)}..#${listing.tokenId} | build=${status} processed=${pc}${err}`);
  }

  return listing;
}

function updateFeedState(ruleId, listings) {
  const st = RULE_FEED_STATE.get(ruleId) || {
    lastNewestId: null,
    lastNewestTsMs: null,
    sameNewestTicks: 0,
    lastTickMs: 0,
  };

  let newest = null;
  let oldest = null;

  for (const it of listings || []) {
    if (!it) continue;
    const t = extractTsMs(it);
    const id = it.listingId || it.id || it.eventId || it.event_id || null;

    const obj = { id, t };
    if (!newest) newest = obj;
    if (!oldest) oldest = obj;

    if (t != null && (newest.t == null || t > newest.t)) newest = obj;
    if (t != null && (oldest.t == null || t < oldest.t)) oldest = obj;
  }

  const newestId = newest?.id || null;
  const newestTs = newest?.t != null ? newest.t : null;

  const changed =
    (newestId && newestId !== st.lastNewestId) ||
    (newestTs != null && st.lastNewestTsMs != null && newestTs !== st.lastNewestTsMs) ||
    (newestTs != null && st.lastNewestTsMs == null);

  if (changed) {
    st.sameNewestTicks = 0;
    st.lastNewestId = newestId;
    st.lastNewestTsMs = newestTs;
  } else {
    st.sameNewestTicks += 1;
  }

  st.lastTickMs = Date.now();
  RULE_FEED_STATE.set(ruleId, st);

  return {
    newestId,
    newestTsMs: newestTs,
    oldestId: oldest?.id || null,
    oldestTsMs: oldest?.t != null ? oldest.t : null,
    sameNewestTicks: st.sameNewestTicks,
  };
}

async function processRule(client, rule, debug) {
  const tickStart = Date.now();

  const c = {
    fetched: 0,
    missingListingId: 0,
    seen: 0,
    unseen: 0,
    waitRarity: 0,
    filterFailMarked: 0,
    hits: 0,
    posted: 0,
    markedSeenAfterPost: 0,
    pendingPosted: 0,
  };

  const out = await fetchFromSource(rule);
  const listings = Array.isArray(out?.listings) ? out.listings : [];
  c.fetched = listings.length;

  const feed = updateFeedState(rule.id, listings);

  if (debug && logFeedOn()) {
    console.log(
      `[LURKER][feed] rule#${rule.id} newest=${feed.newestId || "n/a"} @ ${fmtTs(feed.newestTsMs)} | oldest=${feed.oldestId || "n/a"} @ ${fmtTs(feed.oldestTsMs)} | sameNewestTicks=${feed.sameNewestTicks}`
    );
    if (feed.sameNewestTicks >= staleWarnTicks()) {
      console.log(
        `[LURKER][warn] rule#${rule.id} feed looks stale (newest unchanged for ${feed.sameNewestTicks} ticks).`
      );
    }
  }

  if (debug && dumpSampleOn() && listings[0]) {
    const sample = listings[0];
    console.log(`[LURKER][sample] rule#${rule.id} keys=${Object.keys(sample || {}).join(",")}`);
  }

  // prune pending notified occasionally
  if (pendingAlertOn()) gcPendingNotified();

  for (const listing of listings) {
    if (!listing?.listingId) {
      c.missingListingId += 1;
      continue;
    }

    const alreadySeen = await isSeen(client, rule.id, listing.listingId);
    if (alreadySeen) {
      c.seen += 1;
      continue;
    }

    c.unseen += 1;

    let evaluated = listing;
    evaluated.chain = chainNorm(evaluated.chain || rule.chain);
    evaluated.contract = s(evaluated.contract || rule.contract).toLowerCase();

    if (debug && logAllUnseenOn()) {
      const ts = extractTsMs(evaluated);
      console.log(
        `[LURKER][unseen] rule#${rule.id} listing=${evaluated.listingId} token=#${evaluated.tokenId} ts=${fmtTs(ts)}`
      );
    }

    evaluated = await ensureTraitsIfNeeded(rule, evaluated);
    evaluated = await fillRarity(client, rule, evaluated);

    const ruleTraits = jparse(rule.traits_json || "", null);
    const traitHit = traitsMatch(ruleTraits, evaluated.traits);

    const rarityMax = rule.rarity_max != null ? Number(rule.rarity_max) : null;
    const rank = evaluated.rarityRank != null ? Number(evaluated.rarityRank) : null;

    // Waiting for rarity build
    if (rarityMax != null && rank == null && !traitHit) {
      c.waitRarity += 1;

      // Optional: one-time "pending" heads-up (deduped in memory)
      if (pendingAlertOn()) {
        const pk = `${rule.id}:${evaluated.listingId}`;
        if (!PENDING_NOTIFIED.has(pk)) {
          PENDING_NOTIFIED.set(pk, Date.now());
          const ok = await postPending(client, rule, evaluated);
          if (ok) c.pendingPosted += 1;
        }
      } else if (debug && logWaitOn()) {
        console.log(`[LURKER][wait] rule#${rule.id} wait rarity build — listing=${evaluated.listingId} token=#${evaluated.tokenId}`);
      }

      continue;
    }

    if (!passesFilters(rule, evaluated)) {
      c.filterFailMarked += 1;
      await markSeen(client, rule.id, evaluated.listingId);
      continue;
    }

    const rarityHit = (rarityMax != null && rank != null && rank <= rarityMax);
    const why = rarityHit
      ? `Rarity rank **${rank}** ≤ **${rarityMax}**`
      : `Trait match (${Object.keys(ruleTraits || {}).length} configured)`;

    c.hits += 1;

    const ok = await postAlert(client, rule, evaluated, why);
    if (ok) c.posted += 1;

    await markSeen(client, rule.id, evaluated.listingId);
    c.markedSeenAfterPost += 1;
  }

  if (debug && logSummaryOn()) {
    const ms = Date.now() - tickStart;
    console.log(
      `[LURKER][sum] rule#${rule.id} fetched=${c.fetched} unseen=${c.unseen} seen=${c.seen} waitRarity=${c.waitRarity} filterFailMarked=${c.filterFailMarked} hits=${c.hits} posted=${c.posted} pending=${c.pendingPosted} ms=${ms}`
    );
  }
}

function startLurker(client) {
  const enabled = String(process.env.LURKER_ENABLED || "0").trim() === "1";
  if (!enabled) {
    console.log("🟢 [LURKER] disabled (LURKER_ENABLED!=1)");
    return;
  }

  const pollMs = Number(process.env.LURKER_POLL_MS || 15000);
  const debug = debugOn();

  if (client.__lurkerStarted) return;
  client.__lurkerStarted = true;

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

    metadataLookupsThisTick = 0;
    META_CACHE_TICK = new Map();

    try {
      const rules = await getEnabledRules(client);
      if (debug && logSummaryOn()) console.log(`[LURKER] rules enabled=${rules.length}`);

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



