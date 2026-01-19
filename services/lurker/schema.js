// services/lurker/schema.js
// ======================================================
// LURKER DB schema (backward compatible)
// - lurker_rules: rule configs
// - lurker_seen: dedupe listings per rule
// - lurker_inbox: external lister -> bot inbox feed (supports old+new layouts)
// - lurker_rarity_meta: rarity build state per collection
// - lurker_rarity_trait_stats: trait frequency counts
// - lurker_rarity_tokens: per-token traits + score + rank
// ======================================================

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

    // Inbox table (create in newest format)
    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_inbox (
        rule_id INTEGER,
        guild_id TEXT,
        listing_id TEXT NOT NULL,
        chain TEXT NOT NULL,
        contract TEXT NOT NULL,
        token_id TEXT NOT NULL,
        opensea_url TEXT,
        source TEXT DEFAULT 'inbox',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Ensure columns exist (safe migration)
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS rule_id INTEGER;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS guild_id TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS listing_id TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS chain TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS contract TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS token_id TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS opensea_url TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS source TEXT;`).catch(() => {});
    await pg.query(`ALTER TABLE lurker_inbox ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();`).catch(() => {});

    // Try to add a useful dedupe constraint (non-fatal if it fails due to old data/structure)
    await pg.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'lurker_inbox_pk'
        ) THEN
          ALTER TABLE lurker_inbox
          ADD CONSTRAINT lurker_inbox_pk PRIMARY KEY (listing_id);
        END IF;
      EXCEPTION WHEN others THEN
        -- ignore
      END$$;
    `).catch(() => {});

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

    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_cc ON lurker_inbox(chain, contract);`).catch(() => {});
    await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_created ON lurker_inbox(created_at);`).catch(() => {});

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
    await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS watch_url TEXT;`).catch(() => {});

    return true;
  } catch (e) {
    console.warn("[LURKER][schema] ensure failed:", e?.message || e);
    return false;
  }
}

module.exports = { ensureLurkerSchema };
