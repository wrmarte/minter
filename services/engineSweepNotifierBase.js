// services/engineSweepNotifierBase.js
// ======================================================
// Engine Sweep notifier (Base) — load minimized
// - Leader lock (optional) prevents multi-instance polling
// - No overlapping ticks (self-scheduling loop + guard)
// - Channel routing cached (DB query + channel fetch only every N minutes)
// - seenTx bounded to avoid memory growth
// ======================================================

const fetch = require("node-fetch"); // ✅ FIX: safeThumb() uses fetch on Railway/Node builds that may not have global fetch
const { Interface, ethers, PermissionsBitField } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ✅ Daily Digest logger (optional; won't crash if missing) */
let logDigestEvent = null;
try {
  ({ logDigestEvent } = require("./digestLogger"));
} catch (e) {
  logDigestEvent = null;
}

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

const ENGINE_TOPIC = "0x000000000000000000000000" + ENGINE_CONTRACT.slice(2);

// 🔒 keep your current "test guild only" default behavior,
// but make it configurable via ENV allowlist.
const TEST_GUILD_ID = "1335024324184244447";

// Enable switch (default ON)
const ENABLE_ENGINE_SWEEP = String(process.env.ENABLE_ENGINE_SWEEP ?? "1").trim() === "1";

// Leader lock (default ON if DB exists)
const USE_LEADER_LOCK = String(process.env.ENGINE_SWEEP_USE_LEADER_LOCK ?? "1").trim() === "1";
const LEADER_LOCK_KEY = Number(process.env.ENGINE_SWEEP_LOCK_KEY || 917302);

// Polling defaults bumped down for load reduction
const POLL_MS = Math.max(8000, Number(process.env.SWEEP_POLL_MS || 30000));
const LOOKBACK = Math.max(5, Number(process.env.SWEEP_LOOKBACK_BLOCKS || 40));
const MAX_BLOCKS = Math.max(3, Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 12));
const MAX_TXS = Math.max(25, Number(process.env.SWEEP_MAX_TX_PER_TICK || 200));

const DEBUG = String(process.env.SWEEP_DEBUG || "").trim() === "1";
const FORCE_RESET_SWEEP = String(process.env.SWEEP_FORCE_RESET || "").trim() === "1"; // one deploy only

// Channel routing refresh interval (ms)
const CHANNEL_REFRESH_MS = Math.max(
  30000,
  Number(process.env.SWEEP_CHANNEL_REFRESH_MS || 300000) // 5 min default
);

// Seen tx cache bound
const SEEN_MAX = Math.max(500, Number(process.env.SWEEP_SEEN_MAX || 5000));
const SEEN_TTL_MS = Math.max(60000, Number(process.env.SWEEP_SEEN_TTL_MS || 6 * 60 * 60 * 1000)); // 6h default

// Optional allowlist: comma-separated guild IDs.
// If set, only those guilds get messages.
// If NOT set, it falls back to TEST_GUILD_ID behavior (to keep your current safety).
const GUILD_ALLOWLIST = String(process.env.SWEEP_GUILD_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/* ======================================================
   CHECKPOINT
====================================================== */
const CHECKPOINT_CHAIN = "base";
const CHECKPOINT_KEY = "engine_sweep_last_block";
let _checkpointEnsured = false;

async function ensureCheckpoint(client) {
  if (_checkpointEnsured) return;
  if (!client?.pg?.query) return;
  await client.pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_checkpoints (
      chain TEXT NOT NULL,
      key   TEXT NOT NULL,
      value BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);
  _checkpointEnsured = true;
}

async function getLastBlock(client) {
  if (!client?.pg?.query) return null;
  try {
    const r = await client.pg.query(
      `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    return r.rows?.[0]?.value ? Number(r.rows[0].value) : null;
  } catch {
    return null;
  }
}

async function setLastBlock(client, block) {
  if (!client?.pg?.query) return;
  try {
    await client.pg.query(
      `INSERT INTO sweep_checkpoints(chain,key,value)
       VALUES ($1,$2,$3)
       ON CONFLICT (chain,key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
    );
  } catch {}
}

/* ======================================================
   ABIs / TOPICS
====================================================== */
const ERC721 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "function tokenURI(uint256) view returns (string)",
  "function name() view returns (string)"
]);

