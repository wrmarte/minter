// services/lurker/sources/inbox.js
// ======================================================
// LURKER: Inbox source (DB-backed)
// - Reads pending listing rows inserted by an external lister (GitHub Actions / VPS / etc.)
// - Returns normalized Lurker listing objects
//
// Tables:
//   lurker_inbox(rule_id, listing_id, chain, contract, token_id, opensea_url, source, created_at)
//
// ENV (optional):
//   LURKER_INBOX_LIMIT=25
//   LURKER_INBOX_DEBUG=1
//   LURKER_INBOX_RETENTION_DAYS=14
// ======================================================

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }
function debugOn() {
  return String(process.env.LURKER_INBOX_DEBUG || process.env.LURKER_DEBUG || "0").trim() === "1";
}

async function cleanupOld(pg) {
  const days = Math.max(3, Math.min(90, Number(process.env.LURKER_INBOX_RETENTION_DAYS || 14)));
  await pg.query(
    `DELETE FROM lurker_inbox WHERE created_at < NOW() - ($1::text || ' days')::interval`,
    [String(days)]
  ).catch(() => {});
}

async function fetchListings({ client, rule }) {
  const pg = client?.pg;
  if (!pg?.query) return { listings: [] };

  const limit = Math.min(50, Math.max(1, Number(process.env.LURKER_INBOX_LIMIT || 25)));
  const ruleId = Number(rule?.id);

  if (!Number.isFinite(ruleId)) return { listings: [] };

  // periodic cleanup (cheap, safe)
  if (Math.random() < 0.05) {
    await cleanupOld(pg);
  }

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
  const listings = rows.map(row => {
    const chain = lower(row.chain || rule.chain);
    const contract = lower(row.contract || rule.contract);
    const tokenId = s(row.token_id);
    const listingId = s(row.listing_id);
    const url = s(row.opensea_url);

    return {
      source: s(row.source || "inbox") || "inbox",
      chain,
      contract,
      listingId,
      tokenId,
      openseaUrl: url || null,
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,

      // optional fields (fill later via Moralis / rarity DB)
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
  }).filter(x => x.listingId && x.tokenId && x.contract);

  if (debugOn()) {
    console.log(`[LURKER][inbox] rule#${ruleId} rows=${rows.length} listings=${listings.length}`);
  }

  return { listings };
}

module.exports = { fetchListings };
