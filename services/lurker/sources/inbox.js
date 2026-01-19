// services/lurker/sources/inbox.js
// ======================================================
// LURKER: Inbox source (DB-backed)
// - Reads pending listing rows inserted by an external lister (GitHub Actions / VPS / etc.)
// - Backward compatible: supports inbox tables WITHOUT rule_id (fallback by guild_id+chain+contract)
//
// Expected table (new):
//   lurker_inbox(rule_id, listing_id, chain, contract, token_id, opensea_url, source, created_at)
//
// Older/alt table (fallback supported):
//   lurker_inbox(guild_id, chain, contract, token_id, listing_id, opensea_url, source, created_at)
//   (or similar)
// ======================================================

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }

function debugOn() {
  return String(process.env.LURKER_INBOX_DEBUG || process.env.LURKER_DEBUG || "0").trim() === "1";
}

function isMissingColumnErr(e, colName) {
  const msg = String(e?.message || e || "").toLowerCase();
  return msg.includes("does not exist") && msg.includes(String(colName || "").toLowerCase());
}

async function cleanupOld(pg) {
  const days = Math.max(3, Math.min(90, Number(process.env.LURKER_INBOX_RETENTION_DAYS || 14)));
  await pg.query(
    `DELETE FROM lurker_inbox WHERE created_at < NOW() - ($1::text || ' days')::interval`,
    [String(days)]
  ).catch(() => {});
}

function normalizeRowToListing(row, rule) {
  const chain = lower(row.chain || rule.chain);
  const contract = lower(row.contract || rule.contract);
  const tokenId = s(row.token_id || row.tokenId || row.token || "");
  const listingId = s(row.listing_id || row.listingId || row.id || "");
  const url = s(row.opensea_url || row.url || "");

  return {
    source: s(row.source || "inbox") || "inbox",
    chain,
    contract,
    listingId,
    tokenId,
    openseaUrl: url || null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,

    // optional fields (filled later via Moralis / rarity DB)
    name: null,
    image: null,
    seller: null,
    priceNative: null,
    priceCurrency: null,
    rarityRank: null,
    rarityScore: null,
    traits: {},
    raw: row,
  };
}

async function fetchListings({ client, rule }) {
  const pg = client?.pg;
  if (!pg?.query) return { listings: [] };

  const limit = Math.min(50, Math.max(1, Number(process.env.LURKER_INBOX_LIMIT || 25)));

  // periodic cleanup (cheap, safe)
  if (Math.random() < 0.05) {
    await cleanupOld(pg);
  }

  const ruleId = Number(rule?.id);
  const guildId = s(rule?.guild_id || rule?.guildId || "");
  const chain = lower(rule?.chain || "");
  const contract = lower(rule?.contract || "");

  // --- Preferred: new schema (rule_id column exists) ---
  if (Number.isFinite(ruleId)) {
    try {
      const r = await pg.query(
        `
        SELECT listing_id, chain, contract, token_id, opensea_url, source, created_at
        FROM lurker_inbox
        WHERE rule_id = $1
        ORDER BY created_at DESC
        LIMIT $2
        `,
        [ruleId, limit]
      );

      const rows = r.rows || [];
      const listings = rows
        .map(row => normalizeRowToListing(row, rule))
        .filter(x => x.listingId && x.tokenId && x.contract);

      if (debugOn()) {
        console.log(`[LURKER][inbox] rule#${ruleId} mode=rule_id rows=${rows.length} listings=${listings.length}`);
      }

      return { listings };
    } catch (e) {
      // If rule_id column doesn't exist, fallback below
      if (!isMissingColumnErr(e, "rule_id")) throw e;
      if (debugOn()) console.log(`[LURKER][inbox] fallback: rule_id column missing`);
    }
  }

  // --- Fallback: older schema, match by guild_id+chain+contract ---
  // This requires the inbox rows to include guild_id OR at least chain+contract.
  // We'll try guild_id if present, otherwise chain+contract only.
  try {
    // Try with guild_id first
    if (guildId) {
      const r = await pg.query(
        `
        SELECT listing_id, chain, contract, token_id, opensea_url, source, created_at
        FROM lurker_inbox
        WHERE guild_id = $1 AND chain = $2 AND contract = $3
        ORDER BY created_at DESC
        LIMIT $4
        `,
        [guildId, chain, contract, limit]
      );

      const rows = r.rows || [];
      const listings = rows
        .map(row => normalizeRowToListing(row, rule))
        .filter(x => x.listingId && x.tokenId && x.contract);

      if (debugOn()) {
        console.log(`[LURKER][inbox] rule#${ruleId || "?"} mode=guild+cc rows=${rows.length} listings=${listings.length}`);
      }

      return { listings };
    }
  } catch (e) {
    // If guild_id column doesn't exist, try chain+contract only
    if (!isMissingColumnErr(e, "guild_id")) throw e;
    if (debugOn()) console.log(`[LURKER][inbox] fallback: guild_id column missing`);
  }

  // Final fallback: chain+contract only
  const r2 = await pg.query(
    `
    SELECT listing_id, chain, contract, token_id, opensea_url, source, created_at
    FROM lurker_inbox
    WHERE chain = $1 AND contract = $2
    ORDER BY created_at DESC
    LIMIT $3
    `,
    [chain, contract, limit]
  );

  const rows2 = r2.rows || [];
  const listings2 = rows2
    .map(row => normalizeRowToListing(row, rule))
    .filter(x => x.listingId && x.tokenId && x.contract);

  if (debugOn()) {
    console.log(`[LURKER][inbox] rule#${ruleId || "?"} mode=cc rows=${rows2.length} listings=${listings2.length}`);
  }

  return { listings: listings2 };
}

module.exports = { fetchListings };
