// services/lurker/schema.js
// ======================================================
// LURKER DB schema (backward compatible)
// - lurker_rules: rule configs
// - lurker_seen: dedupe listings per rule
// - lurker_rarity_meta: rarity build state per collection
// - lurker_rarity_trait_stats: trait frequency counts
// - lurker_rarity_tokens: per-token traits + score + rank
//
// IMPORTANT FIX:
// - Add new columns FIRST (ALTER TABLE ... ADD COLUMN)
// - Only then create indexes that depend on those columns
//   (otherwise Postgres throws "column does not exist")
// ======================================================

function s(v) {
  return String(v || "").trim();
}

async function safeQuery(pg, sql, params) {
  try {
    return await pg.query(sql, params);
  } catch (e) {
    // Never crash schema ensure — log and keep going
    console.warn("[LURKER][schema] nonfatal:", (e?.message || e));
    return null;
  }
}

async function ensureLurkerSchema(client) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return false;

    // ======================================================
    // Core tables (create)
    // ======================================================
    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rules (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        opensea_slug TEXT,
        channel_id TEXT,
        rarity_max INTEGER,
        traits_json TEXT,
        max_price_native NUMERIC,
        auto_buy BOOLEAN DEFAULT FALSE,
        enabled BOOLEAN DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_seen (
        rule_id INTEGER NOT NULL,
        listing_id TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY(rule_id, listing_id)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rarity_meta (
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle', -- idle | building | ready | error
        cursor TEXT,                         -- moralis cursor
        processed_count INTEGER DEFAULT 0,
        total_supply INTEGER,
        last_error TEXT,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY(chain, contract)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rarity_trait_stats (
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        trait_type TEXT NOT NULL,
        trait_value TEXT NOT NULL,
        trait_count INTEGER NOT NULL DEFAULT 0,
        total_supply INTEGER,
        updated_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY(chain, contract, trait_type, trait_value)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rarity_tokens (
        id BIGSERIAL PRIMARY KEY,
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        token_id TEXT NOT NULL,
        traits_json JSONB,
        score NUMERIC,
        rank INTEGER,
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(chain, contract, token_id)
      );
    `);

    // ======================================================
    // Backward-compatible ALTERs (must run BEFORE indexes)
    // ======================================================
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS auto_buy BOOLEAN DEFAULT FALSE;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS max_price_native NUMERIC;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS traits_json TEXT;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS rarity_max INTEGER;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS channel_id TEXT;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS created_by TEXT;`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`);
    await safeQuery(pg, `ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS opensea_slug TEXT;`);

    // ======================================================
    // Helpful indexes (safe, won’t crash process)
    // ======================================================
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rules_enabled ON lurker_rules(enabled);`);
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rules_guild ON lurker_rules(guild_id);`);
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rules_os ON lurker_rules(opensea_slug);`);
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_seen_rule ON lurker_seen(rule_id);`);

    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rarity_meta_status ON lurker_rarity_meta(status);`);
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rarity_tokens_cc ON lurker_rarity_tokens(chain, contract);`);
    await safeQuery(pg, `CREATE INDEX IF NOT EXISTS idx_lurker_rarity_tokens_rank ON lurker_rarity_tokens(chain, contract, rank);`);

    return true;
  } catch (e) {
    console.warn("[LURKER][schema] ensure failed:", e?.message || e);
    return false;
  }
}

module.exports = { ensureLurkerSchema };
