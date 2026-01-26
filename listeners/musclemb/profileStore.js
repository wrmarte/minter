// listeners/musclemb/profileStore.js
// ======================================================
// Profile Store (PG) — admin/owner curated user memory
// - Facts: small key/value pairs (role/title/etc.)
// - Notes: timestamped short notes (audit-friendly)
// - Tags: short labels (vip/whale/degen/etc.)
// - Used for system prompt injection (never invent)
// ======================================================

function cleanKey(k) {
  const s = String(k || '').trim().toLowerCase();
  // allow a-z 0-9 _ - .
  return s.replace(/[^a-z0-9_\-\.]/g, '').slice(0, 32);
}

function cleanTag(t) {
  const s = String(t || '').trim().toLowerCase();
  // allow a-z 0-9 _ -
  return s.replace(/[^a-z0-9_\-]/g, '').slice(0, 24);
}

function cleanVal(v, max = 180) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function cleanNote(v, max = 220) {
  const s = String(v || '').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

async function ensureSchema(client) {
  if (client?.__mbProfileSchemaReady) return true;
  const pg = client?.pg;
  if (!pg?.query) return false;

  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_profile_facts (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        fact_key   TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id, fact_key)
      );
    `);

    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_profile_notes (
        note_id    BIGSERIAL PRIMARY KEY,
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        note_text  TEXT NOT NULL,
        created_by TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS mb_profile_notes_guild_user_created_at_idx
      ON mb_profile_notes (guild_id, user_id, created_at DESC);
    `);

    // ✅ TAGS
    await pg.query(`
      CREATE TABLE IF NOT EXISTS mb_profile_tags (
        guild_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        tag        TEXT NOT NULL,
        updated_by TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (guild_id, user_id, tag)
      );
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS mb_profile_tags_guild_user_tag_idx
      ON mb_profile_tags (guild_id, user_id, tag);
    `);

    client.__mbProfileSchemaReady = true;
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] ensureSchema failed:', e?.message || String(e));
    return false;
  }
}

async function setFact(client, guildId, userId, key, value, updatedBy = null) {
  const pg = client?.pg;
  if (!pg?.query) return false;
  if (!guildId || !userId) return false;

  const k = cleanKey(key);
  const v = cleanVal(value);
  if (!k || !v) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `
      INSERT INTO mb_profile_facts (guild_id, user_id, fact_key, fact_value, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,$5,NOW())
      ON CONFLICT (guild_id, user_id, fact_key)
      DO UPDATE SET fact_value=EXCLUDED.fact_value, updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `,
      [guildId, userId, k, v, updatedBy]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] setFact failed:', e?.message || String(e));
    return false;
  }
}

async function deleteFact(client, guildId, userId, key) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  const k = cleanKey(key);
  if (!k) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `DELETE FROM mb_profile_facts WHERE guild_id=$1 AND user_id=$2 AND fact_key=$3`,
      [guildId, userId, k]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] deleteFact failed:', e?.message || String(e));
    return false;
  }
}

async function getFacts(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  await ensureSchema(client);

  try {
    const r = await pg.query(
      `
      SELECT fact_key, fact_value, updated_at
      FROM mb_profile_facts
      WHERE guild_id=$1 AND user_id=$2
      ORDER BY fact_key ASC
      `,
      [guildId, userId]
    );
    return (r.rows || []).map(x => ({
      key: x.fact_key,
      value: x.fact_value,
      updatedAt: x.updated_at,
    }));
  } catch {
    return [];
  }
}

async function addNote(client, guildId, userId, noteText, createdBy = null) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  const note = cleanNote(noteText);
  if (!note) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `
      INSERT INTO mb_profile_notes (guild_id, user_id, note_text, created_by, created_at)
      VALUES ($1,$2,$3,$4,NOW())
      `,
      [guildId, userId, note, createdBy]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] addNote failed:', e?.message || String(e));
    return false;
  }
}

async function getNotes(client, guildId, userId, limit = 4) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  await ensureSchema(client);

  try {
    const r = await pg.query(
      `
      SELECT note_id, note_text, created_at
      FROM mb_profile_notes
      WHERE guild_id=$1 AND user_id=$2
      ORDER BY created_at DESC
      LIMIT $3
      `,
      [guildId, userId, Math.max(1, Math.min(20, Number(limit) || 4))]
    );

    return (r.rows || []).map(x => ({
      id: String(x.note_id),
      text: x.note_text,
      createdAt: x.created_at,
    }));
  } catch {
    return [];
  }
}

