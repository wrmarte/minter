// services/digestLogger.js
// Lightweight event logger for Daily Digest
// Call this whenever you detect a mint/sale and/or post a notification.

const DEBUG = String(process.env.DIGEST_LOG_DEBUG || "").trim() === "1";

function dlog(...args) {
  if (DEBUG) console.log("[DIGEST_LOG]", ...args);
}
function dwarn(...args) {
  if (DEBUG) console.warn("[DIGEST_LOG]", ...args);
}

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

function pick(obj, keys) {
  if (!obj) return undefined;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  return undefined;
}

function normalizeChain(v) {
  const s = lowerOrNull(v, 24);
  if (!s) return null;
  if (s === "ethereum" || s === "mainnet" || s === "eth-mainnet") return "eth";
  if (s === "base-mainnet" || s === "basechain") return "base";
  if (s === "apechain" || s === "ape") return "ape";
  return s;
}

// Accept common synonyms and normalize to the two types the digest expects.
function normalizeEventType(v) {
  const raw = lowerOrNull(v, 32);
  if (!raw) return null;

  // already canonical
  if (raw === "mint" || raw === "sale") return raw;

  // mint-ish
  if (
    raw === "minted" ||
    raw === "mints" ||
    raw === "mint_event" ||
    raw === "mint-event" ||
    raw === "newmint" ||
    raw === "new_mint" ||
    raw === "nft_mint" ||
    raw === "nftmint"
  ) {
    return "mint";
  }

  // sale-ish / swap-ish / buy-ish (log these as "sale" for digest purposes)
  if (
    raw === "sold" ||
    raw === "sell" ||
    raw === "sales" ||
    raw === "swap" ||
    raw === "swaps" ||
    raw === "token" ||
    raw === "tokenbuy" ||
    raw === "token_buy" ||
    raw === "buy" ||
    raw === "purchase" ||
    raw === "trade" ||
    raw === "transfer_sale" ||
    raw === "nft_sale" ||
    raw === "nftsale"
  ) {
    return "sale";
  }

  return null;
}

