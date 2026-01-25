// listeners/musclemb/profileStore.js
// ======================================================
// ProfileStore — admin-curated profile memory for MuscleMB
// - Facts: key/value pairs per guild+user (e.g., "role=young dev")
// - Notes: timestamped short notes per guild+user
// - Safe schema init (idempotent)
// - Formatting helpers to inject into AI system prompt
//
// Tables:
// 1) mb_profile_facts(guild_id, user_id, key, value, created_at, updated_at, created_by, updated_by)
// 2) mb_profile_notes(guild_id, user_id, note_id, note, created_at, created_by)
//
// IMPORTANT:
// - This is "trusted memory" only (written by admin/owner commands).
// - You should NOT auto-store user claims here.
// ======================================================

function cleanStr(v, max = 200) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max) : s;
}

function cleanKey(v, max = 48) {
  const s = cleanStr(v, max).toLowerCase();
  // allow letters/numbers/_/-
  return s.replace(/[^a-z0-9_\-]/g, '').slice(0, max);
}

function isPlausibleId(s) {
  return typeof s === 'string' && /^\d{6,30}$/.test(s);
}

async function ensureSchema(client) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  // one-time guard (but safe if called multiple times)
  if (client.__mbProfileStoreSchemaReady) return true;

  await pg.query(`
    CREATE TABLE IF NOT EXISTS mb_profile_facts (
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW(),
      created_by TEXT,
      updated_by TEXT,
      PRIMARY KEY (guild_id, user_id, key)
    );
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS mb_profile_notes (
      guild_id   TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      note_id    BIGSERIAL PRIMARY KEY,
      note       TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      created_by TEXT
    );
  `);

  // Helpful indexes
  await pg.query(`CREATE INDEX IF NOT EXISTS mb_profile_notes_g_u_idx ON mb_profile_notes (guild_id, user_id, created_at DESC);`);

  client.__mbProfileStoreSchemaReady = true;
  return true;
}

async function setFact(client, guildId, userId, key, value, actorId = null) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, error: 'pg_not_ready' };

  if (!isPlausibleId(String(guildId || '')) || !isPlausibleId(String(userId || ''))) {
    return { ok: false, error: 'bad_ids' };
  }

  const k = cleanKey(key);
  const v = cleanStr(value, 180);

  if (!k) return { ok: false, error: 'bad_key' };
  if (!v) return { ok: false, error: 'bad_value' };

  await ensureSchema(client);

  await pg.query(
    `
    INSERT INTO mb_profile_facts (guild_id, user_id, key, value, created_by, updated_by)
    VALUES ($1,$2,$3,$4,$5,$5)
    ON CONFLICT (guild_id, user_id, key)
    DO UPDATE SET value = EXCLUDED.value, updated_at = NOW(), updated_by = EXCLUDED.updated_by
    `,
    [String(guildId), String(userId), k, v, actorId ? String(actorId) : null]
  );

  return { ok: true, key: k, value: v };
}

async function deleteFact(client, guildId, userId, key) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, error: 'pg_not_ready' };

  const k = cleanKey(key);
  if (!k) return { ok: false, error: 'bad_key' };

  await ensureSchema(client);

  const res = await pg.query(
    `DELETE FROM mb_profile_facts WHERE guild_id=$1 AND user_id=$2 AND key=$3`,
    [String(guildId), String(userId), k]
  );

  return { ok: true, deleted: res.rowCount || 0 };
}

async function getFacts(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  await ensureSchema(client);

  const res = await pg.query(
    `SELECT key, value FROM mb_profile_facts WHERE guild_id=$1 AND user_id=$2 ORDER BY key ASC`,
    [String(guildId), String(userId)]
  );

  return (res.rows || [])
    .map(r => ({ key: String(r.key || ''), value: String(r.value || '') }))
    .filter(r => r.key && r.value);
}

async function addNote(client, guildId, userId, note, actorId = null) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, error: 'pg_not_ready' };

  const n = cleanStr(note, 220);
  if (!n) return { ok: false, error: 'bad_note' };

  await ensureSchema(client);

  const res = await pg.query(
    `INSERT INTO mb_profile_notes (guild_id, user_id, note, created_by) VALUES ($1,$2,$3,$4) RETURNING note_id`,
    [String(guildId), String(userId), n, actorId ? String(actorId) : null]
  );

  return { ok: true, note_id: res.rows?.[0]?.note_id || null, note: n };
}

async function deleteNote(client, guildId, userId, noteId) {
  const pg = client?.pg;
  if (!pg?.query) return { ok: false, error: 'pg_not_ready' };

  const id = Number(noteId);
  if (!Number.isFinite(id) || id <= 0) return { ok: false, error: 'bad_note_id' };

  await ensureSchema(client);

  const res = await pg.query(
    `DELETE FROM mb_profile_notes WHERE guild_id=$1 AND user_id=$2 AND note_id=$3`,
    [String(guildId), String(userId), id]
  );

  return { ok: true, deleted: res.rowCount || 0 };
}

async function getNotes(client, guildId, userId, limit = 5) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  await ensureSchema(client);

  const lim = Math.max(0, Math.min(25, Number(limit) || 5));

  const res = await pg.query(
    `
    SELECT note_id, note, created_at
    FROM mb_profile_notes
    WHERE guild_id=$1 AND user_id=$2
    ORDER BY created_at DESC
    LIMIT $3
    `,
    [String(guildId), String(userId), lim]
  );

  return (res.rows || []).map(r => ({
    note_id: r.note_id,
    note: String(r.note || ''),
    created_at: r.created_at
  })).filter(x => x.note);
}

function formatFactsInline(facts, maxKeys = 6) {
  const arr = Array.isArray(facts) ? facts : [];
  const m = Math.max(0, Math.min(12, Number(maxKeys) || 6));
  const sliced = arr.slice(0, m);

  const parts = [];
  for (const f of sliced) {
    const k = cleanKey(f?.key || '');
    const v = cleanStr(f?.value || '', 120);
    if (!k || !v) continue;
    parts.push(`${k}=${v}`);
  }

  // keep it readable
  return parts.join(' | ');
}

function formatNotesInline(notes, maxNotes = 4) {
  const arr = Array.isArray(notes) ? notes : [];
  const m = Math.max(0, Math.min(10, Number(maxNotes) || 4));
  const sliced = arr.slice(0, m);

  const parts = [];
  for (const n of sliced) {
    const note = cleanStr(n?.note || '', 140);
    if (!note) continue;
    parts.push(`"${note}"`);
  }
  return parts.join(' ');
}

module.exports = {
  ensureSchema,
  setFact,
  deleteFact,
  getFacts,
  addNote,
  deleteNote,
  getNotes,
  formatFactsInline,
  formatNotesInline,
};
