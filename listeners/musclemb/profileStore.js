// listeners/musclemb/profileStore.js
// ======================================================
// MuscleMB Profile Store (PG)
// - Admin-curated facts about users ("wassa = young dev")
// - Timestamped notes ("2026-01-25: shipping v5 router")
// - Safe + small: hard limits, no surprises, no auto-invention
//
// Used by MuscleMBListener to inject "Trusted User Memory" into prompt.
// ======================================================

function nowIso() {
  return new Date().toISOString();
}

function safeKey(k, max = 32) {
  const s = String(k || '').trim().toLowerCase();
  if (!s) return '';
  // allow letters, numbers, underscore, dash, dot
  const cleaned = s.replace(/[^a-z0-9_.-]/g, '').slice(0, max);
  return cleaned;
}

function safeText(v, max = 240) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function safeTag(v, max = 32) {
  const s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  return s.replace(/[^a-z0-9_.-]/g, '').slice(0, max);
}

async function ensureSchema(client) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (client.__mbProfileSchemaReady) return true;

  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_profiles (
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        facts    JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_profile_notes (
        id BIGSERIAL PRIMARY KEY,
        guild_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        note TEXT NOT NULL,
        tag  TEXT,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS mb_profile_notes_guild_user_created_idx
      ON mb_profile_notes (guild_id, user_id, created_at DESC);
    `);

    client.__mbProfileSchemaReady = true;
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] ensureSchema failed:', e?.message || String(e));
    return false;
  }
}

async function getFacts(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return {};
  if (!guildId || !userId) return {};

  try {
    const r = await pg.query(
      `SELECT facts FROM mb_profiles WHERE guild_id=$1 AND user_id=$2 LIMIT 1`,
      [String(guildId), String(userId)]
    );
    const facts = r.rows?.[0]?.facts;
    return (facts && typeof facts === 'object') ? facts : {};
  } catch {
    return {};
  }
}

async function setFact(client, guildId, userId, key, value, updatedBy = null) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, reason: 'no_pg' };
  if (!guildId || !userId) return { ok: false, reason: 'missing_ids' };

  const k = safeKey(key);
  const v = safeText(value, 220);
  if (!k || !v) return { ok: false, reason: 'bad_key_or_value' };

  try {
    await pg.query(
      `
      INSERT INTO mb_profiles (guild_id, user_id, facts, updated_by, updated_at)
      VALUES ($1, $2, jsonb_build_object($3, $4), $5, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        facts = mb_profiles.facts || jsonb_build_object($3, $4),
        updated_by = $5,
        updated_at = NOW()
      `,
      [String(guildId), String(userId), k, v, updatedBy ? String(updatedBy) : null]
    );
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] setFact failed:', e?.message || String(e));
    return { ok: false, reason: 'db_error' };
  }
}

async function deleteFact(client, guildId, userId, key, updatedBy = null) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, reason: 'no_pg' };
  if (!guildId || !userId) return { ok: false, reason: 'missing_ids' };

  const k = safeKey(key);
  if (!k) return { ok: false, reason: 'bad_key' };

  try {
    await pg.query(
      `
      INSERT INTO mb_profiles (guild_id, user_id, facts, updated_by, updated_at)
      VALUES ($1, $2, '{}'::jsonb, $4, NOW())
      ON CONFLICT (guild_id, user_id)
      DO UPDATE SET
        facts = (mb_profiles.facts - $3),
        updated_by = $4,
        updated_at = NOW()
      `,
      [String(guildId), String(userId), k, updatedBy ? String(updatedBy) : null]
    );
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] deleteFact failed:', e?.message || String(e));
    return { ok: false, reason: 'db_error' };
  }
}

async function addNote(client, guildId, userId, note, createdBy = null, tag = null) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, reason: 'no_pg' };
  if (!guildId || !userId) return { ok: false, reason: 'missing_ids' };

  const n = safeText(note, 240);
  const t = tag ? safeTag(tag, 32) : null;
  if (!n) return { ok: false, reason: 'empty_note' };

  try {
    await pg.query(
      `
      INSERT INTO mb_profile_notes (guild_id, user_id, note, tag, created_by)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [String(guildId), String(userId), n, t || null, createdBy ? String(createdBy) : null]
    );
    return { ok: true };
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] addNote failed:', e?.message || String(e));
    return { ok: false, reason: 'db_error' };
  }
}

async function getNotes(client, guildId, userId, limit = 4) {
  const pg = client?.pg;
  if (!pg?.query) return [];
  if (!guildId || !userId) return [];

  const lim = Math.max(0, Math.min(20, Number(limit) || 4));
  if (!lim) return [];

  try {
    const r = await pg.query(
      `
      SELECT note, tag, created_at
      FROM mb_profile_notes
      WHERE guild_id=$1 AND user_id=$2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [String(guildId), String(userId), lim]
    );

    return (r.rows || []).map(x => ({
      note: String(x.note || ''),
      tag: x.tag ? String(x.tag) : null,
      createdAt: x.created_at ? new Date(x.created_at).toISOString() : nowIso(),
    }));
  } catch {
    return [];
  }
}

// ------------------------------------------------------
// Formatting helpers for prompt injection
// ------------------------------------------------------

function formatFactsInline(factsObj, maxKeys = 6) {
  try {
    const facts = factsObj && typeof factsObj === 'object' ? factsObj : {};
    const keys = Object.keys(facts).slice(0, Math.max(0, Math.min(12, Number(maxKeys) || 6)));
    const parts = [];

    for (const k of keys) {
      const v = safeText(facts[k], 120);
      const kk = safeKey(k, 32);
      if (!kk || !v) continue;
      parts.push(`${kk}=${v}`);
    }

    return parts.join(' • ');
  } catch {
    return '';
  }
}

function formatNotesInline(notesArr, maxNotes = 3) {
  try {
    const notes = Array.isArray(notesArr) ? notesArr : [];
    const sliced = notes.slice(0, Math.max(0, Math.min(8, Number(maxNotes) || 3)));
    const out = [];

    for (const n of sliced) {
      const note = safeText(n?.note || '', 120);
      if (!note) continue;

      // keep timestamp super light
      const ts = n?.createdAt ? String(n.createdAt).slice(0, 10) : '';
      const tag = n?.tag ? safeTag(n.tag, 20) : '';

      const prefix = tag ? `[${tag}] ` : '';
      out.push(`${prefix}${note}${ts ? ` (${ts})` : ''}`);
    }

    return out.join(' | ');
  } catch {
    return '';
  }
}

module.exports = {
  ensureSchema,
  getFacts,
  setFact,
  deleteFact,
  addNote,
  getNotes,

  // formatting helpers
  formatFactsInline,
  formatNotesInline,
};
