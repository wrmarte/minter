// services/digestLogger.js
// Lightweight event logger for Daily Digest
// Call this whenever you detect a mint/sale and/or post a notification.
//
// ✅ Patch goals (fix Token Buys/Sells showing 0):
// 1) Preserve “what kind of sale” via sub_type: 'swap' | 'token_buy' | 'token_sell' | 'nft_sale' etc.
// 2) Allow callers to pass eventType like 'buy'/'sell'/'token_buy'/'token_sell'/'swap' and STILL log,
//    while keeping canonical event_type strictly 'mint' | 'sale' for the digest aggregator.
// 3) Keep hard dedupe for NULL token_id via token_id_norm.

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
  if (s === "apechain") return "ape";
  return s;
}

/**
 * Normalize event type into canonical event_type ('mint'|'sale') PLUS optional sub_type.
 * This is the key fix so your digest can split:
 * - Swaps (sub_type='swap')
 * - Token Buys (sub_type='token_buy')
 * - Token Sells (sub_type='token_sell')
 * while event_type stays 'sale' for all of them.
 */
function normalizeTypeAndSubType(rawType, explicitSubType) {
  const rt = lowerOrNull(rawType, 40);
  let sub = lowerOrNull(explicitSubType, 40);

  // If caller already set subType, respect it and just normalize event_type.
  // (Still allow eventType to be mint/sale/buy/sell/etc.)
  if (sub) {
    if (rt === "mint" || rt === "minted" || rt === "nft_mint" || rt === "nftmint" || rt === "mints") {
      return { eventType: "mint", subType: sub };
    }
    return { eventType: "sale", subType: sub };
  }

  if (!rt) return { eventType: null, subType: null };

  // Canonical
  if (rt === "mint") return { eventType: "mint", subType: null };
  if (rt === "sale") return { eventType: "sale", subType: null };

  // Mint-ish
  if (rt === "minted" || rt === "mints" || rt === "mint_event" || rt === "mint-event" || rt === "newmint" || rt === "new_mint") {
    return { eventType: "mint", subType: null };
  }

  // Explicit token buy/sell labels
  if (rt === "token_buy" || rt === "tokenbuy" || rt === "buy") {
    return { eventType: "sale", subType: "token_buy" };
  }
  if (rt === "token_sell" || rt === "tokensell" || rt === "sell") {
    return { eventType: "sale", subType: "token_sell" };
  }

  // Swaps / trades
  if (rt === "swap" || rt === "swaps" || rt === "trade" || rt === "swap_event" || rt === "swap-event") {
    return { eventType: "sale", subType: "swap" };
  }

  // NFT sale labels (optional; useful if your aggregator uses this)
  if (rt === "nft_sale" || rt === "nftsale" || rt === "sold") {
    return { eventType: "sale", subType: "nft_sale" };
  }

  // Unknown -> reject (keeps schema expectations strict)
  return { eventType: null, subType: null };
}

