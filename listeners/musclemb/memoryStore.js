// listeners/musclemb/memoryStore.js
// ======================================================
// MuscleMB lightweight memory store (PG)
// - Opt-in state for awareness pings
// - Last active tracking
// - Per-guild daily cap tracking for awareness pings
//
// ✅ Backward compatible with newer modules:
// - trackActivity(client, message)
// - userIsOptedIn(client, guildId, userId)
// - getInactiveOptedInUsers(client, guildId, inactiveMs, limit)
// ======================================================

function nowMs() { return Date.now(); }

function isPlausibleId(s) {
  return typeof s === 'string' && /^\d{6,30}$/.test(s);
}

async function ensureSchema(client) {
  if (client?.__mbMemorySchemaReady) return true;
  const pg = client?.pg;
  if (!pg?.query) return false;

  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_user_state (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        opted_in BOOLEAN NOT NULL DEFAULT FALSE,
        last_active_ts BIGINT,
        last_ping_ts   BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_awareness_guild_daily (
        guild_id TEXT PRIMARY KEY,
        day_date DATE NOT NULL,
        count INT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    client.__mbMemorySchemaReady = true;
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] ensureSchema failed:', e?.message || String(e));
    return false;
  }
}

async function touchActivity(client, guildId, userId, ts = nowMs(), channelId = null) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  const g = String(guildId);
  const u = String(userId);
  if (!isPlausibleId(g) || !isPlausibleId(u)) return false;

  try {
    // NOTE: channelId is not stored in current schema; kept as a param for future extension.
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, last_active_ts, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET last_active_ts = EXCLUDED.last_active_ts, updated_at = NOW()
      `,
      [g, u, Number(ts)]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] touchActivity failed:', e?.message || String(e));
    return false;
  }
}

async function setOptIn(client, guildId, userId, optedIn) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  const g = String(guildId);
  const u = String(userId);
  if (!isPlausibleId(g) || !isPlausibleId(u)) return false;

  try {
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, opted_in, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = NOW()
      `,
      [g, u, Boolean(optedIn)]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] setOptIn failed:', e?.message || String(e));
    return false;
  }
}

async function userIsOptedIn(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  const g = String(guildId);
  const u = String(userId);
  if (!isPlausibleId(g) || !isPlausibleId(u)) return false;

  try {
    const r = await pg.query(
      `SELECT opted_in FROM mb_user_state WHERE guild_id=$1 AND user_id=$2 LIMIT 1`,
      [g, u]
    );
    return Boolean(r.rows?.[0]?.opted_in);
  } catch {
    return false;
  }
}

async function getGuildDailyCount(client, guildId) {
  const pg = client?.pg;
  if (!pg?.query) return { dayDate: null, count: 0 };
  if (!guildId) return { dayDate: null, count: 0 };

  try {
    const r = await pg.query(
      `SELECT day_date, count FROM mb_awareness_guild_daily WHERE guild_id=$1 LIMIT 1`,
      [String(guildId)]
    );
    const row = r.rows?.[0] || null;
    return { dayDate: row?.day_date || null, count: Number(row?.count || 0) };
  } catch {
    return { dayDate: null, count: 0 };
  }
}

async function incrementGuildDaily(client, guildId, dateISO /* yyyy-mm-dd */) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, count: 0 };
  if (!guildId) return { ok: false, count: 0 };

  try {
    // Upsert day row; reset count if date changed
    await pg.query(
      `
      INSERT INTO mb_awareness_guild_daily (guild_id, day_date, count, updated_at)
      VALUES ($1, $2::date, 0, NOW())
      ON CONFLICT (guild_id)
      DO UPDATE SET
        count = CASE WHEN mb_awareness_guild_daily.day_date = EXCLUDED.day_date
                     THEN mb_awareness_guild_daily.count
                     ELSE 0
                END,
        day_date = EXCLUDED.day_date,
        updated_at = NOW()
      `,
      [String(guildId), dateISO]
    );

    // increment
    const r2 = await pg.query(
      `
      UPDATE mb_awareness_guild_daily
      SET count = count + 1, updated_at = NOW()
      WHERE guild_id=$1
      RETURNING count
      `,
      [String(guildId)]
    );

    const count = Number(r2.rows?.[0]?.count || 0);
    return { ok: true, count };
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] incrementGuildDaily failed:', e?.message || String(e));
    return { ok: false, count: 0 };
  }
}

async function markPinged(client, guildId, userId, ts = nowMs()) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  try {
    // Ensure row exists, then update
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, last_ping_ts, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET last_ping_ts = EXCLUDED.last_ping_ts, updated_at = NOW()
      `,
      [String(guildId), String(userId), Number(ts)]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] markPinged failed:', e?.message || String(e));
    return false;
  }
}

async function getInactiveOptedInCandidates(client, guildId, now, inactiveMs, pingCooldownMs, limit = 25) {
  const pg = client?.pg;
  if (!pg?.query) return [];
  if (!guildId) return [];

  const nowN = Number(now);
  const inactiveCutoff = nowN - Number(inactiveMs);
  const pingCutoff = nowN - Number(pingCooldownMs);

  try {
    const r = await pg.query(
      `
      SELECT user_id, last_active_ts, last_ping_ts
      FROM mb_user_state
      WHERE guild_id=$1
        AND opted_in=TRUE
        AND last_active_ts IS NOT NULL
        AND last_active_ts <= $2
        AND (last_ping_ts IS NULL OR last_ping_ts <= $3)
      ORDER BY last_active_ts ASC
      LIMIT $4
      `,
      [String(guildId), inactiveCutoff, pingCutoff, Math.max(1, Math.min(100, Number(limit) || 25))]
    );

    return (r.rows || []).map(row => ({
      userId: row.user_id,
      lastActiveTs: Number(row.last_active_ts || 0),
      lastPingTs: row.last_ping_ts == null ? null : Number(row.last_ping_ts),
    }));
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] getInactiveOptedInCandidates failed:', e?.message || String(e));
    return [];
  }
}

/* ======================================================
   ✅ Compatibility wrappers expected by newer modules
====================================================== */

async function trackActivity(client, message) {
  try {
    const guildId = message?.guild?.id;
    const userId = message?.author?.id;
    const channelId = message?.channel?.id || null;
    if (!guildId || !userId) return false;

    const ok = await ensureSchema(client);
    if (!ok) return false;

    return await touchActivity(client, guildId, userId, nowMs(), channelId);
  } catch {
    return false;
  }
}

// Older modules expect "getInactiveOptedInUsers(client, guildId, inactiveMs, limit)"
// This wrapper uses your query logic but supplies defaults for ping cooldown.
async function getInactiveOptedInUsers(client, guildId, inactiveMs, limit = 25, pingCooldownMs = (5 * 24 * 60 * 60 * 1000)) {
  const now = nowMs();
  const rows = await getInactiveOptedInCandidates(client, guildId, now, inactiveMs, pingCooldownMs, limit);
  return rows.map(r => ({
    userId: String(r.userId),
    lastSeenTs: Number(r.lastActiveTs || 0),
    lastChannelId: null, // not stored in schema (kept for compatibility)
  }));
}

module.exports = {
  // schema
  ensureSchema,

  // core functions (your originals)
  touchActivity,
  setOptIn,
  getGuildDailyCount,
  incrementGuildDaily,
  markPinged,
  getInactiveOptedInCandidates,

  // compatibility (newer modules)
  trackActivity,
  userIsOptedIn,
  getInactiveOptedInUsers,
};