const ERC20 = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
]);

const T_ERC721_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const T_ERC721_APPROVAL = ethers.id("Approval(address,address,uint256)");
const T_ERC721_APPROVAL_ALL = ethers.id("ApprovalForAll(address,address,bool)");
const T_ERC20_TRANSFER = ethers.id("Transfer(address,address,uint256)");

/* ======================================================
   HELPERS
====================================================== */
const seenTx = new Map(); // hash -> lastSeenMs

function nowMs() {
  return Date.now();
}

function pruneSeen() {
  const t = nowMs();
  for (const [h, ts] of seenTx) {
    if (t - ts > SEEN_TTL_MS) seenTx.delete(h);
  }
  if (seenTx.size > SEEN_MAX) {
    const excess = seenTx.size - SEEN_MAX;
    let i = 0;
    for (const h of seenTx.keys()) {
      seenTx.delete(h);
      i++;
      if (i >= excess) break;
    }
  }
}

function markSeen(h) {
  seenTx.set(h, nowMs());
  if (seenTx.size > SEEN_MAX * 1.2) pruneSeen();
}

function fmtNumber(x) {
  try {
    const [a, b] = String(x).split(".");
    const aa = a.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return b ? `${aa}.${b}` : aa;
  } catch {
    return String(x);
  }
}

async function safeName(provider, addr) {
  try {
    return await new ethers.Contract(addr, ERC721, provider).name();
  } catch {
    return "NFT";
  }
}

async function safeThumb(provider, addr, id) {
  try {
    let uri = await new ethers.Contract(addr, ERC721, provider).tokenURI(id);
    if (!uri) return null;

    if (uri.startsWith("ipfs://")) uri = "https://ipfs.io/ipfs/" + uri.slice(7);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6500);

    const r = await fetch(uri, { signal: controller.signal }).catch(() => null);
    clearTimeout(t);
    if (!r || !r.ok) return null;

    const j = await r.json().catch(() => null);
    if (!j) return null;

    let img = j.image || j.image_url;
    if (!img) return null;

    if (img.startsWith("ipfs://")) img = "https://ipfs.io/ipfs/" + img.slice(7);
    return img;
  } catch {
    return null;
  }
}

