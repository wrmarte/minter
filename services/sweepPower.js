// sweepPower.js
// ======================================================
// Sweep-Power Sidecar (Piggy Bank Module)
// - MUST NEVER block or suppress sale/list notifications.
// - Observes BUY events and accumulates "power" with decay.
// - Stores state in Postgres for safety across restarts.
// ======================================================

const { ethers } = require("ethers");

// ---------------- CONFIG (env) ----------------
const SWEEP_POWER_CHAIN = "base";

// decay: how fast power fades over time (seconds)
const DECAY_HALF_LIFE_SEC = Number(process.env.SWEEP_POWER_HALF_LIFE_SEC || 180); // 3 min

// delta shaping
const DELTA_SQRT_ETH = String(process.env.SWEEP_POWER_SQRT_ETH || "1") === "1";
const DELTA_MIN = Number(process.env.SWEEP_POWER_DELTA_MIN || 0); // keep 0 to never suppress, only clamp
const DELTA_MAX = Number(process.env.SWEEP_POWER_DELTA_MAX || 999999);

// optional “burst” boost if sales happen close together
const BURST_WINDOW_SEC = Number(process.env.SWEEP_POWER_BURST_WINDOW_SEC || 45);
const BURST_MULT = Number(process.env.SWEEP_POWER_BURST_MULT || 1.25);

// optional unique buyer boost
const UNIQUE_BUYER_WINDOW_SEC = Number(process.env.SWEEP_POWER_UNIQUE_BUYER_WINDOW_SEC || 300);
const UNIQUE_BUYER_MULT = Number(process.env.SWEEP_POWER_UNIQUE_BUYER_MULT || 1.15);

// alert thresholds (optional)
const ALERT_ENABLED = String(process.env.SWEEP_POWER_ALERT || "").trim() === "1";
const ALERT_T1 = Number(process.env.SWEEP_POWER_ALERT_T1 || 3);
const ALERT_T2 = Number(process.env.SWEEP_POWER_ALERT_T2 || 6);
const ALERT_T3 = Number(process.env.SWEEP_POWER_ALERT_T3 || 10);

// ------------------------------------------------

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function clamp(n, a, b) {
  return Math.max(a, Math.min(b, n));
}

function decayPower(power, dtSec) {
  if (!power || power <= 0) return 0;

  // exponential half-life decay: power * 0.5^(dt/halfLife)
  const hl = Math.max(1, DECAY_HALF_LIFE_SEC);
  const factor = Math.pow(0.5, dtSec / hl);
  const out = power * factor;

  // avoid tiny float noise
  return out < 0.000001 ? 0 : out;
}

// A safe default delta formula based on ETH value.
// If token sale (no ethPaid), delta defaults small unless you extend it later.
function computeDeltaFromEvent(event) {
  // event.ethPaid is BigInt (wei)
  let ethValue = 0;

  if (event?.ethPaid && typeof event.ethPaid === "bigint" && event.ethPaid > 0n) {
    ethValue = Number(ethers.formatEther(event.ethPaid));
  } else {
    // token-based sales: we can’t reliably value without price oracle.
    // keep a small non-zero delta so activity still counts.
    ethValue = 0.02; // default “token sale weight” (tweak later)
  }

  let delta = DELTA_SQRT_ETH ? Math.sqrt(Math.max(0, ethValue)) : ethValue;

  // clamp (but do not use this to suppress notifications!)
  delta = clamp(delta, DELTA_MIN, DELTA_MAX);
  return { delta, ethValue };
}

// ---------------- DB ----------------
async function ensureSweepPowerTables(pg) {
  await pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_power_state (
      chain TEXT NOT NULL,
      scope TEXT NOT NULL,         -- e.g. "guild:<id>" or "global"
      power DOUBLE PRECISION NOT NULL DEFAULT 0,
      last_ts BIGINT NOT NULL DEFAULT 0,
      last_alert_tier INT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, scope)
    )
  `);

  await pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_power_recent (
      chain TEXT NOT NULL,
      scope TEXT NOT NULL,
      tx_hash TEXT NOT NULL,
      buyer TEXT,
      ts BIGINT NOT NULL,
      eth_value DOUBLE PRECISION,
      delta DOUBLE PRECISION NOT NULL,
      PRIMARY KEY (chain, scope, tx_hash)
    )
  `);
}

async function getState(pg, chain, scope) {
  const r = await pg.query(
    `SELECT power, last_ts, last_alert_tier FROM sweep_power_state WHERE chain=$1 AND scope=$2`,
    [chain, scope]
  );
  if (!r.rows?.length) return { power: 0, last_ts: 0, last_alert_tier: 0 };
  return {
    power: Number(r.rows[0].power || 0),
    last_ts: Number(r.rows[0].last_ts || 0),
    last_alert_tier: Number(r.rows[0].last_alert_tier || 0),
  };
}

async function setState(pg, chain, scope, power, ts, lastAlertTier) {
  await pg.query(
    `INSERT INTO sweep_power_state(chain, scope, power, last_ts, last_alert_tier)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (chain, scope)
     DO UPDATE SET power=EXCLUDED.power, last_ts=EXCLUDED.last_ts, last_alert_tier=EXCLUDED.last_alert_tier, updated_at=now()`,
    [chain, scope, power, Math.floor(ts), Math.floor(lastAlertTier)]
  );
}

async function insertRecent(pg, chain, scope, txHash, buyer, ts, ethValue, delta) {
  await pg.query(
    `INSERT INTO sweep_power_recent(chain, scope, tx_hash, buyer, ts, eth_value, delta)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (chain, scope, tx_hash) DO NOTHING`,
    [chain, scope, txHash, buyer || null, Math.floor(ts), ethValue ?? null, delta]
  );
}

