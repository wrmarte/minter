// listeners/musclemb/memoryStore.js
// ======================================================
// MemoryStore (DB-backed, lightweight)
// - Auto-creates schema (Railway-friendly)
// - Tracks last_seen, message_count, last_channel
// - Supports opt-in mentions + “last_pinged”
// ======================================================

const DEBUG = String(process.env.MB_MEMORY_DEBUG || '').trim() === '1';

function nowISO() {
  return new Date().toISOString();
}

async function ensureSchema(client) {
  try {
    if (client.__mbMemoryReady) return true;
    const pg = client?.pg;
    if (!pg?.query) return false;

    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_user_state (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        opted_in BOOLEAN NOT NULL DEFAULT FALSE,
        last_seen TIMESTAMPTZ,
        last_channel_id TEXT,
        message_count BIGINT NOT NULL DEFAULT 0,
        last_pinged TIMESTAMPTZ,
        notes TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS mb_user_state_last_seen_idx
      ON mb_user_state (guild_id, last_seen);
    `);

    client.__mbMemoryReady = true;
    if (DEBUG) console.log('✅ [MB_MEMORY] schema ready');
    return true;
  } catch (e) {
    if (DEBUG) console.warn('⚠️ [MB_MEMORY] ensureSchema failed:', e?.message || String(e));
    return false;
  }
}

async function upsertActivity(client, guildId, userId, channelId) {
  const pg = client?.pg;
  if (!pg?.query) return;

  await pg.query(
    `
    INSERT INTO mb_user_state (guild_id, user_id, last_seen, last_channel_id, message_count, updated_at)
    VALUES ($1, $2, NOW(), $3, 1, NOW())
    ON CONFLICT (guild_id, user_id)
    DO UPDATE SET
      last_seen = NOW(),
      last_channel_id = EXCLUDED.last_channel_id,
      message_count = mb_user_state.message_count + 1,
      updated_at = NOW();
    `,
    [guildId, userId, channelId]
  );
}

async function markPinged(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return;

  await pg.query(
    `
    UPDATE mb_user_state
    SET last_pinged = NOW(), updated_at = NOW()
    WHERE guild_id = $1 AND user_id = $2;
    `,
    [guildId, userId]
  );
}

async function setOptIn(client, guildId, userId, optedIn) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false };

  await pg.query(
    `
    INSERT INTO mb_user_state (guild_id, user_id, opted_in, updated_at)
    VALUES ($1, $2, $3, NOW())
    ON CONFLICT (guild_id, user_id)
    DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = NOW();
    `,
    [guildId, userId, Boolean(optedIn)]
  );

  return { ok: true };
}

async function getOptedInCandidates(client, guildId) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  const res = await pg.query(
    `
    SELECT user_id, last_seen, last_channel_id, last_pinged
    FROM mb_user_state
    WHERE guild_id = $1 AND opted_in = TRUE
    ORDER BY last_seen DESC NULLS LAST
    LIMIT 200;
    `,
    [guildId]
  );

  return res.rows || [];
}

// Public entry: safe call from listener
function trackActivity(client, message) {
  (async () => {
    const pg = client?.pg;
    if (!pg?.query) return;

    const ok = await ensureSchema(client);
    if (!ok) return;

    await upsertActivity(client, message.guild.id, message.author.id, message.channel.id);
  })().catch((e) => {
    if (DEBUG) console.warn('⚠️ [MB_MEMORY] trackActivity error:', e?.message || String(e));
  });
}

module.exports = {
  ensureSchema,
  trackActivity,
  markPinged,
  setOptIn,
  getOptedInCandidates,
  _nowISO: nowISO,
};
