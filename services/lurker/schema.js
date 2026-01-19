// services/lurker/schema.js
// ======================================================
// LURKER DB schema (backward compatible)
// - lurker_rules: rule configs
// - lurker_seen: dedupe listings per rule
// - lurker_rarity_meta: rarity build state per collection
// - lurker_rarity_trait_stats: trait frequency counts
// - lurker_rarity_tokens: per-token traits + score + rank
// ======================================================

function s(v) {
  return String(v || "").trim();
}

async function ensureLurkerSchema(client) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return false;

    // Core tables
    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rules (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        channel_id TEXT,
        rarity_max INTEGER,
        traits_json TEXT,
        max_price_native NUMERIC,
        auto_buy BOOLEAN DEFAULT FALSE,
        enabled BOOLEAN DEFAULT TRUE,
        created_by TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        os_url TEXT,
        os_slug TEXT
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

    // Rarity build meta per collection
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

    // Trait stats table
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

    // Token rarity table (store traits so we can score later)
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

    // Helpful indexes
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_rules_enabled ON lurker_rules(enabled);`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_rules_guild ON lurker_rules(guild_id);`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_seen_rule ON lurker_seen(rule_id);`);

    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_rarity_meta_status ON lurker_rarity_meta(status);`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_rarity_tokens_cc ON lurker_rarity_tokens(chain, contract);`);
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_rarity_tokens_rank ON lurker_rarity_tokens(chain, contract, rank);`);

    // Add columns safely if older table exists
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT TRUE;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS auto_buy BOOLEAN DEFAULT FALSE;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS max_price_native NUMERIC;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS traits_json TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS rarity_max INTEGER;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS channel_id TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS created_by TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS os_url TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS os_slug TEXT;`).catch(() => {});

    return true;
  } catch (e) {
    console.warn("[LURKER][schema] ensure failed:", e?.message || e);
    return false;
  }
}

module.exports = { ensureLurkerSchema };
