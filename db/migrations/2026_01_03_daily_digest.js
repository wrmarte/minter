// db/migrations/2026_01_03_daily_digest.js
// Creates: daily_digest_settings, digest_events + indexes
// Safe to run multiple times (IF NOT EXISTS used)

async function runDailyDigestMigration(pg, opts = {}) {
  const log = opts.log || console.log;

  if (!pg || typeof pg.query !== "function") {
    throw new Error("runDailyDigestMigration: pg client/pool with .query() is required");
  }

  const sql = `
  -- ===== Daily Digest Settings (per guild) =====
  CREATE TABLE IF NOT EXISTS daily_digest_settings (
    guild_id    TEXT PRIMARY KEY,
    channel_id  TEXT NOT NULL,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE,

    -- schedule
    tz          TEXT NOT NULL DEFAULT 'UTC',
    hour        INT  NOT NULL DEFAULT 21,  -- 0..23
    minute      INT  NOT NULL DEFAULT 0,   -- 0..59

    -- content flags
    include_mints BOOLEAN NOT NULL DEFAULT TRUE,
    include_sales BOOLEAN NOT NULL DEFAULT TRUE,

    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- ===== Digest Events (lightweight event log) =====
  CREATE TABLE IF NOT EXISTS digest_events (
    id          BIGSERIAL PRIMARY KEY,
    guild_id    TEXT NOT NULL,

    event_type  TEXT NOT NULL,             -- 'mint' | 'sale'
    chain       TEXT DEFAULT NULL,          -- 'base' | 'eth' | 'ape' etc
    contract    TEXT DEFAULT NULL,          -- nft contract
    token_id    TEXT DEFAULT NULL,

    -- value
    amount_native NUMERIC DEFAULT NULL,     -- raw paid amount in native or token
    amount_eth    NUMERIC DEFAULT NULL,     -- normalized to ETH if you have it
    amount_usd    NUMERIC DEFAULT NULL,

    buyer       TEXT DEFAULT NULL,
    seller      TEXT DEFAULT NULL,
    tx_hash     TEXT DEFAULT NULL,

    ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS idx_digest_events_guild_ts
  ON digest_events (guild_id, ts DESC);

  CREATE INDEX IF NOT EXISTS idx_digest_events_guild_type_ts
  ON digest_events (guild_id, event_type, ts DESC);
  `;

  // Wrap in a transaction for clean deploys
  await pg.query("BEGIN");
  try {
    await pg.query(sql);
    await pg.query("COMMIT");
    log("✅ Daily Digest migration applied (tables + indexes ready).");
    return true;
  } catch (e) {
    await pg.query("ROLLBACK");
    log("❌ Daily Digest migration failed:", e?.message || e);
    throw e;
  }
}

module.exports = { runDailyDigestMigration };