// One-time schema init per process (and de-duped per client instance)
async function ensureDigestSchema(client) {
  try {
    if (client.__digestSchemaReady) return true;

    // prevent concurrent schema runs within same process/client
    if (client.__digestSchemaPromise) return await client.__digestSchemaPromise;

    const pg = client?.pg;
    if (!pg?.query) return false;

    client.__digestSchemaPromise = (async () => {
      try {
        await pg.query(`
          CREATE TABLE IF NOT EXISTS digest_events (
            id            BIGSERIAL PRIMARY KEY,
            guild_id      TEXT NOT NULL,
            event_type    TEXT NOT NULL,              -- 'mint' | 'sale'
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

        // ✅ HARD DEDUPE FIX: normalize token_id NULL -> '' using token_id_norm
        // Makes swaps/tokens (token_id NULL) dedupe properly on (guild,type,tx).
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
          hasNorm = col.rowCount > 0;

          if (!hasNorm) {
            // Prefer generated column (PG 12+). Railway PG typically supports this.
            await pg.query(`
              ALTER TABLE digest_events
              ADD COLUMN token_id_norm TEXT GENERATED ALWAYS AS (COALESCE(token_id, '')) STORED
            `);
            hasNorm = true;
          }
        } catch (e) {
          // Fallback: plain column + backfill + trigger
          try {
            await pg.query(`
              ALTER TABLE digest_events
              ADD COLUMN IF NOT EXISTS token_id_norm TEXT
            `);

            // default helps new rows even if trigger creation fails
            try {
              await pg.query(`ALTER TABLE digest_events ALTER COLUMN token_id_norm SET DEFAULT ''`);
            } catch (_) {}

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

            // best-effort tighten to NOT NULL (optional)
            try {
              await pg.query(`
                UPDATE digest_events
                   SET token_id_norm = COALESCE(token_id, '')
                 WHERE token_id_norm IS NULL
              `);
              await pg.query(`ALTER TABLE digest_events ALTER COLUMN token_id_norm SET NOT NULL`);
            } catch (_) {}

            hasNorm = true;
          } catch (e2) {
            hasNorm = false;
            dwarn("token_id_norm setup failed:", e2?.message || e2);
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
            dwarn("unique norm index create failed:", e?.message || e);
            hasNorm = false;
          }
        }

        client.__digestHasNormKey = !!hasNorm;
        client.__digestSchemaReady = true;

        dlog("schema ready (normKey=" + (client.__digestHasNormKey ? "1" : "0") + ")");
        return true;
      } catch (e) {
        dwarn("schema init failed:", e?.message || e);
        return false;
      } finally {
        // allow retries if schema failed
        delete client.__digestSchemaPromise;
      }
    })();

    return await client.__digestSchemaPromise;
  } catch (e) {
    dwarn("schema init outer failed:", e?.message || e);
    return false;
  }
}

/**
 * event = {
 *  guildId: string (required)
 *  eventType: 'mint' | 'sale' (required)
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
 *
 * ALSO ACCEPTS common alternate key names to avoid silent drops:
 *  guild_id / guild
 *  event_type / type / kind
 *  contractAddress / nftContract / tokenContract
 *  token_id / tokenID / token
 *  tx / hash / transactionHash
 */
async function logDigestEvent(client, event) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return false;

    await ensureDigestSchema(client);

    // accept alt keys (this fixes “nothing logged” when callers pass snake_case)
    const guildId = cleanStr(
      pick(event, ["guildId", "guild_id", "guild", "guildID"]),
      64
    );

    let eventType = normalizeEventType(
      pick(event, ["eventType", "event_type", "type", "kind"])
    );

    if (!guildId || !eventType) {
      if (DEBUG) {
        dlog(
          "reject: missing guildId/eventType",
          "guildId=",
          guildId,
          "eventType=",
          pick(event, ["eventType", "event_type", "type", "kind"])
        );
      }
      return false;
    }

    const chain = normalizeChain(pick(event, ["chain", "network"]));

    const contract = lowerOrNull(
      pick(event, ["contract", "contractAddress", "nftContract", "tokenContract", "ca"]),
      120
    );

    const rawTokenId = pick(event, ["tokenId", "token_id", "tokenID", "token", "id"]);
    const tokenId =
      rawTokenId === 0 || rawTokenId
        ? cleanStr(String(rawTokenId), 64)
        : null;

    const amountNative = cleanNum(pick(event, ["amountNative", "amount_native", "nativeAmount", "amount"]));
    const amountEth = cleanNum(pick(event, ["amountEth", "amount_eth", "ethAmount"]));
    const amountUsd = cleanNum(pick(event, ["amountUsd", "amount_usd", "usdAmount"]));

    const buyer = lowerOrNull(pick(event, ["buyer", "to", "recipient"]), 120);
    const seller = lowerOrNull(pick(event, ["seller", "from", "sender"]), 120);

    const txHash = lowerOrNull(
      pick(event, ["txHash", "tx_hash", "tx", "hash", "transactionHash"]),
      140
    );

    const tsRaw = pick(event, ["ts", "timestamp", "time"]);
    const ts = tsRaw instanceof Date ? tsRaw : null;

    // Fallback soft-guard ONLY if we failed to set up normKey
    // (this prevents swap/token duplicates where tokenId is null)
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
      if (dup.rowCount > 0) return true; // treat as "logged" (deduped)
    }

    const params = [
      guildId, eventType, chain, contract, tokenId,
      amountNative, amountEth, amountUsd,
      buyer, seller, txHash,
      ts
    ];

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
        params
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
        params
      );
    }

    dlog(
      `${eventType} guild=${guildId} chain=${chain || "-"} ` +
        `contract=${(contract || "").slice(0, 12) || "-"} token=${tokenId || "-"} ` +
        `tx=${txHash ? txHash.slice(0, 12) : "-"}`
    );

    return true;
  } catch (e) {
    dwarn("failed:", e?.message || e);
    return false;
  }
}

module.exports = { logDigestEvent, ensureDigestSchema };