// One-time schema init per process
async function ensureDigestSchema(client) {
  try {
    if (client.__digestSchemaReady) return true;
    if (client.__digestSchemaPromise) return await client.__digestSchemaPromise;

    const pg = client?.pg;
    if (!pg?.query) return false;

    client.__digestSchemaPromise = (async () => {
      try {
        await pg.query(`
          CREATE TABLE IF NOT EXISTS digest_events (
            id            BIGSERIAL PRIMARY KEY,
            guild_id      TEXT NOT NULL,
            event_type    TEXT NOT NULL,              -- 'mint' | 'sale' (canonical)
            sub_type      TEXT DEFAULT NULL,          -- 'swap' | 'token_buy' | 'token_sell' | 'nft_sale' | etc
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

        // Backfill: if table existed before sub_type column, add it
        try {
          await pg.query(`ALTER TABLE digest_events ADD COLUMN IF NOT EXISTS sub_type TEXT DEFAULT NULL;`);
        } catch (_) {}

        await pg.query(`
          CREATE INDEX IF NOT EXISTS idx_digest_events_guild_ts
          ON digest_events (guild_id, ts DESC);
        `);

        await pg.query(`
          CREATE INDEX IF NOT EXISTS idx_digest_events_guild_type_ts
          ON digest_events (guild_id, event_type, ts DESC);
        `);

        await pg.query(`
          CREATE INDEX IF NOT EXISTS idx_digest_events_guild_subtype_ts
          ON digest_events (guild_id, sub_type, ts DESC);
        `);

        // ✅ Legacy unique (kept for backward compatibility)
        // NOTE: token_id NULLs do not collide in Postgres, so this won't dedupe swaps.
        await pg.query(`
          CREATE UNIQUE INDEX IF NOT EXISTS uq_digest_events_guild_type_tx_token
          ON digest_events (guild_id, event_type, tx_hash, token_id);
        `);

        // ✅ HARD DEDUPE FIX: normalize token_id NULL -> '' using token_id_norm
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

            try {
              await pg.query(`ALTER TABLE digest_events ALTER COLUMN token_id_norm SET DEFAULT ''`);
            } catch (_) {}

            await pg.query(`
              UPDATE digest_events
                 SET token_id_norm = COALESCE(token_id, '')
               WHERE token_id_norm IS NULL
            `);

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
 *  eventType: 'mint'|'sale' OR synonyms like 'buy'/'sell'/'swap'/'token_buy'/'token_sell'
 *  subType?: string (optional) // 'swap'|'token_buy'|'token_sell' etc
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
 * ALSO ACCEPTS common alternate key names:
 *  guild_id / guild
 *  event_type / type / kind
 *  sub_type / subtype
 *  contractAddress / nftContract / tokenContract / ca
 *  token_id / tokenID / token
 *  tx / hash / transactionHash
 */
async function logDigestEvent(client, event) {
  try {
    const pg = client?.pg;
    if (!pg?.query) return false;

    await ensureDigestSchema(client);

    const guildId = cleanStr(pick(event, ["guildId", "guild_id", "guild", "guildID"]), 64);

    const rawType = pick(event, ["eventType", "event_type", "type", "kind"]);
    const explicitSub = pick(event, ["subType", "sub_type", "subtype"]);

    const norm = normalizeTypeAndSubType(rawType, explicitSub);
    const eventType = norm.eventType; // 'mint' | 'sale'
    const subType = lowerOrNull(norm.subType, 40); // nullable

    if (!guildId || !eventType) {
      if (DEBUG) dlog("reject: missing guildId/eventType", { guildId, rawType, explicitSub });
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

    const txHash = lowerOrNull(pick(event, ["txHash", "tx_hash", "tx", "hash", "transactionHash"]), 140);

    const tsRaw = pick(event, ["ts", "timestamp", "time"]);
    const ts = tsRaw instanceof Date ? tsRaw : null;

    // Soft-guard ONLY if normKey is not available (prevents swap duplicates when tokenId is null)
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

    const params = [
      guildId,
      eventType,
      subType,
      chain,
      contract,
      tokenId,
      amountNative,
      amountEth,
      amountUsd,
      buyer,
      seller,
      txHash,
      ts
    ];

    // ✅ Dedupe stays the same: (guild, type, tx, token_norm)
    // sub_type does NOT participate in dedupe so the same tx won't double-log.
    if (client.__digestHasNormKey) {
      await pg.query(
        `INSERT INTO digest_events (
          guild_id, event_type, sub_type, chain, contract, token_id,
          amount_native, amount_eth, amount_usd,
          buyer, seller, tx_hash, ts
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,
          $10,$11,$12,
          COALESCE($13, NOW())
        )
        ON CONFLICT (guild_id, event_type, tx_hash, token_id_norm)
        DO NOTHING`,
        params
      );
    } else {
      await pg.query(
        `INSERT INTO digest_events (
          guild_id, event_type, sub_type, chain, contract, token_id,
          amount_native, amount_eth, amount_usd,
          buyer, seller, tx_hash, ts
        ) VALUES (
          $1,$2,$3,$4,$5,$6,
          $7,$8,$9,
          $10,$11,$12,
          COALESCE($13, NOW())
        )
        ON CONFLICT (guild_id, event_type, tx_hash, token_id)
        DO NOTHING`,
        params
      );
    }

    dlog(
      `${eventType}${subType ? ":" + subType : ""} guild=${guildId} chain=${chain || "-"} ` +
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

