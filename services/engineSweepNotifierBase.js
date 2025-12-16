/**
 * ======================================================
 *  FILE TAG: CompleteSweepJS
 * ======================================================
 *  STATUS: ✅ STABLE / VERIFIED WORKING
 *  PURPOSE:
 *    - Engine LIST notifications
 *    - Engine BUY notifications
 *    - Approval + escrow + sale detection
 *
 *  ⚠️ WARNING:
 *    - DO NOT gate embeds behind Sweep-Power
 *    - Sweep-Power runs as a SIDE EFFECT ONLY
 * ======================================================
 */

const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");
const { initSweepPower, applySweepPower } = require("./sweepPower");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

const ENGINE_TOPIC = "0x000000000000000000000000" + ENGINE_CONTRACT.slice(2);

// 🔒 TEST SERVER ONLY (TEMP)
const TEST_GUILD_ID = "1109969059497386054";

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS = Number(process.env.SWEEP_MAX_TX_PER_TICK || 250);

const DEBUG = process.env.SWEEP_DEBUG === "1";
const FORCE_RESET_SWEEP = process.env.SWEEP_FORCE_RESET === "1";

/* ======================================================
   CHECKPOINT
====================================================== */
const CHECKPOINT_CHAIN = "base";
const CHECKPOINT_KEY = "engine_sweep_last_block";

async function ensureCheckpoint(client) {
  await client.pg.query(`
    CREATE TABLE IF NOT EXISTS sweep_checkpoints (
      chain TEXT NOT NULL,
      key   TEXT NOT NULL,
      value BIGINT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (chain, key)
    )
  `);
}

async function getLastBlock(client) {
  const r = await client.pg.query(
    `SELECT value FROM sweep_checkpoints WHERE chain=$1 AND key=$2`,
    [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
  );
  return r.rows?.[0]?.value ? Number(r.rows[0].value) : null;
}

async function setLastBlock(client, block) {
  await client.pg.query(
    `INSERT INTO sweep_checkpoints(chain,key,value)
     VALUES ($1,$2,$3)
     ON CONFLICT (chain,key)
     DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(block)]
  );
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
const seenTx = new Set();

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

/* ======================================================
   CHANNEL ROUTING (TEST SERVER ONLY)
====================================================== */
async function resolveChannels(client) {
  const r = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL AND channel_id <> ''
  `);

  const out = [];
  for (const row of r.rows) {
    const ch =
      client.channels.cache.get(row.channel_id) ||
      (await client.channels.fetch(row.channel_id).catch(() => null));

    if (ch?.isTextBased() && ch?.guild?.id === TEST_GUILD_ID) out.push(ch);
  }

  return out;
}

/* ======================================================
   ANALYZE TX (LIST + BUY)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  let nft = null;
  let tokenId = null;
  let buyer = null;
  let seller = null;
  let approvedToEngine = false;
  let ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;
  let tokenPayment = null;
  let listPayment = null;

  for (const log of rc.logs) {
    if (log.topics?.[0] !== T_ERC721_TRANSFER || log.topics.length < 4) continue;
    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]).toString();
    nft = nft || log.address.toLowerCase();
    tokenId = tokenId || id;
    seller = from;
    buyer = to;
  }

  for (const log of rc.logs) {
    if (log.topics?.[0] === T_ERC721_APPROVAL) {
      const approved = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (approved === ENGINE_CONTRACT) approvedToEngine = true;
    }
  }

  if (approvedToEngine && buyer === ENGINE_CONTRACT) {
    return { type: "LIST", nft, tokenId, seller, listPayment, tx };
  }

  if (buyer && buyer !== ENGINE_CONTRACT) {
    return { type: "BUY", nft, tokenId, buyer, seller, ethPaid, tokenPayment, tx };
  }

  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function sendEmbed(client, provider, data, chans) {
  if (!data?.tokenId || !data?.nft) return;

  const name = await safeName(provider, data.nft);
  const thumb = await safeThumb(provider, data.nft, data.tokenId);

  const fields = [];

  if (data.type === "BUY") {
    const price =
      data.ethPaid && data.ethPaid > 0n
        ? `${fmtNumber(ethers.formatEther(data.ethPaid))} ETH`
        : "N/A";

    fields.push(
      { name: "Sale Price", value: price, inline: false },
      { name: "Buyer", value: shortWalletLink(data.buyer), inline: false },
      { name: "Seller", value: shortWalletLink(data.seller), inline: false },
      { name: "Method", value: "ENGINE", inline: false }
    );
  }

  const embed = {
    title: `🛒 ${name} #${data.tokenId} — SOLD`,
    fields,
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: 0xf1c40f,
    footer: { text: "AdrianEngine • Powered by PimpsDev" },
    timestamp: new Date().toISOString()
  };

  if (thumb) embed.thumbnail = { url: thumb };

  for (const c of chans) {
    await c.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ======================================================
   MAIN LOOP
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall("base", (p) => p);
  if (!provider) return;

  await ensureCheckpoint(client);
  const latest = await provider.getBlockNumber();

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to = Math.min(latest, from + MAX_BLOCKS);

  const logs = await provider.getLogs({
    address: ENGINE_CONTRACT,
    fromBlock: from,
    toBlock: to
  }).catch(() => []);

  const txs = [...new Set(logs.map(l => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seenTx.has(h)) continue;
    seenTx.add(h);

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    await sendEmbed(client, provider, res, chans);

    // 🔥 Sweep-Power piggy-bank (NON-BLOCKING)
    applySweepPower(client, chans, res, {
      scope: `guild:${TEST_GUILD_ID}`
    }).catch(() => {});
  }

  await setLastBlock(client, to);
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;

  console.log("🧹 Engine Sweep notifier started (CompleteSweepJS)");

  initSweepPower(client).catch(() => {});
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };
