// services/gift/ensureGiftSchema.js
// ======================================================
// Gift Drop Guess Game — Schema Auto-Init
// - Creates all tables/indexes if missing (Railway friendly)
// - Safe to run on every boot (idempotent)
// ======================================================

const DEBUG = String(process.env.GIFT_DEBUG || "").trim() === "1";

async function ensureGiftSchema(client) {
  try {
    if (client.__giftSchemaReady) return true;

    const pg = client?.pg;
    if (!pg?.query) {
      if (DEBUG) console.log("[GIFT] schema: pg not available on client.pg");
      return false;
    }

    await pg.query(`
      CREATE TABLE IF NOT EXISTS gift_config (
        guild_id           TEXT PRIMARY KEY,
        channel_id         TEXT,
        mode_default       TEXT DEFAULT 'modal',
        allow_public_mode  BOOLEAN DEFAULT TRUE,
        allow_modal_mode   BOOLEAN DEFAULT TRUE,

        range_min_default  INT DEFAULT 1,
        range_max_default  INT DEFAULT 100,

        duration_sec_default INT DEFAULT 600,
        per_user_cooldown_ms INT DEFAULT 6000,
        max_guesses_per_user INT DEFAULT 25,
        hints_mode         TEXT DEFAULT 'highlow',
        announce_channel_id TEXT,

        created_at         TIMESTAMPTZ DEFAULT NOW(),
        updated_at         TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS gift_games (
        id                BIGSERIAL PRIMARY KEY,
        guild_id          TEXT NOT NULL,
        channel_id        TEXT NOT NULL,
        thread_id         TEXT,
        created_by        TEXT NOT NULL,
        created_by_tag    TEXT,

        mode              TEXT NOT NULL,
        status            TEXT NOT NULL DEFAULT 'active',

        range_min         INT NOT NULL,
        range_max         INT NOT NULL,

        target_number     INT,
        target_source     TEXT NOT NULL DEFAULT 'admin',
        commit_hash       TEXT,
        commit_salt       TEXT,
        commit_enabled    BOOLEAN DEFAULT FALSE,

        drop_message_id   TEXT,
        drop_message_url  TEXT,

        prize_type        TEXT DEFAULT 'text',
        prize_label       TEXT,
        prize_secret      BOOLEAN DEFAULT TRUE,
        prize_payload     JSONB,

        started_at        TIMESTAMPTZ DEFAULT NOW(),
        ends_at           TIMESTAMPTZ,
        ended_at          TIMESTAMPTZ,

        winner_user_id    TEXT,
        winner_user_tag   TEXT,
        winning_guess     INT,
        total_guesses     INT DEFAULT 0,
        unique_players    INT DEFAULT 0,

        per_user_cooldown_ms INT,
        max_guesses_per_user INT,
        hints_mode        TEXT,

        notes             TEXT,

        created_at        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_gift_games_guild_status
        ON gift_games (guild_id, status, started_at DESC);

      CREATE TABLE IF NOT EXISTS gift_guesses (
        id                BIGSERIAL PRIMARY KEY,
        game_id           BIGINT NOT NULL REFERENCES gift_games(id) ON DELETE CASCADE,
        guild_id          TEXT NOT NULL,
        channel_id        TEXT NOT NULL,
        user_id           TEXT NOT NULL,
        user_tag          TEXT,

        guess_value       INT NOT NULL,
        source            TEXT NOT NULL,
        message_id        TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),

        is_correct        BOOLEAN DEFAULT FALSE,
        hint              TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_gift_guesses_game_user
        ON gift_guesses (game_id, user_id, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_gift_guesses_game_value
        ON gift_guesses (game_id, guess_value);

      CREATE TABLE IF NOT EXISTS gift_user_state (
        guild_id          TEXT NOT NULL,
        user_id           TEXT NOT NULL,

        last_guess_at     TIMESTAMPTZ,
        guesses_in_game   INT DEFAULT 0,
        last_game_id      BIGINT,

        wins_total        INT DEFAULT 0,
        guesses_total     INT DEFAULT 0,

        updated_at        TIMESTAMPTZ DEFAULT NOW(),

        PRIMARY KEY (guild_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS gift_audit (
        id                BIGSERIAL PRIMARY KEY,
        guild_id          TEXT NOT NULL,
        game_id           BIGINT,
        action            TEXT NOT NULL,
        actor_user_id     TEXT,
        actor_tag         TEXT,
        details           JSONB,
        created_at        TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_gift_audit_guild_time
        ON gift_audit (guild_id, created_at DESC);
    `);

    client.__giftSchemaReady = true;
    console.log("✅ [GIFT] schema ready");
    return true;
  } catch (err) {
    console.error("❌ [GIFT] schema init failed:", err?.message || err);
    return false;
  }
}

module.exports = { ensureGiftSchema };

