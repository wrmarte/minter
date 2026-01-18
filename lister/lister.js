// lister/lister.js
// ======================================================
// LURKER LISTER (External)
// - Runs outside Railway (where OpenSea is not blocked)
// - Reads enabled lurker_rules from Postgres
// - Polls OpenSea "created" events for each distinct (chain, contract)
// - Inserts listings into lurker_inbox (deduped)
//
// ENV REQUIRED:
//   DATABASE_URL=postgres://...   (your Railway Postgres URL)
//   OPENSEA_API_KEY=...           (recommended)
//
// ENV OPTIONAL:
//   LISTER_POLL_MS=20000
//   LISTER_LIMIT=25
//   LISTER_DEBUG=1
//
//   OPENSEA_BASE_URL=https://api.opensea.io
//   OPENSEA_TIMEOUT_MS=25000
//   OPENSEA_RETRIES=2
//   OPENSEA_RETRY_BASE_MS=600
//
// ======================================================

require("dotenv").config();

const { Pool } = require("pg");

let fetchFn = null;
try {
  fetchFn = global.fetch ? global.fetch.bind(global) : require("node-fetch");
} catch {
  fetchFn = require("node-fetch");
}

function s(v) { return String(v || "").trim(); }
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function debugOn() { return String(process.env.LISTER_DEBUG || "0").trim() === "1"; }
function chainNorm(v) { return s(v).toLowerCase(); }

function osBase() {
  return s(process.env.OPENSEA_BASE_URL || "https://api.opensea.io").replace(/\/+$/, "");
}

