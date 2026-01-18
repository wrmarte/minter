// services/lurker/rarity/rarityBuilder.js
// ======================================================
// LURKER: Rarity builder (OpenRarity-style local rank/score)
// - Background job: pulls collection traits via Moralis pages
// - Stores per-token traits in DB
// - Builds trait frequency counts
// - Finalizes: computes score per token + SQL ranks
//
// ENV:
//   LURKER_RARITY_BUILD_ENABLED=1 (default 1)
//   LURKER_RARITY_BUILD_INTERVAL_MS=15000
//   LURKER_RARITY_BUILD_PAGE_LIMIT=100
//   LURKER_RARITY_BUILD_PAGES_PER_TICK=1
// ======================================================

const { ensureLurkerSchema } = require("../schema");
const { fetchCollectionPage } = require("../metadata/moralis");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function scoreToken(traits, traitCounts, totalSupply) {
  // OpenRarity-ish: sum( 1 / (count/totalSupply) ) for each trait
  if (!traits || typeof traits !== "object") return null;
  const total = Number(totalSupply);
  if (!Number.isFinite(total) || total <= 0) return null;

  let score = 0;
  for (const [tt, vals] of Object.entries(traits)) {
    const arr = Array.isArray(vals) ? vals : [vals];
    for (const vRaw of arr) {
      const tv = s(vRaw);
      const key = `${s(tt)}\u0000${tv}`;
      const cnt = traitCounts.get(key) || 0;
      if (cnt <= 0) continue;
      score += 1 / (cnt / total);
    }
  }
  return Number.isFinite(score) ? score : null;
}

