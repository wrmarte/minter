// services/lurker/rarity/rarityEngine.js
// ======================================================
// LURKER: Rarity lookups
// - Reads score/rank from DB (built by rarityBuilder)
// - If missing, returns nulls and builder will eventually populate
// ======================================================

const { ensureLurkerSchema } = require("../schema");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }

async function getTokenRarity(client, { chain, contract, tokenId }) {
  await ensureLurkerSchema(client);
  const pg = client.pg;

  const c = chainNorm(chain);
  const addr = s(contract).toLowerCase();
  const tid = s(tokenId);

  const r = await pg.query(
    `
    SELECT score, rank
    FROM lurker_rarity_tokens
    WHERE chain=$1 AND contract=$2 AND token_id=$3
    `,
    [c, addr, tid]
  );

  const row = r.rows?.[0] || null;
  if (!row) return { score: null, rank: null };

  const score = row.score != null ? Number(row.score) : null;
  const rank = row.rank != null ? Number(row.rank) : null;

  return {
    score: Number.isFinite(score) ? score : null,
    rank: Number.isFinite(rank) ? rank : null,
  };
}

async function getBuildStatus(client, { chain, contract }) {
  await ensureLurkerSchema(client);
  const pg = client.pg;

  const c = chainNorm(chain);
  const addr = s(contract).toLowerCase();

  const r = await pg.query(
    `SELECT status, processed_count, total_supply, last_error FROM lurker_rarity_meta WHERE chain=$1 AND contract=$2`,
    [c, addr]
  );
  return r.rows?.[0] || null;
}

module.exports = { getTokenRarity, getBuildStatus };
