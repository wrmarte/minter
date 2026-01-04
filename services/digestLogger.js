// services/digestLogger.js
// Lightweight event logger for Daily Digest
// Call this whenever you detect a mint/sale and/or post a notification.

const DEBUG = String(process.env.DIGEST_LOG_DEBUG || "").trim() === "1";

function cleanStr(v, max = 180) {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function cleanNum(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function lowerOrNull(v, max = 180) {
  const s = cleanStr(v, max);
  return s ? s.toLowerCase() : null;
}

// One-time schema init per process
async function ensureDigestSchema(client) {
  try {
    if (client.__digestSchemaReady) return true;
    const pg = client?.pg;
    if (!pg?.query) return false;

    await pg.query(`
      CREATE TABLE IF NOT EXISTS digest_events (
        id            BIGSERIAL PRIMARY KEY,
        guild_id      TEXT NOT NULL,
        event_type    TEXT NOT NULL,             -- 'mint' | 'sale'
        chain         TEXT DEFAULT NULL,          -- 'base' | 'eth' | 'ape' etc
        contract      TEXT DEFAULT NULL,          -- nft contract OR token contract
        token_id      TEXT DEFAULT NULL,          -- NFT tokenId; NULL for swaps/tokens

        amount_native NUMERIC DEFAULT NULL,
        amount_eth    NUMERIC DEFAULT NULL,
        amount_usd    NUMERIC DEFAULT NULL,

        buyer         TEXT DEFAULT NULL,
        seller        TEXT DEFAULT NULL,
        tx_hash       TEXT DEFAULT NULL,

        ts            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_digest_events_guild_ts
      ON digest_events (guild_id, ts DESC);
    `);

    await pg.query(`
      CREATE INDEX IF NOT EXISTS idx_digest_events_guild_type_ts
      ON digest_events (guild_id, event_type, ts DESC);
    `);

    // ✅ Legacy unique (kept for backward compatibility)
    // NOTE: token_id NULLs do not collide in Postgres, so this won't dedupe swaps.
    await pg.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_events_guild_type_tx_token
      ON digest_events (guild_id, event_type, tx_hash, token_id);
    `);

    // ✅ HARD DEDUPE FIX: normalize token_id NULL -> '' using a stored/generated column
    // This makes swaps/tokens (token_id NULL) dedupe properly on (guild,type,tx).
    let hasNorm = false;

    try {
      const col = await pg.query(
        `SELECT 1
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'digest_events'
            AND column_name = 'token_id_norm'
          LIMIT 1`
      );
      hasNorm = (col.rowCount > 0);

      if (!hasNorm) {
        // Prefer generated column (PG 12+). Railway PG supports this.
        await pg.query(`
          ALTER TABLE digest_events
          ADD COLUMN token_id_norm TEXT GENERATED ALWAYS AS (COALESCE(token_id, '')) STORED
        `);
        hasNorm = true;
      }
    } catch (e) {
      // If generated columns are not supported for some reason, fall back to a plain column + best-effort backfill.
      try {
        await pg.query(`
          ALTER TABLE digest_events
          ADD COLUMN IF NOT EXISTS token_id_norm TEXT
        `);

        // Backfill existing rows
        await pg.query(`
          UPDATE digest_events
             SET token_id_norm = COALESCE(token_id, '')
           WHERE token_id_norm IS NULL
        `);

        // Keep it updated for new rows (trigger)
        await pg.query(`
          CREATE OR REPLACE FUNCTION digest_events_set_token_id_norm()
          RETURNS trigger AS $$
          BEGIN
            NEW.token_id_norm := COALESCE(NEW.token_id, '');
            RETURN NEW;
          END;
          $$ LANGUAGE plpgsql;
        `);

        await pg.query(`
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_trigger WHERE tgname = 'trg_digest_events_token_norm'
            ) THEN
              CREATE TRIGGER trg_digest_events_token_norm
              BEFORE INSERT OR UPDATE ON digest_events
              FOR EACH ROW EXECUTE FUNCTION digest_events_set_token_id_norm();
            END IF;
          END $$;
        `);

        hasNorm = true;
      } catch (e2) {
        hasNorm = false;
        if (DEBUG) console.warn("[DIGEST_LOG] token_id_norm setup failed:", e2?.message || e2);
      }
    }

    // Unique index using normalized token id so NULLs dedupe
    if (hasNorm) {
      try {
        await pg.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_events_guild_type_tx_token_norm
          ON digest_events (guild_id, event_type, tx_hash, token_id_norm);
        `);
      } catch (e) {
        if (DEBUG) console.warn("[DIGEST_LOG] unique norm index create failed:", e?.message || e);
        hasNorm = false;
      }
    }

    client.__digestHasNormKey = !!hasNorm;

    client.__digestSchemaReady = true;
    if (DEBUG) console.log("[DIGEST_LOG] schema ready (normKey=" + (client.__digestHasNormKey ? "1" : "0") + ")");
    return true;
  } catch (e) {
    if (DEBUG) console.warn("[DIGEST_LOG] schema init failed:", e?.message || e);
    return false;
  }
}