async function tokenInfo(provider, addr) {
  try {
    const c = new ethers.Contract(addr, ERC20, provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

async function buildTokenAmountString(provider, tokenAddr, amountBN) {
  const info = await tokenInfo(provider, tokenAddr);
  if (info) {
    const amt = ethers.formatUnits(amountBN, info.decimals);
    return `${fmtNumber(amt)} ${info.symbol}`;
  }
  return `${fmtNumber(ethers.formatUnits(amountBN, 18))} TOKEN`;
}

function hasSendPerms(ch) {
  try {
    const me = ch.guild?.members?.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (!perms) return false;

    if (perms.has?.("SendMessages")) return true;
    if (perms.has?.(PermissionsBitField?.Flags?.SendMessages)) return true;

    return false;
  } catch {
    return false;
  }
}

/* ✅ Helper: log digest sale once per guild (BUY only) */
async function logDigestSaleIfPossible(client, provider, data, chans) {
  try {
    if (!logDigestEvent) return;
    if (!data || data.type !== "BUY") return;
    if (!data.tx?.hash) return;

    const uniqueGuildIds = new Set(
      (chans || []).map((c) => c?.guild?.id).filter(Boolean)
    );

    let amountEth = null;
    let amountNative = null;

    if (data.ethPaid && data.ethPaid > 0n) {
      const ethStr = ethers.formatEther(data.ethPaid);
      amountEth = Number(ethStr);
      amountNative = amountEth;
    } else if (data.tokenPayment?.token && data.tokenPayment?.amount != null) {
      const info = await tokenInfo(provider, data.tokenPayment.token);
      const tokStr = info
        ? ethers.formatUnits(data.tokenPayment.amount, info.decimals)
        : ethers.formatUnits(data.tokenPayment.amount, 18);
      amountNative = Number(tokStr);
    }

    for (const guildId of uniqueGuildIds) {
      await logDigestEvent(client, {
        guildId,
        eventType: "sale",
        chain: "base",
        contract: data.nft,
        tokenId: data.tokenId,
        amountNative,
        amountEth,
        amountUsd: null,
        buyer: data.buyer,
        seller: data.seller,
        txHash: data.tx.hash
      });
    }
  } catch (e) {
    if (DEBUG) console.warn("[SWEEP][DIGEST] log failed:", e?.message || e);
  }
}

/* ======================================================
   CHANNEL ROUTING (CACHED)
====================================================== */
let _channelsCache = [];
let _channelsCacheAt = 0;

function guildAllowed(guildId) {
  if (GUILD_ALLOWLIST.length) return GUILD_ALLOWLIST.includes(String(guildId));
  return String(guildId) === String(TEST_GUILD_ID);
}

async function resolveChannels(client) {
  if (!client?.pg?.query) return [];

  const now = nowMs();
  if (_channelsCacheAt && now - _channelsCacheAt < CHANNEL_REFRESH_MS) {
    return _channelsCache;
  }

  let rows = [];
  try {
    const r = await client.pg.query(`
      SELECT DISTINCT channel_id
      FROM tracked_tokens
      WHERE channel_id IS NOT NULL AND channel_id <> ''
    `);
    rows = r?.rows || [];
  } catch {
    rows = [];
  }

  const out = [];
  for (const row of rows) {
    const id = String(row.channel_id || "").trim();
    if (!id) continue;

    const ch =
      client.channels.cache.get(id) ||
      (await client.channels.fetch(id).catch(() => null));

    if (!ch?.isTextBased?.()) continue;
    if (!ch?.guild?.id) continue;
    if (!guildAllowed(ch.guild.id)) continue;
    if (!hasSendPerms(ch)) continue;

    out.push(ch);
  }

  _channelsCache = out;
  _channelsCacheAt = now;

  if (DEBUG) console.log(`[SWEEP] channels(filtered)=${out.length} refreshMs=${CHANNEL_REFRESH_MS}`);
  return out;
}

/* ======================================================
   ANALYZE TX (USER LIST + USER BUY ONLY)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await safeRpcCall("base", (p) => p.getTransaction(hash), 2, 12000).catch(() => null);
  const rc = await safeRpcCall("base", (p) => p.getTransactionReceipt(hash), 2, 12000).catch(() => null);
  if (!tx || !rc) return null;

  let nft = null;
  let tokenId = null;

  let buyer = null;
  let seller = null;

  let approvedToEngine = false;

  let ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;

  let tokenPayment = null;
  let listPayment = null;

  // PASS 1: ERC721 transfers
  for (const log of rc.logs) {
    if (log.topics?.[0] !== T_ERC721_TRANSFER || log.topics.length < 4) continue;

    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]).toString();
    const addr = (log.address || "").toLowerCase();

    if (!nft) {
      nft = addr;
      tokenId = id;
      seller = from;
      buyer = to;
    } else if (to === ENGINE_CONTRACT) {
      nft = addr;
      tokenId = id;
      seller = from;
      buyer = to;
    }
  }

  // PASS 2: approvals (LIST signal)
  for (const log of rc.logs) {
    const t0 = log.topics?.[0];

    if (t0 === T_ERC721_APPROVAL && log.topics.length >= 4) {
      const approved = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (approved === ENGINE_CONTRACT) {
        approvedToEngine = true;
        nft = nft || (log.address || "").toLowerCase();
        if (!tokenId) {
          try { tokenId = BigInt(log.topics[3]).toString(); } catch {}
        }
      }
      continue;
    }

    if (t0 === T_ERC721_APPROVAL_ALL && log.topics.length >= 3) {
      const operator = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (operator === ENGINE_CONTRACT) {
        let ok = false;
        try {
          ok = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], log.data)?.[0];
        } catch {}
        if (ok) {
          approvedToEngine = true;
          nft = nft || (log.address || "").toLowerCase();
        }
      }
      continue;
    }
  }

  // PASS 3: ERC20 transfers (price heuristics)
  for (const log of rc.logs) {
    if (log.topics?.[0] !== T_ERC20_TRANSFER || log.topics.length < 3) continue;

    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();

    let parsed;
    try { parsed = ERC20.parseLog(log); } catch { continue; }

    if (seller && to === seller) {
      tokenPayment = { token: (log.address || "").toLowerCase(), amount: parsed.args.value };
    }

    if (approvedToEngine && seller && from === seller && to === ENGINE_CONTRACT) {
      listPayment = { token: (log.address || "").toLowerCase(), amount: parsed.args.value };
    }
  }

  // CLASSIFICATION
  if (approvedToEngine && (!buyer || buyer === ENGINE_CONTRACT)) {
    const listSeller = (seller || tx.from || "").toLowerCase();
    if (!tokenId) return null;

    return {
      type: "LIST",
      nft,
      tokenId,
      seller: listSeller,
      listPayment,
      tx
    };
  }

  if (buyer && buyer !== ENGINE_CONTRACT) {
    if (!tokenId) return null;

    return {
      type: "BUY",
      nft,
      tokenId,
      buyer,
      seller: (seller || "").toLowerCase(),
      ethPaid,
      tokenPayment,
      tx
    };
  }

  return null;
}

/* ======================================================
   EMBEDS (POLISHED)
====================================================== */
async function sendEmbed(client, provider, data, chans) {
  if (!data?.tokenId || !data?.nft) return;

  const name = await safeName(provider, data.nft);
  const thumb = await safeThumb(provider, data.nft, data.tokenId);

  const fields = [];

  if (data.type === "LIST") {
    const price = data.listPayment
      ? await buildTokenAmountString(provider, data.listPayment.token, data.listPayment.amount)
      : "N/A (Engine order)";

    fields.push(
      { name: "List Price", value: price, inline: false },
      { name: "Seller", value: shortWalletLink(data.seller), inline: false },
      { name: "Method", value: "ENGINE", inline: false }
    );
  }

  if (data.type === "BUY") {
    let price = "N/A";

    if (data.ethPaid && data.ethPaid > 0n) {
      price = `${fmtNumber(ethers.formatEther(data.ethPaid))} ETH`;
    } else if (data.tokenPayment) {
      price = await buildTokenAmountString(provider, data.tokenPayment.token, data.tokenPayment.amount);
    }

    fields.push(
      { name: "Sale Price", value: price, inline: false },
      { name: "Buyer", value: shortWalletLink(data.buyer), inline: false },
      { name: "Seller", value: shortWalletLink(data.seller), inline: false },
      { name: "Method", value: "ENGINE", inline: false }
    );
  }

  const embed = {
    title:
      data.type === "LIST"
        ? `📌 ${name} #${data.tokenId} — LISTED`
        : `🛒 ${name} #${data.tokenId} — SOLD`,
    fields,
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: data.type === "LIST" ? 0x2ecc71 : 0xf1c40f,
    footer: { text: "AdrianEngine • Powered by PimpsDev" },
    timestamp: new Date().toISOString()
  };

  if (thumb) embed.thumbnail = { url: thumb };

  for (const c of chans) {
    await c.send({ embeds: [embed] }).catch(() => {});
  }

  // ✅ Log ONLY SALES (BUY) to daily digest
  await logDigestSaleIfPossible(client, provider, data, chans);
}

/* ======================================================
   MAIN LOOP (WORKING SCAN)
====================================================== */
let _ticking = false;

async function tick(client) {
  if (_ticking) return;
  _ticking = true;

  try {
    pruneSeen();

    const provider = await safeRpcCall("base", (p) => p);
    if (!provider) return;

    await ensureCheckpoint(client);

    const latest = await safeRpcCall("base", (p) => p.getBlockNumber(), 2, 12000).catch(() => null);
    if (!latest || !Number.isFinite(Number(latest))) return;

    if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
      await setLastBlock(client, Math.max(Number(latest) - 25, 0));
      global.__engineSweepResetDone = true;
      DEBUG && console.log("🧹 [SWEEP] checkpoint force-reset (one-time)");
    }

    let last = await getLastBlock(client);
    if (!Number.isFinite(Number(last))) last = null;

    // clamp last to tip if DB got ahead
    const tip = Number(latest);
    if (last != null && last > tip) last = tip;

    if (last == null) last = tip - 5;

    const from = Math.max(last + 1, tip - LOOKBACK);
    const to = Math.min(tip, from + MAX_BLOCKS);

    DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

    const engineLogs = await safeRpcCall(
      "base",
      (p) => p.getLogs({ address: ENGINE_CONTRACT, fromBlock: from, toBlock: to }),
      2,
      12000
    ).catch(() => []);

    const approvalLogs = await safeRpcCall(
      "base",
      (p) => p.getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL, null, ENGINE_TOPIC] }),
      2,
      12000
    ).catch(() => []);

    const approvalAllLogs = await safeRpcCall(
      "base",
      (p) => p.getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL_ALL, null, ENGINE_TOPIC] }),
      2,
      12000
    ).catch(() => []);

    const merged = [
      ...(Array.isArray(engineLogs) ? engineLogs.map((l) => l.transactionHash) : []),
      ...(Array.isArray(approvalLogs) ? approvalLogs.map((l) => l.transactionHash) : []),
      ...(Array.isArray(approvalAllLogs) ? approvalAllLogs.map((l) => l.transactionHash) : [])
    ];

    const txs = [...new Set(merged)].filter(Boolean).slice(0, MAX_TXS);

    DEBUG &&
      console.log(
        `[SWEEP] logs engine=${engineLogs?.length || 0} approval=${approvalLogs?.length || 0} approvalAll=${approvalAllLogs?.length || 0} txs=${txs.length}`
      );

    const chans = await resolveChannels(client);

    for (const h of txs) {
      if (seenTx.has(h)) continue;
      markSeen(h);

      const res = await analyzeTx(provider, h).catch(() => null);
      if (!res) continue;

      await sendEmbed(client, provider, res, chans);
    }

    await setLastBlock(client, to);
  } catch (e) {
    DEBUG && console.warn("⚠️ [SWEEP] tick error:", e?.message || e);
  } finally {
    _ticking = false;
  }
}

