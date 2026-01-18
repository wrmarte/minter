// services/lurker/schema.js
// ======================================================
// LURKER: Schema bootstrap (no manual SQL needed)
// ======================================================

async function ensureLurkerSchema(client) {
  try {
    if (client.__lurkerSchemaReady) return true;
    const pg = client?.pg;
    if (!pg?.query) return false;

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_rules (
        id SERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        chain TEXT NOT NULL,                 -- 'eth' | 'base' | 'ape'
        contract TEXT NOT NULL,              -- lowercased
        channel_id TEXT,                     -- where to post alerts (optional)
        enabled BOOLEAN NOT NULL DEFAULT TRUE,

        rarity_max INTEGER,                  -- e.g. 100
        traits_json TEXT,                    -- JSON string: { "Hat": ["Beanie"], "Eyes": ["Laser"] }
        max_price_native TEXT,               -- string to avoid float issues; interpret per chain native
        auto_buy BOOLEAN NOT NULL DEFAULT FALSE,

        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_checkpoints (
        rule_id INTEGER PRIMARY KEY REFERENCES lurker_rules(id) ON DELETE CASCADE,
        cursor TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS lurker_seen (
        rule_id INTEGER REFERENCES lurker_rules(id) ON DELETE CASCADE,
        listing_id TEXT NOT NULL,
        seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (rule_id, listing_id)
      );
    `);

    client.__lurkerSchemaReady = true;
    return true;
  } catch (e) {
    console.log("[LURKER] ensureLurkerSchema error:", e?.message || e);
    return false;
  }
}

module.exports = { ensureLurkerSchema };
