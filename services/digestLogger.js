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

    const guildId = cleanStr(event?.guildId, 64);
    const eventType = cleanStr(event?.eventType, 16);

    if (!guildId || !eventType) return false;

    const chain = cleanStr(event?.chain, 16);
    const contract = cleanStr(event?.contract, 120);
    const tokenId = cleanStr(event?.tokenId, 64);

    const amountNative = cleanNum(event?.amountNative);
    const amountEth = cleanNum(event?.amountEth);
    const amountUsd = cleanNum(event?.amountUsd);

    const buyer = cleanStr(event?.buyer, 120);
    const seller = cleanStr(event?.seller, 120);
    const txHash = cleanStr(event?.txHash, 140);

    const ts = event?.ts instanceof Date ? event.ts : null;

    // Optional: very light dedupe (skip if same guild+txHash already logged recently)
    // (If you want HARD dedupe, add a unique index on (guild_id, event_type, tx_hash))
    if (txHash) {
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
      )`,
      [
        guildId, eventType, chain, contract, tokenId,
        amountNative, amountEth, amountUsd,
        buyer, seller, txHash,
        ts
      ]
    );

    if (DEBUG) {
      console.log(`[DIGEST_LOG] ${eventType} guild=${guildId} chain=${chain || "-"} contract=${(contract || "").slice(0, 12)} token=${tokenId || "-"} tx=${txHash ? txHash.slice(0, 12) : "-"}`);
    }

    return true;
  } catch (e) {
    if (DEBUG) console.warn("[DIGEST_LOG] failed:", e?.message || e);
    return false;
  }
}

module.exports = { logDigestEvent };