async function deleteNote(client, guildId, userId, noteId) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  const idN = Number(noteId);
  if (!Number.isFinite(idN) || idN <= 0) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `DELETE FROM mb_profile_notes WHERE guild_id=$1 AND user_id=$2 AND note_id=$3`,
      [guildId, userId, idN]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] deleteNote failed:', e?.message || String(e));
    return false;
  }
}

// ✅ TAGS
async function addTag(client, guildId, userId, tag, updatedBy = null) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  const t = cleanTag(tag);
  if (!t) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `
      INSERT INTO mb_profile_tags (guild_id, user_id, tag, updated_by, updated_at)
      VALUES ($1,$2,$3,$4,NOW())
      ON CONFLICT (guild_id, user_id, tag)
      DO UPDATE SET updated_by=EXCLUDED.updated_by, updated_at=NOW()
      `,
      [guildId, userId, t, updatedBy]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] addTag failed:', e?.message || String(e));
    return false;
  }
}

async function removeTag(client, guildId, userId, tag) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  const t = cleanTag(tag);
  if (!t) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `DELETE FROM mb_profile_tags WHERE guild_id=$1 AND user_id=$2 AND tag=$3`,
      [guildId, userId, t]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] removeTag failed:', e?.message || String(e));
    return false;
  }
}

async function clearTags(client, guildId, userId) {
  const pg = client?.pg;
  if (!pg?.query) return false;

  await ensureSchema(client);

  try {
    await pg.query(
      `DELETE FROM mb_profile_tags WHERE guild_id=$1 AND user_id=$2`,
      [guildId, userId]
    );
    return true;
  } catch (e) {
    console.warn('⚠️ [MB][profileStore] clearTags failed:', e?.message || String(e));
    return false;
  }
}

async function getTags(client, guildId, userId, limit = 20) {
  const pg = client?.pg;
  if (!pg?.query) return [];

  await ensureSchema(client);

  try {
    const r = await pg.query(
      `
      SELECT tag, updated_at
      FROM mb_profile_tags
      WHERE guild_id=$1 AND user_id=$2
      ORDER BY tag ASC
      LIMIT $3
      `,
      [guildId, userId, Math.max(1, Math.min(50, Number(limit) || 20))]
    );

    return (r.rows || []).map(x => ({
      tag: x.tag,
      updatedAt: x.updated_at,
    }));
  } catch {
    return [];
  }
}

// ---------- Formatting helpers for prompt injection ----------
function formatFactsInline(facts, maxKeys = 6) {
  const arr = Array.isArray(facts) ? facts : [];
  const sliced = arr.slice(0, Math.max(1, Math.min(12, Number(maxKeys) || 6)));

  const parts = [];
  for (const f of sliced) {
    const k = cleanKey(f?.key);
    const v = cleanVal(f?.value, 120);
    if (!k || !v) continue;
    parts.push(`${k}="${v}"`);
  }
  return parts.join(', ');
}

function formatNotesInline(notes, maxNotes = 4) {
  const arr = Array.isArray(notes) ? notes : [];
  const sliced = arr.slice(0, Math.max(0, Math.min(10, Number(maxNotes) || 4)));

  const parts = [];
  for (const n of sliced) {
    const t = cleanNote(n?.text, 140);
    if (!t) continue;
    parts.push(`"${t}"`);
  }
  return parts.join(' | ');
}

function formatTagsInline(tags, max = 10) {
  const arr = Array.isArray(tags) ? tags : [];
  const sliced = arr.slice(0, Math.max(0, Math.min(20, Number(max) || 10)));
  const parts = [];
  for (const x of sliced) {
    const t = cleanTag(x?.tag);
    if (!t) continue;
    parts.push(t);
  }
  return parts.join(', ');
}

module.exports = {
  ensureSchema,

  // facts
  setFact,
  deleteFact,
  getFacts,

  // notes
  addNote,
  getNotes,
  deleteNote,

  // tags
  addTag,
  removeTag,
  clearTags,
  getTags,

  // formatting
  formatFactsInline,
  formatNotesInline,
  formatTagsInline,
};