/* ======================================================
   LEADER LOCK
====================================================== */
async function tryAcquireLeaderLock(client) {
  if (!USE_LEADER_LOCK) return true;
  const pg = client?.pg;
  if (!pg?.query) return true;

  try {
    const r = await pg.query("SELECT pg_try_advisory_lock($1) AS ok", [LEADER_LOCK_KEY]);
    return Boolean(r.rows?.[0]?.ok);
  } catch (e) {
    console.warn("⚠️ [SWEEP] leader lock check failed:", e?.message || e);
    return true; // don't brick
  }
}

/* ======================================================
   START (NO OVERLAP + SELF SCHEDULING)
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;

  if (!ENABLE_ENGINE_SWEEP) {
    console.log("🧹 Engine Sweep notifier: disabled by ENABLE_ENGINE_SWEEP=0");
    return;
  }

  console.log("🧹 Engine Sweep notifier started (TEST SERVER ONLY)");

  let stopped = false;
  let backoffMs = 0;

  const loop = async () => {
    if (stopped) return;

    const leaderOk = await tryAcquireLeaderLock(client);
    if (!leaderOk) {
      DEBUG && console.log("🧹 [SWEEP] another instance holds leader lock — skipping tick.");
    } else {
      try {
        await tick(client);
        backoffMs = 0;
      } catch {
        backoffMs = Math.min(120000, Math.max(5000, (backoffMs || 0) * 2 || 5000));
      }
    }

    const jitter = Math.floor(Math.random() * 750);
    const next = Math.max(8000, POLL_MS + backoffMs + jitter);
    setTimeout(loop, next);
  };

  setTimeout(loop, 1500 + Math.floor(Math.random() * 750));

  client.__engineSweepStop = () => { stopped = true; };
}

module.exports = { startEngineSweepNotifierBase };