async function touchMeta(pg, chain, contract, patch) {
  const fields = [];
  const vals = [chain, contract];
  let i = 3;

  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k}=$${i++}`);
    vals.push(v);
  }
  fields.push(`updated_at=NOW()`);

  await pg.query(
    `
    INSERT INTO lurker_rarity_meta(chain, contract, status, cursor, processed_count, total_supply, last_error, updated_at)
    VALUES($1,$2,'idle',NULL,0,NULL,NULL,NOW())
    ON CONFLICT(chain, contract) DO UPDATE SET ${fields.join(", ")}
    `,
    vals
  );
}

async function getMeta(pg, chain, contract) {
  const r = await pg.query(
    `SELECT * FROM lurker_rarity_meta WHERE chain=$1 AND contract=$2`,
    [chain, contract]
  );
  return r.rows?.[0] || null;
}

async function ensureBuilding(pg, chain, contract) {
  const meta = await getMeta(pg, chain, contract);
  if (!meta) {
    await touchMeta(pg, chain, contract, { status: "building", cursor: null, processed_count: 0, last_error: null });
    return;
  }
  if (meta.status === "ready") return;
  if (meta.status !== "building") {
    await touchMeta(pg, chain, contract, { status: "building", last_error: null });
  }
}

async function incrementTraitCounts(pg, chain, contract, tokens, processedCountAfter) {
  // Update token traits + trait counts
  for (const t of tokens) {
    const tokenId = s(t.tokenId);
    const traits = t.traits || {};
    await pg.query(
      `
      INSERT INTO lurker_rarity_tokens(chain, contract, token_id, traits_json, updated_at)
      VALUES($1,$2,$3,$4,NOW())
      ON CONFLICT(chain, contract, token_id) DO UPDATE
        SET traits_json=EXCLUDED.traits_json,
            updated_at=NOW()
      `,
      [chain, contract, tokenId, traits]
    );

    for (const [tt, vals] of Object.entries(traits)) {
      const arr = Array.isArray(vals) ? vals : [vals];
      for (const vRaw of arr) {
        const tv = s(vRaw);
        if (!tt || !tv) continue;
        await pg.query(
          `
          INSERT INTO lurker_rarity_trait_stats(chain, contract, trait_type, trait_value, trait_count, updated_at)
          VALUES($1,$2,$3,$4,1,NOW())
          ON CONFLICT(chain, contract, trait_type, trait_value) DO UPDATE
            SET trait_count = lurker_rarity_trait_stats.trait_count + 1,
                updated_at = NOW()
          `,
          [chain, contract, s(tt), tv]
        );
      }
    }
  }

  await touchMeta(pg, chain, contract, { processed_count: processedCountAfter });
}

async function finalizeScoresAndRanks(pg, chain, contract) {
  // total_supply = processed_count
  const meta = await getMeta(pg, chain, contract);
  const totalSupply = Number(meta?.processed_count || 0);
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) throw new Error("finalize: totalSupply invalid");

  // load trait counts into memory map (fast lookup)
  const stats = await pg.query(
    `SELECT trait_type, trait_value, trait_count FROM lurker_rarity_trait_stats WHERE chain=$1 AND contract=$2`,
    [chain, contract]
  );
  const traitCounts = new Map();
  for (const r of (stats.rows || [])) {
    const key = `${s(r.trait_type)}\u0000${s(r.trait_value)}`;
    traitCounts.set(key, Number(r.trait_count) || 0);
  }

  // iterate tokens in DB and compute score
  let offset = 0;
  const batch = 500;

  while (true) {
    const r = await pg.query(
      `
      SELECT token_id, traits_json
      FROM lurker_rarity_tokens
      WHERE chain=$1 AND contract=$2
      ORDER BY token_id
      LIMIT $3 OFFSET $4
      `,
      [chain, contract, batch, offset]
    );

    const rows = r.rows || [];
    if (!rows.length) break;

    for (const row of rows) {
      const tokenId = s(row.token_id);
      const traits = row.traits_json || {};
      const score = scoreToken(traits, traitCounts, totalSupply);

      await pg.query(
        `UPDATE lurker_rarity_tokens SET score=$1, updated_at=NOW() WHERE chain=$2 AND contract=$3 AND token_id=$4`,
        [score, chain, contract, tokenId]
      );
    }

    offset += rows.length;
  }

  // set total_supply on trait_stats
  await pg.query(
    `UPDATE lurker_rarity_trait_stats SET total_supply=$1, updated_at=NOW() WHERE chain=$2 AND contract=$3`,
    [totalSupply, chain, contract]
  );

  // rank via SQL window function
  await pg.query(
    `
    WITH ranked AS (
      SELECT id,
             ROW_NUMBER() OVER (ORDER BY score DESC NULLS LAST) AS rn
      FROM lurker_rarity_tokens
      WHERE chain=$1 AND contract=$2
    )
    UPDATE lurker_rarity_tokens t
    SET rank = ranked.rn,
        updated_at = NOW()
    FROM ranked
    WHERE t.id = ranked.id
    `,
    [chain, contract]
  );

  await touchMeta(pg, chain, contract, { status: "ready", total_supply: totalSupply, cursor: null, last_error: null });
}

async function pickNextBuildTarget(client) {
  const pg = client.pg;

  // Only build if at least one enabled rule uses rarity_max and collection isn't ready
  const r = await pg.query(
    `
    SELECT DISTINCT r.chain, r.contract
    FROM lurker_rules r
    WHERE r.enabled=TRUE
      AND r.rarity_max IS NOT NULL
    ORDER BY r.contract
    LIMIT 10
    `
  );

  const targets = r.rows || [];
  for (const t of targets) {
    const chain = chainNorm(t.chain);
    const contract = s(t.contract).toLowerCase();
    const meta = await getMeta(pg, chain, contract);
    if (!meta || meta.status !== "ready") return { chain, contract };
  }
  return null;
}

async function rarityBuildTick(client) {
  const pg = client.pg;
  await ensureLurkerSchema(client);

  const tgt = await pickNextBuildTarget(client);
  if (!tgt) return;

  const chain = chainNorm(tgt.chain);
  const contract = s(tgt.contract).toLowerCase();

  await ensureBuilding(pg, chain, contract);

  const meta = await getMeta(pg, chain, contract);
  const cursor = meta?.cursor || null;

  const pagesPerTick = Number(process.env.LURKER_RARITY_BUILD_PAGES_PER_TICK || 1);
  const limit = Number(process.env.LURKER_RARITY_BUILD_PAGE_LIMIT || 100);

  let cur = cursor;
  let processed = Number(meta?.processed_count || 0);

  for (let i = 0; i < pagesPerTick; i++) {
    const page = await fetchCollectionPage({ chain, contract, limit, cursor: cur });
    const tokens = page.tokens || [];
    cur = page.cursor || null;

    processed += tokens.length;

    if (tokens.length) {
      if (debugOn()) console.log(`[LURKER][rarity] build ${chain}:${contract.slice(0, 10)}.. pageTokens=${tokens.length} processed=${processed} cursor=${cur ? "yes" : "no"}`);
      await incrementTraitCounts(pg, chain, contract, tokens, processed);
      await touchMeta(pg, chain, contract, { cursor: cur });
    } else {
      // no tokens returned; avoid infinite loop
      await touchMeta(pg, chain, contract, { cursor: null });
      cur = null;
    }

    if (!cur) break;
  }

  // if cursor ended, finalize
  const meta2 = await getMeta(pg, chain, contract);
  if (meta2 && !meta2.cursor) {
    try {
      if (debugOn()) console.log(`[LURKER][rarity] finalize ${chain}:${contract.slice(0, 10)}.. processed=${meta2.processed_count}`);
      await finalizeScoresAndRanks(pg, chain, contract);
      if (debugOn()) console.log(`[LURKER][rarity] READY ${chain}:${contract.slice(0, 10)}.. supply=${meta2.processed_count}`);
    } catch (e) {
      await touchMeta(pg, chain, contract, { status: "error", last_error: s(e?.message || e) });
      console.warn("[LURKER][rarity] finalize error:", e?.message || e);
    }
  }
}

function startRarityBuilder(client) {
  const enabled = String(process.env.LURKER_RARITY_BUILD_ENABLED || "1").trim() === "1";
  if (!enabled) return;

  const ms = Number(process.env.LURKER_RARITY_BUILD_INTERVAL_MS || 15000);
  if (client.__lurkerRarityBuilderStarted) return;
  client.__lurkerRarityBuilderStarted = true;

  let running = false;

  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await rarityBuildTick(client);
    } catch (e) {
      console.warn("[LURKER][rarity] tick error:", e?.message || e);
    } finally {
      running = false;
    }
  }, ms);

  if (debugOn()) console.log(`[LURKER][rarity] builder started interval=${ms}ms`);
}

module.exports = { startRarityBuilder };
