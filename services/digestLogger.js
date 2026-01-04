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
        contract      TEXT DEFAULT NULL,          -- nft contract
        token_id      TEXT DEFAULT NULL,

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

    // ✅ HARD DEDUPE (bulk-safe): per guild + type + tx + token_id
    // - token_id NULLs can still duplicate (rare), but our insert normalizes token_id when present.
    await pg.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_events_guild_type_tx_token
      ON digest_events (guild_id, event_type, tx_hash, token_id);
    `);

    client.__digestSchemaReady = true;
    if (DEBUG) console.log("[DIGEST_LOG] schema ready");
    return true;
  } catch (e) {
    if (DEBUG) console.warn("[DIGEST_LOG] schema init failed:", e?.message || e);
    return false;
  }
}

/**
 * event = {
 *  guildId: string (required)
 *  eventType: 'mint' | 'sale' (required)
 *  chain?: 'base'|'eth'|'ape'|...
 *  contract?: string
 *  tokenId?: string|number
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
    const eventType = cleanStr(event?.eventType, 16);

    if (!guildId || !eventType) return false;

    const chain = cleanStr(event?.chain, 16);
    const contract = cleanStr(event?.contract, 120);

    // ✅ IMPORTANT: keep tokenId for bulk-mint logging + dedupe
    // normalize to string if provided
    const tokenId = (event?.tokenId === 0 || event?.tokenId)
      ? cleanStr(String(event.tokenId), 64)
      : null;

    const amountNative = cleanNum(event?.amountNative);
    const amountEth = cleanNum(event?.amountEth);
    const amountUsd = cleanNum(event?.amountUsd);

    const buyer = cleanStr(event?.buyer, 120);
    const seller = cleanStr(event?.seller, 120);
    const txHash = cleanStr(event?.txHash, 140);

    const ts = event?.ts instanceof Date ? event.ts : null;

    // ✅ If tokenId is missing, do a soft guard on (guild+type+txHash) to avoid spam duplicates
    // (bulk mints always pass tokenId per row, so they won't be blocked here)
    if (txHash && !tokenId) {
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

    // ✅ HARD dedupe via unique index (ON CONFLICT DO NOTHING)
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
