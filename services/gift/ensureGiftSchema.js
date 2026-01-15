// services/gift/ensureGiftSchema.js
// ======================================================
// Gift Game Schema Ensurer (SAFE MIGRATION)
// - Creates tables if missing
// - Adds columns if missing (ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
// ======================================================

const DEBUG = String(process.env.GIFT_SCHEMA_DEBUG || "").trim() === "1";

function log(...a) { if (DEBUG) console.log("[GIFT_SCHEMA]", ...a); }

async function ensureGiftSchema(client) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  // --- Core tables ---
  await pg.query(`
    CREATE TABLE IF NOT EXISTS gift_config (
      guild_id TEXT PRIMARY KEY,
      announce_channel_id TEXT,
      default_mode TEXT DEFAULT 'modal',               -- modal | public
      default_range_min INT DEFAULT 1,
      default_range_max INT DEFAULT 200,
      default_duration_sec INT DEFAULT 600,
      default_hints_mode TEXT DEFAULT 'hotcold',       -- hotcold | highlow | none
      default_per_user_cooldown_ms INT DEFAULT 2500,
      default_max_guesses_per_user INT DEFAULT 50,

      -- ✅ NEW: public response behavior
      public_hint_mode TEXT DEFAULT 'reply',           -- reply | react | both | silent
      public_hint_delete_ms INT DEFAULT 8000,          -- delete bot reply after X ms (0 = keep)
      public_hint_only_if_reply_to_user INT DEFAULT 1, -- 1 = reply to user's guess message, 0 = normal send

      -- ✅ NEW: audit visibility default
      audit_public_default INT DEFAULT 1,              -- 1 = post audit publicly by default

      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS gift_games (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      started_by_user_id TEXT,
      started_by_tag TEXT,

      status TEXT NOT NULL DEFAULT 'active',           -- active | ended | expired | cancelled
      mode TEXT NOT NULL DEFAULT 'modal',              -- modal | public

      range_min INT NOT NULL,
      range_max INT NOT NULL,
      target_number INT NOT NULL,

      hints_mode TEXT DEFAULT 'hotcold',               -- hotcold | highlow | none
      per_user_cooldown_ms INT DEFAULT 2500,
      max_guesses_per_user INT DEFAULT 50,

      total_guesses INT DEFAULT 0,
      unique_players INT DEFAULT 0,

      started_at TIMESTAMP DEFAULT NOW(),
      ends_at TIMESTAMP,

      drop_message_id TEXT,

      winner_user_id TEXT,
      winner_user_tag TEXT,
      winning_guess INT,

      prize_type TEXT DEFAULT 'text',                  -- nft | token | text
      prize_label TEXT DEFAULT 'Mystery prize 🎁',
      prize_payload JSONB,
      prize_secret INT DEFAULT 1,

      -- fairness commit
      commit_enabled INT DEFAULT 0,
      commit_hash TEXT,
      commit_salt TEXT,

      ended_at TIMESTAMP
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS gift_guesses (
      id BIGSERIAL PRIMARY KEY,
      game_id BIGINT NOT NULL REFERENCES gift_games(id) ON DELETE CASCADE,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      user_tag TEXT,

      guess_value INT NOT NULL,
      source TEXT DEFAULT 'public',                    -- public | modal
      message_id TEXT,

      is_correct BOOLEAN DEFAULT FALSE,
      hint TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS gift_user_state (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,

      last_guess_at TIMESTAMP,
      guesses_in_game INT DEFAULT 0,
      last_game_id BIGINT,

      wins_total INT DEFAULT 0,
      guesses_total INT DEFAULT 0,

      updated_at TIMESTAMP DEFAULT NOW(),

      PRIMARY KEY (guild_id, user_id)
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS gift_audit (
      id BIGSERIAL PRIMARY KEY,
      guild_id TEXT NOT NULL,
      game_id BIGINT,
      action TEXT NOT NULL,
      actor_user_id TEXT,
      actor_tag TEXT,
      details JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // --- Safe “add column” upgrades for older installs ---
  const alters = [
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_mode TEXT DEFAULT 'reply';`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_delete_ms INT DEFAULT 8000;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_only_if_reply_to_user INT DEFAULT 1;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS audit_public_default INT DEFAULT 1;`,
  ];

  for (const q of alters) {
    try { await pg.query(q); } catch (e) { log("ALTER failed:", e?.message || e); }
  }

  // Ensure config row exists per guild (lazy insert done elsewhere, but safe to keep)
  client.__giftSchemaReady = true;
  return true;
}

module.exports = { ensureGiftSchema };
