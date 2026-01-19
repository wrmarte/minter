// scripts/lurkerListerAction.js
// ======================================================
// GitHub Actions Lister: pulls OpenSea listing events and pushes into DB inbox
// - No Discord client needed
// - Reads enabled lurker_rules
// - Uses OpenSea v1 events endpoint (same as your existing source)
// - Writes into lurker_inbox for the bot (LURKER_SOURCE=inbox)
//
// ENV REQUIRED (GitHub Secrets):
//   DATABASE_URL=postgresql://...
//   OPENSEA_API_KEY=... (recommended)
//
// OPTIONAL:
//   LISTER_LIMIT=25
//   LISTER_DEBUG=1
// ======================================================

const { Pool } = require("pg");
const fetch = require("node-fetch");
const crypto = require("crypto");

function s(v) { return String(v || "").trim(); }
function lower(v) { return s(v).toLowerCase(); }
function debugOn() { return s(process.env.LISTER_DEBUG) === "1"; }

const DATABASE_URL = s(process.env.DATABASE_URL);
if (!DATABASE_URL) {
  console.error("❌ DATABASE_URL missing");
  process.exit(1);
}

const OPENSEA_API_KEY = s(process.env.OPENSEA_API_KEY);
const LIMIT = Math.min(50, Math.max(1, Number(process.env.LISTER_LIMIT || 25)));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 2,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 20000,
});

function sha1(x) {
  return crypto.createHash("sha1").update(String(x)).digest("hex");
}

function osHeaders() {
  const h = {
    accept: "application/json",
    "user-agent": "MuscleMB-Lister/1.0 (github-actions)",
  };
  if (OPENSEA_API_KEY) h["x-api-key"] = OPENSEA_API_KEY;
  return h;
}

async function ensureInboxSchema(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS lurker_inbox (
      rule_id INTEGER NOT NULL,
      listing_id TEXT NOT NULL,
      chain TEXT NOT NULL,
      contract TEXT NOT NULL,
      token_id TEXT NOT NULL,
      opensea_url TEXT,
      source TEXT DEFAULT 'opensea',
      created_at TIMESTAMP DEFAULT NOW(),
      PRIMARY KEY(rule_id, listing_id)
    );
  `);

  await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_cc ON lurker_inbox(chain, contract);`);
  await pg.query(`CREATE INDEX IF NOT EXISTS idx_lurker_inbox_created ON lurker_inbox(created_at);`);

  // Optional: add watch_url column for future (doesn't break anything)
  await pg.query(`ALTER TABLE lurker_rules ADD COLUMN IF NOT EXISTS watch_url TEXT;`).catch(() => {});
}

async function getEnabledRules(pg) {
  const r = await pg.query(`
    SELECT id, chain, contract
    FROM lurker_rules
    WHERE enabled=TRUE
    ORDER BY id DESC
    LIMIT 200
  `);
  return r.rows || [];
}

async function fetchOpenSeaCreatedEvents(contractLower) {
  const base = "https://api.opensea.io";
  const url =
    `${base}/api/v1/events?` +
    `event_type=created&asset_contract_address=${encodeURIComponent(contractLower)}` +
    `&only_opensea=false&offset=0&limit=${encodeURIComponent(String(LIMIT))}`;

  if (debugOn()) console.log(`[LISTER][opensea] url=${url}`);

  const res = await fetch(url, { headers: osHeaders() });
  const txt = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(`OpenSea ${res.status}: ${txt.slice(0, 220)}`);
  }

  const data = txt ? JSON.parse(txt) : {};
  const events = Array.isArray(data?.asset_events) ? data.asset_events : [];
  return events;
}

function parseEventsToListings(events, chain, contractLower) {
  return events.map(ev => {
    const asset = ev?.asset || {};
    const tokenId = s(asset?.token_id);
    if (!tokenId) return null;

    const permalink = s(asset?.permalink) || null;
    const listingId = s(
      ev?.id ||
      ev?.order_hash ||
      ev?.transaction?.transaction_hash ||
      `${contractLower}:${tokenId}:${ev?.created_date || ""}`
    );

    if (!listingId) return null;

    return {
      chain: lower(chain || "base"),
      contract: contractLower,
      tokenId,
      listingId: sha1(listingId), // normalize dedupe id
      openseaUrl: permalink,
      createdAt: ev?.created_date || ev?.created_at || null,
    };
  }).filter(Boolean);
}

async function insertInbox(pg, ruleId, listing) {
  const q = `
    INSERT INTO lurker_inbox(rule_id, listing_id, chain, contract, token_id, opensea_url, source)
    VALUES($1,$2,$3,$4,$5,$6,'opensea')
    ON CONFLICT DO NOTHING
  `;
  const vals = [
    Number(ruleId),
    s(listing.listingId),
    s(listing.chain),
    s(listing.contract),
    s(listing.tokenId),
    listing.openseaUrl || null,
  ];

  const r = await pg.query(q, vals);
  return (r.rowCount || 0) > 0;
}

async function main() {
  const pg = await pool.connect();
  try {
    await ensureInboxSchema(pg);

    const rules = await getEnabledRules(pg);
    console.log(`🟢 ListerAction: enabled rules=${rules.length}`);

    let totalInserted = 0;

    for (const rule of rules) {
      const chain = lower(rule.chain);
      const contract = lower(rule.contract);

      if (!contract.startsWith("0x") || contract.length < 42) continue;

      try {
        const events = await fetchOpenSeaCreatedEvents(contract);
        const listings = parseEventsToListings(events, chain, contract);

        let insertedThisRule = 0;

        for (const l of listings) {
          const ok = await insertInbox(pg, rule.id, l);
          if (ok) {
            insertedThisRule++;
            totalInserted++;
          }
          if (insertedThisRule >= 10) break; // cap per rule per run
        }

        if (debugOn()) {
          console.log(`[LISTER] rule#${rule.id} contract=${contract.slice(0,10)}.. events=${events.length} inserted=${insertedThisRule}`);
        }
      } catch (e) {
        console.log(`[LISTER] rule#${rule.id} error: ${e?.message || e}`);
      }
    }

    console.log(`✅ ListerAction done. totalInserted=${totalInserted}`);
  } finally {
    pg.release();
    await pool.end().catch(() => null);
  }
}

main().catch((e) => {
  console.error("❌ ListerAction fatal:", e?.message || e);
  process.exit(1);
});
