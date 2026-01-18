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
//
// OPTIONAL:
//   LURKER_RARITY_FORCE_REBUILD=0  (set to 1 to wipe + rebuild collections)
//   LURKER_RARITY_FINALIZE_BATCH=500
// ======================================================

const { ensureLurkerSchema } = require("../schema");
const { fetchCollectionPage } = require("../metadata/moralis");

function s(v) { return String(v || "").trim(); }
function chainNorm(v) { return s(v).toLowerCase(); }
function debugOn() { return String(process.env.LURKER_DEBUG || "0").trim() === "1"; }

function boolEnv(name, def = "0") {
  const v = String(process.env[name] ?? def).trim();
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

// Normalize traits into: { traitType: [value1,value2] }
// Accepts either object-of-arrays, object-of-single, or OpenSea-style [{trait_type,value}]
function normalizeTraits(input) {
  const out = {};

  if (!input) return out;

  // OpenSea-style array: [{trait_type, value}]
  if (Array.isArray(input)) {
    for (const t of input) {
      const k = s(t?.trait_type);
      const v = s(t?.value);
      if (!k || !v) continue;
      if (!out[k]) out[k] = [];
      out[k].push(v);
    }
    return out;
  }

  // object form
  if (typeof input === "object") {
    for (const [kRaw, vRaw] of Object.entries(input)) {
      const k = s(kRaw);
      if (!k) continue;

      if (Array.isArray(vRaw)) {
        const arr = vRaw.map(x => s(x)).filter(Boolean);
        if (arr.length) out[k] = arr;
      } else {
        const v = s(vRaw);
        if (v) out[k] = [v];
      }
    }
  }

  return out;
}

function traitCountValue(traitsObj) {
  // count total trait values (so arrays count as multiple)
  let n = 0;
  for (const vals of Object.values(traitsObj || {})) {
    if (Array.isArray(vals)) n += vals.length;
    else if (vals != null) n += 1;
  }
  return n;
}

// OpenRarity-ish score:
// score = Σ (-ln(p)) for each trait, where p = count/totalSupply
function scoreTokenOpenRarity(traits, traitCounts, totalSupply) {
  if (!traits || typeof traits !== "object") return null;
  const total = Number(totalSupply);
  if (!Number.isFinite(total) || total <= 0) return null;

  let score = 0;

  for (const [tt, vals] of Object.entries(traits)) {
    const arr = Array.isArray(vals) ? vals : [vals];
    for (const vRaw of arr) {
      const tv = s(vRaw);
      const ttype = s(tt);
      if (!ttype || !tv) continue;

      const key = `${ttype}\u0000${tv}`;
      const cnt = Number(traitCounts.get(key) || 0);
      if (!Number.isFinite(cnt) || cnt <= 0) continue;

      const p = cnt / total;
      if (p > 0) score += -Math.log(p);
    }
  }

  return Number.isFinite(score) ? score : null;
}

async function touchMeta(pg, chain, contract, patch) {
  // FIX: apply patch values on first insert too (your old version always inserted idle)
  const base = {
    status: "idle",
    cursor: null,
    processed_count: 0,
    total_supply: null,
    last_error: null,
  };

  const merged = { ...base, ...(patch || {}) };

  await pg.query(
    `
    INSERT INTO lurker_rarity_meta(chain, contract, status, cursor, processed_count, total_supply, last_error, updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,NOW())
    ON CONFLICT(chain, contract) DO UPDATE SET
      status=EXCLUDED.status,
      cursor=EXCLUDED.cursor,
      processed_count=EXCLUDED.processed_count,
      total_supply=EXCLUDED.total_supply,
      last_error=EXCLUDED.last_error,
      updated_at=NOW()
    `,
    [
      chain,
      contract,
      merged.status,
      merged.cursor,
      merged.processed_count,
      merged.total_supply,
      merged.last_error
    ]
  );
}

async function getMeta(pg, chain, contract) {
  const r = await pg.query(
    `SELECT * FROM lurker_rarity_meta WHERE chain=$1 AND contract=$2`,
    [chain, contract]
  );
  return r.rows?.[0] || null;
}

async function resetCollection(pg, chain, contract) {
  // Wipe rarity state for clean rebuild (prevents traitCount inflation)
  await pg.query(`DELETE FROM lurker_rarity_trait_stats WHERE chain=$1 AND contract=$2`, [chain, contract]);
  await pg.query(`DELETE FROM lurker_rarity_tokens WHERE chain=$1 AND contract=$2`, [chain, contract]);
  await touchMeta(pg, chain, contract, {
    status: "building",
    cursor: null,
    processed_count: 0,
    total_supply: null,
    last_error: null
  });
}

async function ensureBuilding(pg, chain, contract) {
  const meta = await getMeta(pg, chain, contract);

  const force = boolEnv("LURKER_RARITY_FORCE_REBUILD", "0");

  if (!meta) {
    await touchMeta(pg, chain, contract, {
      status: "building",
      cursor: null,
      processed_count: 0,
      total_supply: null,
      last_error: null
    });
    return;
  }

  if (meta.status === "ready" && !force) return;

  // If force rebuild OR meta is error, wipe and rebuild clean
  if (force || meta.status === "error") {
    await resetCollection(pg, chain, contract);
    return;
  }

  // Normal move to building state (no wipe)
  if (meta.status !== "building") {
    await touchMeta(pg, chain, contract, {
      status: "building",
      last_error: null,
      cursor: meta.cursor || null,
      processed_count: Number(meta.processed_count || 0),
      total_supply: meta.total_supply != null ? Number(meta.total_supply) : null
    });
  }
}

async function upsertTokens(pg, chain, contract, tokens) {
  // Upsert token traits rows (per token; still very safe)
  for (const t of tokens) {
    const tokenId = s(t.tokenId);
    const traits = normalizeTraits(t.traits || {});
    await pg.query(
      `
      INSERT INTO lurker_rarity_tokens(chain, contract, token_id, traits_json, updated_at)
      VALUES($1,$2,$3,$4::jsonb,NOW())
      ON CONFLICT(chain, contract, token_id) DO UPDATE
        SET traits_json=EXCLUDED.traits_json,
            updated_at=NOW()
      `,
      [chain, contract, tokenId, JSON.stringify(traits)]
    );
  }
}

async function upsertTraitStatsAggregated(pg, chain, contract, tokens) {
  // Build aggregated increments for this page, then apply in ONE upsert
  // Also add Trait Count attribute ("Trait Count": ["12"])
  const inc = new Map(); // key -> count
  const pushInc = (traitType, traitValue) => {
    const tt = s(traitType);
    const tv = s(traitValue);
    if (!tt || !tv) return;
    const k = `${tt}\u0000${tv}`;
    inc.set(k, (inc.get(k) || 0) + 1);
  };

  for (const t of tokens) {
    const traits = normalizeTraits(t.traits || {});
    // add trait count
    const tc = traitCountValue(traits);
    pushInc("Trait Count", String(tc));

    for (const [tt, vals] of Object.entries(traits)) {
      const arr = Array.isArray(vals) ? vals : [vals];
      for (const v of arr) pushInc(tt, v);
    }
  }

  if (!inc.size) return;

  const traitTypes = [];
  const traitValues = [];
  const counts = [];

  for (const [k, c] of inc.entries()) {
    const [tt, tv] = k.split("\u0000");
    traitTypes.push(tt);
    traitValues.push(tv);
    counts.push(c);
  }

  await pg.query(
    `
    INSERT INTO lurker_rarity_trait_stats(chain, contract, trait_type, trait_value, trait_count, updated_at)
    SELECT
      $1::text AS chain,
      $2::text AS contract,
      x.trait_type,
      x.trait_value,
      x.trait_count,
      NOW()
    FROM (
      SELECT
        UNNEST($3::text[]) AS trait_type,
        UNNEST($4::text[]) AS trait_value,
        UNNEST($5::int[])  AS trait_count
    ) x
    ON CONFLICT(chain, contract, trait_type, trait_value) DO UPDATE
      SET trait_count = lurker_rarity_trait_stats.trait_count + EXCLUDED.trait_count,
          updated_at = NOW()
    `,
    [chain, contract, traitTypes, traitValues, counts]
  );
}

async function incrementTraitCounts(pg, chain, contract, tokens, processedCountAfter) {
  // Transaction makes page writes consistent
  await pg.query("BEGIN");
  try {
    await upsertTokens(pg, chain, contract, tokens);
    await upsertTraitStatsAggregated(pg, chain, contract, tokens);

    // Update processed_count
    const meta = await getMeta(pg, chain, contract);
    await touchMeta(pg, chain, contract, {
      status: "building",
      cursor: meta?.cursor || null,
      processed_count: processedCountAfter,
      total_supply: meta?.total_supply != null ? Number(meta.total_supply) : null,
      last_error: null
    });

    await pg.query("COMMIT");
  } catch (e) {
    await pg.query("ROLLBACK").catch(() => null);
    throw e;
  }
}

async function finalizeScoresAndRanks(pg, chain, contract) {
  const meta = await getMeta(pg, chain, contract);
  const totalSupply = Number(meta?.processed_count || 0);
  if (!Number.isFinite(totalSupply) || totalSupply <= 0) throw new Error("finalize: totalSupply invalid");

  // Load trait counts
  const stats = await pg.query(
    `SELECT trait_type, trait_value, trait_count FROM lurker_rarity_trait_stats WHERE chain=$1 AND contract=$2`,
    [chain, contract]
  );

  const traitCounts = new Map();
  for (const r of (stats.rows || [])) {
    const key = `${s(r.trait_type)}\u0000${s(r.trait_value)}`;
    traitCounts.set(key, Number(r.trait_count) || 0);
  }

  // Iterate tokens by id cursor (faster than OFFSET on large sets)
  const batch = Number(process.env.LURKER_RARITY_FINALIZE_BATCH || 500);
  let lastId = 0;

  while (true) {
    const r = await pg.query(
      `
      SELECT id, token_id, traits_json
      FROM lurker_rarity_tokens
      WHERE chain=$1 AND contract=$2 AND id > $3
      ORDER BY id
      LIMIT $4
      `,
      [chain, contract, lastId, batch]
    );

    const rows = r.rows || [];
    if (!rows.length) break;

    // compute scores for this batch
    const tokenIds = [];
    const scores = [];
    let maxId = lastId;

    for (const row of rows) {
      const id = Number(row.id) || 0;
      if (id > maxId) maxId = id;

      const tokenId = s(row.token_id);
      const traits = normalizeTraits(row.traits_json || {});
      // ensure Trait Count is also part of scoring distribution
      const tc = traitCountValue(traits);
      traits["Trait Count"] = [String(tc)];

      const score = scoreTokenOpenRarity(traits, traitCounts, totalSupply);
      tokenIds.push(tokenId);
      scores.push(score);
    }

    // Batch update scores
    await pg.query(
      `
      UPDATE lurker_rarity_tokens t
      SET score = v.score,
          updated_at = NOW()
      FROM (
        SELECT
          UNNEST($3::text[]) AS token_id,
          UNNEST($4::numeric[]) AS score
      ) v
      WHERE t.chain=$1 AND t.contract=$2 AND t.token_id = v.token_id
      `,
      [
        chain,
        contract,
        tokenIds,
        scores.map(x => (x == null ? null : String(x)))
      ]
    );

    lastId = maxId;
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

  await touchMeta(pg, chain, contract, {
    status: "ready",
    total_supply: totalSupply,
    cursor: null,
    processed_count: totalSupply,
    last_error: null
  });
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
    const tokens = Array.isArray(page?.tokens) ? page.tokens : [];
    cur = page?.cursor || null;

    processed += tokens.length;

    if (tokens.length) {
      if (debugOn()) {
        console.log(
          `[LURKER][rarity] build ${chain}:${contract.slice(0, 10)}.. pageTokens=${tokens.length} processed=${processed} cursor=${cur ? "yes" : "no"}`
        );
      }

      await incrementTraitCounts(pg, chain, contract, tokens, processed);
      await touchMeta(pg, chain, contract, {
        status: "building",
        cursor: cur,
        processed_count: processed,
        total_supply: meta?.total_supply != null ? Number(meta.total_supply) : null,
        last_error: null
      });
    } else {
      // no tokens returned; avoid infinite loop
      await touchMeta(pg, chain, contract, {
        status: "building",
        cursor: null,
        processed_count: processed,
        total_supply: meta?.total_supply != null ? Number(meta.total_supply) : null,
        last_error: null
      });
      cur = null;
    }

    if (!cur) break;
  }

  // if cursor ended, finalize
  const meta2 = await getMeta(pg, chain, contract);
  if (meta2 && !meta2.cursor && meta2.status === "building") {
    try {
      if (debugOn()) console.log(`[LURKER][rarity] finalize ${chain}:${contract.slice(0, 10)}.. processed=${meta2.processed_count}`);
      await finalizeScoresAndRanks(pg, chain, contract);
      if (debugOn()) console.log(`[LURKER][rarity] READY ${chain}:${contract.slice(0, 10)}.. supply=${meta2.processed_count}`);
    } catch (e) {
      await touchMeta(pg, chain, contract, {
        status: "error",
        cursor: null,
        processed_count: Number(meta2?.processed_count || 0),
        total_supply: meta2?.total_supply != null ? Number(meta2.total_supply) : null,
        last_error: s(e?.message || e)
      });
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

  // run soon after boot (helps)
  setTimeout(async () => {
    if (running) return;
    running = true;
    try {
      await rarityBuildTick(client);
    } catch (e) {
      console.warn("[LURKER][rarity] tick error:", e?.message || e);
    } finally {
      running = false;
    }
  }, 4000);

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
