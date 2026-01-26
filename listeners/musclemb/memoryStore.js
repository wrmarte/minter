// listeners/musclemb/memoryStore.js
// ======================================================
// MuscleMB lightweight memory store (PG)
// - Opt-in state for awareness pings
// - Last active tracking
// - Per-guild daily cap tracking for awareness pings
//
// ✅ HARDENED PATCH:
// - In-flight schema init (prevents concurrent ALTER/CREATE races)
// - Safe migrations that won't fail on existing rows
// - Self-heal retry when a column is missing
// - Keeps ON CONFLICT working via UNIQUE index even on legacy tables
// ======================================================

function nowMs() { return Date.now(); }

// process-wide in-flight schema init promise (per client instance)
function getInflightKey(client) {
  return '__mbMemorySchemaInflight';
}

async function ensureSchema(client) {
  try {
    if (client?.__mbMemorySchemaReady) return true;

    const pg = client?.pg;
    if (!pg?.query) return false;

    // If another call is already running schema init, await it.
    const inflightKey = getInflightKey(client);
    if (client[inflightKey]) {
      try {
        const ok = await client[inflightKey];
        return Boolean(ok);
      } catch {
        return false;
      }
    }

    client[inflightKey] = (async () => {
      try {
        // 1) Create base tables if missing (safe)
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

        // 2) Auto-migrate older schemas (tables exist but missing columns)
        // IMPORTANT: use safest possible ALTERs (avoid NOT NULL additions that can break on existing rows)
        // mb_user_state
        await pg.query(`ALTER TABLE mb_user_state ADD COLUMN IF NOT EXISTS opted_in BOOLEAN DEFAULT FALSE;`);
        await pg.query(`ALTER TABLE mb_user_state ADD COLUMN IF NOT EXISTS last_active_ts BIGINT;`);
        await pg.query(`ALTER TABLE mb_user_state ADD COLUMN IF NOT EXISTS last_ping_ts BIGINT;`);
        await pg.query(`ALTER TABLE mb_user_state ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
        await pg.query(`ALTER TABLE mb_user_state ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);

        // Backfill nulls (legacy rows) — safe updates
        await pg.query(`UPDATE mb_user_state SET opted_in = COALESCE(opted_in, FALSE) WHERE opted_in IS NULL;`).catch(() => {});
        await pg.query(`UPDATE mb_user_state SET created_at = COALESCE(created_at, NOW()) WHERE created_at IS NULL;`).catch(() => {});
        await pg.query(`UPDATE mb_user_state SET updated_at = COALESCE(updated_at, NOW()) WHERE updated_at IS NULL;`).catch(() => {});

        // Ensure unique index for ON CONFLICT target (works even if PK wasn't present originally)
        await pg.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS mb_user_state_guild_user_uidx
          ON mb_user_state (guild_id, user_id);
        `);

        // mb_awareness_guild_daily
        await pg.query(`ALTER TABLE mb_awareness_guild_daily ADD COLUMN IF NOT EXISTS day_date DATE;`);
        await pg.query(`ALTER TABLE mb_awareness_guild_daily ADD COLUMN IF NOT EXISTS count INT DEFAULT 0;`);
        await pg.query(`ALTER TABLE mb_awareness_guild_daily ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);

        await pg.query(`UPDATE mb_awareness_guild_daily SET day_date = COALESCE(day_date, CURRENT_DATE) WHERE day_date IS NULL;`).catch(() => {});
        await pg.query(`UPDATE mb_awareness_guild_daily SET count = COALESCE(count, 0) WHERE count IS NULL;`).catch(() => {});
        await pg.query(`UPDATE mb_awareness_guild_daily SET updated_at = COALESCE(updated_at, NOW()) WHERE updated_at IS NULL;`).catch(() => {});

        await pg.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS mb_awareness_guild_daily_guild_uidx
          ON mb_awareness_guild_daily (guild_id);
        `);

        client.__mbMemorySchemaReady = true;
        return true;
      } catch (e) {
        console.warn('⚠️ [MB][memoryStore] ensureSchema failed:', e?.message || String(e));
        return false;
      } finally {
        // clear inflight promise
        try { delete client[inflightKey]; } catch {}
      }
    })();

    const ok = await client[inflightKey];
    return Boolean(ok);
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] ensureSchema outer failed:', e?.message || String(e));
    return false;
  }
}

function isMissingColumnErr(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  // postgres: column "x" of relation "y" does not exist
  return msg.includes('does not exist') && msg.includes('column') && msg.includes('relation');
}

async function touchActivity(client, guildId, userId, ts = nowMs()) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  // Ensure schema once
  const ok = await ensureSchema(client);
  if (!ok) return false;

  const params = [String(guildId), String(userId), Number(ts)];

  const run = async () => {
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, last_active_ts, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET last_active_ts = EXCLUDED.last_active_ts, updated_at = NOW()
      `,
      params
    );
    return true;
  };

  try {
    return await run();
  } catch (e) {
    // Self-heal: if legacy schema is still missing a column, re-run ensureSchema and retry once
    if (isMissingColumnErr(e)) {
      console.warn('⚠️ [MB][memoryStore] touchActivity missing-column; re-migrating and retrying once...');
      await ensureSchema(client);
      try { return await run(); } catch (e2) {
        console.warn('⚠️ [MB][memoryStore] touchActivity failed after retry:', e2?.message || String(e2));
        return false;
      }
    }

    console.warn('⚠️ [MB][memoryStore] touchActivity failed:', e?.message || String(e));
    return false;
  }
}

async function trackActivity(client, message) {
  try {
    if (!message?.guild?.id || !message?.author?.id) return false;
    if (!client?.pg?.query) return false;
    return await touchActivity(client, message.guild.id, message.author.id, Date.now());
  } catch (e) {
    console.warn('⚠️ [MB][memoryStore] trackActivity failed:', e?.message || String(e));
    return false;
  }
}

async function setOptIn(client, guildId, userId, optedIn) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  const ok = await ensureSchema(client);
  if (!ok) return false;

  const run = async () => {
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, opted_in, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET opted_in = EXCLUDED.opted_in, updated_at = NOW()
      `,
      [String(guildId), String(userId), Boolean(optedIn)]
    );
    return true;
  };

  try {
    return await run();
  } catch (e) {
    if (isMissingColumnErr(e)) {
      console.warn('⚠️ [MB][memoryStore] setOptIn missing-column; re-migrating and retrying once...');
      await ensureSchema(client);
      try { return await run(); } catch (e2) {
        console.warn('⚠️ [MB][memoryStore] setOptIn failed after retry:', e2?.message || String(e2));
        return false;
      }
    }
    console.warn('⚠️ [MB][memoryStore] setOptIn failed:', e?.message || String(e));
    return false;
  }
}

async function userIsOptedIn(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  try {
    await ensureSchema(client);
    const r = await pg.query(
      `SELECT opted_in FROM mb_user_state WHERE guild_id=$1 AND user_id=$2 LIMIT 1`,
      [String(guildId), String(userId)]
    );
    return Boolean(r.rows?.[0]?.opted_in);
  } catch {
    return false;
  }
}

async function getUserState(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return null;

  try {
    await ensureSchema(client);
    const r = await pg.query(
      `SELECT guild_id, user_id, opted_in, last_active_ts, last_ping_ts, updated_at
       FROM mb_user_state
       WHERE guild_id=$1 AND user_id=$2
       LIMIT 1`,
      [String(guildId), String(userId)]
    );
    return r.rows?.[0] || null;
  } catch {
    return null;
  }
}

async function getGuildDailyCount(client, guildId) {
  const pg = client?.pg;
  if (!pg?.query) return { dayDate: null, count: 0 };

  try {
    await ensureSchema(client);
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

  try {
    await ensureSchema(client);

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
      [String(guildId), String(dateISO)]
    );

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

  try {
    await ensureSchema(client);

    // Ensure row exists (so UPDATE actually does something)
    await pg.query(
      `
      INSERT INTO mb_user_state (guild_id, user_id, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (guild_id, user_id) DO NOTHING
      `,
      [String(guildId), String(userId)]
    );

    await pg.query(
      `
      UPDATE mb_user_state
      SET last_ping_ts=$3, updated_at=NOW()
      WHERE guild_id=$1 AND user_id=$2
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

  const nowN = Number(now);
  const inactiveCutoff = nowN - Number(inactiveMs);
  const pingCutoff = nowN - Number(pingCooldownMs);

  try {
    await ensureSchema(client);

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

module.exports = {
  ensureSchema,
  touchActivity,
  trackActivity,
  setOptIn,
  userIsOptedIn,
  getUserState,
  getGuildDailyCount,
  incrementGuildDaily,
  markPinged,
  getInactiveOptedInCandidates,
};