// Cleanup old recent rows (keep table small)
async function pruneRecent(pg, chain, scope) {
  const cutoff = nowSec() - Math.max(60, UNIQUE_BUYER_WINDOW_SEC) - 60;
  await pg.query(
    `DELETE FROM sweep_power_recent WHERE chain=$1 AND scope=$2 AND ts < $3`,
    [chain, scope, cutoff]
  );
}

async function isBuyerUniqueRecently(pg, chain, scope, buyer) {
  if (!buyer) return false;
  const cutoff = nowSec() - UNIQUE_BUYER_WINDOW_SEC;
  const r = await pg.query(
    `SELECT 1 FROM sweep_power_recent
     WHERE chain=$1 AND scope=$2 AND buyer=$3 AND ts >= $4
     LIMIT 1`,
    [chain, scope, buyer.toLowerCase(), cutoff]
  );
  return r.rows?.length ? false : true;
}

async function wasRecentBurst(pg, chain, scope) {
  const cutoff = nowSec() - BURST_WINDOW_SEC;
  const r = await pg.query(
    `SELECT 1 FROM sweep_power_recent
     WHERE chain=$1 AND scope=$2 AND ts >= $3
     LIMIT 1`,
    [chain, scope, cutoff]
  );
  return !!r.rows?.length;
}

// ---------------- Alerts ----------------
function tierFromPower(power) {
  if (power >= ALERT_T3) return 3;
  if (power >= ALERT_T2) return 2;
  if (power >= ALERT_T1) return 1;
  return 0;
}

async function maybeAlert(client, chans, scope, power, tier, event) {
  if (!ALERT_ENABLED) return;

  const title =
    tier === 3 ? "🧨 SWEEP POWER: EXTREME" :
    tier === 2 ? "🔥 SWEEP POWER: HIGH" :
    tier === 1 ? "⚡ SWEEP POWER: BUILDING" :
    null;

  if (!title) return;

  const embed = {
    title,
    description: `Power: **${power.toFixed(2)}**\nScope: **${scope}**`,
    color: tier === 3 ? 0xff3b30 : tier === 2 ? 0xff9500 : 0x34c759,
    timestamp: new Date().toISOString(),
    footer: { text: "Sweep-Power • Piggy Bank Mode" },
  };

  // add context
  if (event?.nft && event?.tokenId) {
    embed.fields = [
      { name: "Last Sale", value: `${event.nft} #${event.tokenId}`, inline: false },
      { name: "Tx", value: `https://basescan.org/tx/${event.tx?.hash || ""}`.trim(), inline: false },
    ];
  }

  for (const c of chans) {
    await c.send({ embeds: [embed] }).catch(() => {});
  }
}

// ---------------- Public API ----------------

// call once at startup
async function initSweepPower(client) {
  try {
    await ensureSweepPowerTables(client.pg);
  } catch (e) {
    // never crash caller
    console.log("[SWEEP-POWER] init error:", e?.message || e);
  }
}

/**
 * Apply Sweep-Power update for a detected event.
 * MUST be called AFTER sendEmbed() in CompleteSweepJS.
 *
 * @param {object} client discord client (must have .pg)
 * @param {object} chans resolved channels array (same as notifier uses)
 * @param {object} event result from analyzeTx() (type BUY/LIST)
 * @param {object} opts { scope?: string } scope defaults "global"
 */
async function applySweepPower(client, chans, event, opts = {}) {
  // Only BUY events contribute to sweep momentum
  if (!event || event.type !== "BUY") return;

  const scope = opts.scope || "global";
  const chain = SWEEP_POWER_CHAIN;

  try {
    await ensureSweepPowerTables(client.pg);

    const ts = nowSec();
    const state = await getState(client.pg, chain, scope);

    // decay since last update
    const dt = state.last_ts ? Math.max(0, ts - state.last_ts) : 0;
    let power = decayPower(state.power, dt);

    // base delta
    const { delta: baseDelta, ethValue } = computeDeltaFromEvent(event);
    let delta = baseDelta;

    // burst boost (if there was activity very recently)
    const burst = await wasRecentBurst(client.pg, chain, scope);
    if (burst) delta *= BURST_MULT;

    // unique buyer boost
    const buyer = (event.buyer || "").toLowerCase();
    const unique = await isBuyerUniqueRecently(client.pg, chain, scope, buyer);
    if (unique) delta *= UNIQUE_BUYER_MULT;

    // add to piggy bank
    power = power + delta;

    // record recent (dedupe by tx hash)
    const txHash = event.tx?.hash;
    if (txHash) {
      await insertRecent(client.pg, chain, scope, txHash, buyer, ts, ethValue, delta);
      await pruneRecent(client.pg, chain, scope);
    }

    // alert logic (optional)
    const tier = tierFromPower(power);
    const lastTier = state.last_alert_tier || 0;

    // only alert on tier increase
    if (tier > lastTier) {
      await maybeAlert(client, chans, scope, power, tier, event);
    }

    await setState(client.pg, chain, scope, power, ts, Math.max(lastTier, tier));

    return { scope, power, delta, ethValue, tier, burst, unique };
  } catch (e) {
    // swallow errors to protect notis
    if (String(process.env.SWEEP_POWER_DEBUG || "") === "1") {
      console.log("[SWEEP-POWER] apply error:", e?.message || e);
    }
    return null;
  }
}

module.exports = { initSweepPower, applySweepPower };