/**
 * event = {
 *  guildId: string (required)
 *  eventType: 'mint' | 'sale' (required)   // NOTE: swaps/tokens should log as 'sale' with tokenId null
 *  chain?: 'base'|'eth'|'ape'|...
 *  contract?: string
 *  tokenId?: string|number|null
 *  amountNative?: number|string
 *  amountEth?: number|string
 *  amountUsd?: number|string
 *  buyer?: string
 *  seller?: string
 *  txHash?: string
 *  ts?: Date (optional)
 * }
 */
async function logDigestEvent(client, event) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return false;

    await ensureDigestSchema(client);

    const guildId = cleanStr(event?.guildId, 64);
    let eventType = cleanStr(event?.eventType, 16);

    if (!guildId || !eventType) return false;

    // Normalize event type (protect schema expectations)
    eventType = eventType.toLowerCase();
    if (eventType !== "mint" && eventType !== "sale") {
      // We keep it strict because the digest aggregator expects these.
      return false;
    }

    const chain = lowerOrNull(event?.chain, 16);
    const contract = lowerOrNull(event?.contract, 120);

    // ✅ keep tokenId for bulk-mint logging + dedupe
    const tokenId = (event?.tokenId === 0 || event?.tokenId)
      ? cleanStr(String(event.tokenId), 64)
      : null;

    const amountNative = cleanNum(event?.amountNative);
    const amountEth = cleanNum(event?.amountEth);
    const amountUsd = cleanNum(event?.amountUsd);

    const buyer = lowerOrNull(event?.buyer, 120);
    const seller = lowerOrNull(event?.seller, 120);
    const txHash = lowerOrNull(event?.txHash, 140);

    const ts = event?.ts instanceof Date ? event.ts : null;

    // Fallback soft-guard ONLY if we failed to set up normKey
    if (txHash && !tokenId && !client.__digestHasNormKey) {
      const dup = await pg.query(
        `SELECT 1
           FROM digest_events
          WHERE guild_id = $1
            AND event_type = $2
            AND tx_hash = $3
            AND ts > NOW() - INTERVAL '36 hours'
          LIMIT 1`,
        [guildId, eventType, txHash]
      );
      if (dup.rowCount > 0) return true;
    }

    // ✅ HARD dedupe via unique key
    // If token_id_norm exists we use the normalized ON CONFLICT target (dedupes NULL tokenIds).
    // Otherwise fall back to legacy key + optional soft-guard above.
    if (client.__digestHasNormKey) {
      await pg.query(
        `INSERT INTO digest_events (
          guild_id, event_type, chain, contract, token_id,
          amount_native, amount_eth, amount_usd,
          buyer, seller, tx_hash, ts
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,
          $9,$10,$11,
          COALESCE($12, NOW())
        )
        ON CONFLICT (guild_id, event_type, tx_hash, token_id_norm)
        DO NOTHING`,
        [
          guildId, eventType, chain, contract, tokenId,
          amountNative, amountEth, amountUsd,
          buyer, seller, txHash,
          ts
        ]
      );
    } else {
      await pg.query(
        `INSERT INTO digest_events (
          guild_id, event_type, chain, contract, token_id,
          amount_native, amount_eth, amount_usd,
          buyer, seller, tx_hash, ts
        ) VALUES (
          $1,$2,$3,$4,$5,
          $6,$7,$8,
          $9,$10,$11,
          COALESCE($12, NOW())
        )
        ON CONFLICT (guild_id, event_type, tx_hash, token_id)
        DO NOTHING`,
        [
          guildId, eventType, chain, contract, tokenId,
          amountNative, amountEth, amountUsd,
          buyer, seller, txHash,
          ts
        ]
      );
    }

    if (DEBUG) {
      console.log(
        `[DIGEST_LOG] ${eventType} guild=${guildId} chain=${chain || "-"} ` +
        `contract=${(contract || "").slice(0, 12)} token=${tokenId || "-"} ` +
        `tx=${txHash ? txHash.slice(0, 12) : "-"}`
      );
    }

    return true;
  } catch (e) {
    if (DEBUG) console.warn("[DIGEST_LOG] failed:", e?.message || e);
    return false;
  }
}

module.exports = { logDigestEvent };