function osHeaders() {
  const h = {
    accept: "application/json",
    "user-agent": "MuscleMB-LURKER-LISTER/1.0"
  };
  const key = s(process.env.OPENSEA_API_KEY);
  if (key) h["x-api-key"] = key;
  return h;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(ms) {
  const j = ms * 0.15;
  return Math.max(0, Math.floor(ms + (Math.random() * 2 - 1) * j));
}

async function fetchWithAbort(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Convert wei string -> decimal ETH string (best effort)
function weiToEthStr(weiStr) {
  try {
    const w = BigInt(String(weiStr || "0"));
    const whole = w / 1000000000000000000n;
    const frac = w % 1000000000000000000n;
    if (frac === 0n) return whole.toString();
    const fracStr = frac.toString().padStart(18, "0").slice(0, 6).replace(/0+$/, "");
    return fracStr ? `${whole}.${fracStr}` : whole.toString();
  } catch {
    return null;
  }
}

async function fetchOpenSeaCreatedEvents({ contract, limit = 25 }) {
  const contractL = s(contract).toLowerCase();

  const qs = [];
  qs.push(`event_type=created`);
  qs.push(`asset_contract_address=${encodeURIComponent(contractL)}`);
  qs.push(`only_opensea=false`);
  qs.push(`offset=0`);
  qs.push(`limit=${encodeURIComponent(String(Math.min(50, Math.max(1, limit))))}`);

  const url = `${osBase()}/api/v1/events?${qs.join("&")}`;

  const timeoutMs = Math.max(8000, num(process.env.OPENSEA_TIMEOUT_MS, 25000));
  const retries = Math.max(1, Math.min(6, num(process.env.OPENSEA_RETRIES, 2)));
  const baseBackoff = Math.max(200, num(process.env.OPENSEA_RETRY_BASE_MS, 600));

  let lastErr = null;

  for (let i = 0; i < retries; i++) {
    try {
      const attemptTimeout = Math.min(90000, timeoutMs + i * 10000);

      if (debugOn()) console.log(`[LISTER][opensea] url=${url} (attempt ${i + 1}/${retries})`);

      const t0 = Date.now();
      const res = await fetchWithAbort(url, { headers: osHeaders() }, attemptTimeout);
      const elapsed = Date.now() - t0;

      const ct = s(res.headers.get("content-type") || "");
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenSea ${res.status}: ${txt.slice(0, 220)} | elapsedMs=${elapsed} ct=${ct}`);
      }

      // Sometimes Cloudflare returns HTML even with 200
      if (ct.includes("text/html")) {
        const txt = await res.text().catch(() => "");
        throw new Error(`OpenSea HTML response (blocked?) ${txt.slice(0, 120)} | elapsedMs=${elapsed}`);
      }

      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") throw new Error(`OpenSea bad json | elapsedMs=${elapsed}`);

      return data;
    } catch (e) {
      lastErr = e;
      const waitMs = jitter(baseBackoff * Math.pow(2, i));
      console.log(`[LISTER][opensea] retry ${i + 1}/${retries} in ${waitMs}ms — ${e?.message || e}`);
      if (i < retries - 1) await sleep(waitMs);
    }
  }

  throw lastErr || new Error("OpenSea fetch failed");
}

function normalizeListingsFromEvents({ chain, contract, data }) {
  const events = Array.isArray(data?.asset_events) ? data.asset_events : [];
  const contractL = s(contract).toLowerCase();

  return events.map(ev => {
    const asset = ev?.asset || {};
    const tokenId = s(asset?.token_id);

    const listingId = s(
      ev?.id ||
      ev?.order_hash ||
      ev?.transaction?.transaction_hash ||
      `${contractL}:${tokenId}:${ev?.created_date || ""}`
    );

    const priceNative = ev?.starting_price != null ? weiToEthStr(ev.starting_price) : null;

    const payment = ev?.payment_token || {};
    const currency = s(payment?.symbol) || "ETH";

    const image = s(asset?.image_url || asset?.image_preview_url || asset?.image_thumbnail_url);
    const name = s(asset?.name);
    const openseaUrl = s(asset?.permalink);

    const seller = s(ev?.seller?.address || ev?.from_account?.address);

    return {
      source: "opensea",
      chain: chainNorm(chain || "eth"),
      contract: contractL,
      listingId,
      tokenId,
      name: name || null,
      image: image || null,
      openseaUrl: openseaUrl || null,
      seller: seller || null,
      priceNative: priceNative != null ? priceNative : null,
      priceCurrency: currency || null,
      createdAt: ev?.created_date || ev?.created_at || null,
      raw: ev || null
    };
  }).filter(x => x.listingId && x.tokenId);
}

async function ensureInboxTable(pg) {
  // Keep this lister self-contained (no dependency on bot schema loader)
  await pg.query(`
    CREATE TABLE IF NOT EXISTS lurker_inbox (
      id BIGSERIAL PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'opensea',
      chain TEXT NOT NULL,
      contract TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      name TEXT,
      image TEXT,
      opensea_url TEXT,
      seller TEXT,
      price_native NUMERIC,
      price_currency TEXT,
      created_at TIMESTAMP,
      raw JSONB,
      inserted_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(listing_id)
    );
  `);

  await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_cc ON lurker_inbox(chain, contract);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_inserted ON lurker_inbox(inserted_at);`);
}

async function loadTargets(pg) {
  // Distinct collection targets from enabled rules
  const r = await pg.query(`
    SELECT DISTINCT chain, contract
    FROM lurker_rules
    WHERE enabled=TRUE
    ORDER BY contract
  `);

  return (r.rows || []).map(x => ({
    chain: chainNorm(x.chain),
    contract: s(x.contract).toLowerCase()
  })).filter(t => t.contract && t.contract.startsWith("0x"));
}

async function insertInbox(pg, listings) {
  if (!listings.length) return 0;

  // Insert one by one (safe + simple). UNIQUE(listing_id) prevents duplicates.
  let inserted = 0;

  for (const it of listings) {
    const res = await pg.query(
      `
      INSERT INTO lurker_inbox(
        source, chain, contract, listing_id, token_id,
        name, image, opensea_url, seller,
        price_native, price_currency, created_at, raw
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
      ON CONFLICT(listing_id) DO NOTHING
      `,
      [
        it.source || "opensea",
        it.chain,
        it.contract,
        it.listingId,
        it.tokenId,
        it.name || null,
        it.image || null,
        it.openseaUrl || null,
        it.seller || null,
        it.priceNative != null ? it.priceNative : null,
        it.priceCurrency || null,
        it.createdAt ? new Date(it.createdAt) : null,
        it.raw ? JSON.stringify(it.raw) : null
      ]
    );
    if ((res.rowCount || 0) > 0) inserted += 1;
  }

  return inserted;
}

async function pruneOld(pg) {
  // Keep inbox small: delete entries older than 7 days
  await pg.query(`DELETE FROM lurker_inbox WHERE inserted_at < NOW() - INTERVAL '7 days'`).catch(() => null);
}

async function main() {
  const dbUrl = s(process.env.DATABASE_URL);
  if (!dbUrl) {
    console.error("❌ DATABASE_URL missing");
    process.exit(1);
  }

  const pollMs = Math.max(7000, num(process.env.LISTER_POLL_MS, 20000));
  const limit = Math.min(50, Math.max(1, num(process.env.LISTER_LIMIT, 25)));

  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });

  console.log(`🟢 [LISTER] starting pollMs=${pollMs} limit=${limit}`);

  // sanity
  const pg = await pool.connect();
  try {
    await ensureInboxTable(pg);
    console.log("✅ [LISTER] inbox table ready");
  } finally {
    pg.release();
  }

  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;

    const client = await pool.connect();
    try {
      const targets = await loadTargets(client);
      if (debugOn()) console.log(`🟢 [LISTER] targets=${targets.length}`);

      for (const t of targets) {
        try {
          const data = await fetchOpenSeaCreatedEvents({ contract: t.contract, limit });
          const listings = normalizeListingsFromEvents({ chain: t.chain, contract: t.contract, data });
          const ins = await insertInbox(client, listings);
          if (debugOn() || ins > 0) {
            console.log(`✅ [LISTER] ${t.chain}:${t.contract.slice(0, 10)}.. listings=${listings.length} inserted=${ins}`);
          }
        } catch (e) {
          console.log(`⚠️ [LISTER] ${t.chain}:${t.contract.slice(0, 10)}.. error: ${e?.message || e}`);
        }
      }

      await pruneOld(client);
    } catch (e) {
      console.log("⚠️ [LISTER] tick error:", e?.message || e);
    } finally {
      client.release();
      running = false;
    }
  };

  // run soon, then interval
  setTimeout(tick, 1500);
  setInterval(tick, pollMs);
}

main().catch(e => {
  console.error("❌ [LISTER] fatal:", e?.message || e);
  process.exit(1);
});
