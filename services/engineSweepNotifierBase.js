const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

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
const FORCE_RESET_SWEEP = process.env.SWEEP_FORCE_RESET === "1"; // one deploy only

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
  // fallback
  return `${fmtNumber(ethers.formatUnits(amountBN, 18))} TOKEN`;
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

  if (DEBUG) console.log(`[SWEEP] channels(test guild)=${out.length}`);
  return out;
}

/* ======================================================
   ANALYZE TX (USER LIST + USER BUY ONLY)
   - LIST: approval to engine (and possibly escrow transfer to engine)
   - BUY: buyer != engine
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

  // payments:
  // - tokenPayment: token transfer to seller (for BUY)
  // - listPayment: token transfer seller -> engine (heuristic list price)
  let tokenPayment = null;
  let listPayment = null;

  /* ---------- PASS 1: Find any ERC721 transfers (source of truth for tokenId) ---------- */
  // Prefer the transfer that goes TO engine (escrow) OR any transfer that indicates sale.
  for (const log of rc.logs) {
    if (log.topics?.[0] !== T_ERC721_TRANSFER || log.topics.length < 4) continue;

    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const id = BigInt(log.topics[3]).toString();
    const addr = log.address.toLowerCase();

    // Keep first seen; override if it’s the escrow transfer to engine (best for listing)
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

  /* ---------- PASS 2: approvals (LIST signal) ---------- */
  for (const log of rc.logs) {
    const t0 = log.topics?.[0];

    if (t0 === T_ERC721_APPROVAL && log.topics.length >= 4) {
      const approved = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (approved === ENGINE_CONTRACT) {
        approvedToEngine = true;
        nft = nft || log.address.toLowerCase();

        // approval includes tokenId, use as fallback if we still don’t have one
        if (!tokenId) {
          try { tokenId = BigInt(log.topics[3]).toString(); } catch {}
        }
      }
      continue;
    }

    if (t0 === T_ERC721_APPROVAL_ALL && log.topics.length >= 3) {
      const operator = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (operator === ENGINE_CONTRACT) {
        // only true approvals
        let ok = false;
        try {
          ok = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], log.data)?.[0];
        } catch {}
        if (ok) {
          approvedToEngine = true;
          nft = nft || log.address.toLowerCase();
        }
      }
      continue;
    }
  }

  /* ---------- PASS 3: ERC20 transfers (price heuristics) ---------- */
  for (const log of rc.logs) {
    if (log.topics?.[0] !== T_ERC20_TRANSFER || log.topics.length < 3) continue;

    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();

    let parsed;
    try { parsed = ERC20.parseLog(log); } catch { continue; }

    // BUY price heuristic: token -> seller
    if (seller && to === seller) {
      tokenPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }

    // LIST price heuristic: seller -> engine (if approval happened)
    if (approvedToEngine && seller && from === seller && to === ENGINE_CONTRACT) {
      listPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }
  }

  /* ---------- CLASSIFICATION ---------- */

  // If we have approval AND buyer is engine OR no transfer buyer known -> LIST
  // (this catches: approval only, and approval+escrow transfer)
  if (approvedToEngine && (!buyer || buyer === ENGINE_CONTRACT)) {
    // treat seller as tx.from if missing
    const listSeller = (seller || tx.from || "").toLowerCase();

    // Must have tokenId to post a good embed (else skip)
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

  // USER BUY ONLY: buyer exists and is NOT engine
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

  // ✅ top-right thumbnail only
  if (thumb) embed.thumbnail = { url: thumb };

  for (const c of chans) {
    await c.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ======================================================
   MAIN LOOP (WORKING SCAN: engine + approvals)
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall("base", (p) => p);
  if (!provider) return;

  await ensureCheckpoint(client);

  const latest = await provider.getBlockNumber();

  if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
    await setLastBlock(client, latest - 25);
    global.__engineSweepResetDone = true;
    DEBUG && console.log("🧹 [SWEEP] checkpoint force-reset (one-time)");
  }

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to = Math.min(latest, from + MAX_BLOCKS);

  DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

  const engineLogs = await provider
    .getLogs({ address: ENGINE_CONTRACT, fromBlock: from, toBlock: to })
    .catch(() => []);

  const approvalLogs = await provider
    .getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL, null, ENGINE_TOPIC] })
    .catch(() => []);

  const approvalAllLogs = await provider
    .getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL_ALL, null, ENGINE_TOPIC] })
    .catch(() => []);

  const merged = [
    ...engineLogs.map((l) => l.transactionHash),
    ...approvalLogs.map((l) => l.transactionHash),
    ...approvalAllLogs.map((l) => l.transactionHash)
  ];

  const txs = [...new Set(merged)].slice(0, MAX_TXS);

  DEBUG &&
    console.log(
      `[SWEEP] logs engine=${engineLogs.length} approval=${approvalLogs.length} approvalAll=${approvalAllLogs.length} txs=${txs.length}`
    );

  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seenTx.has(h)) continue;
    seenTx.add(h);

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    // ✅ only user LIST + user BUY already enforced in analyzeTx
    await sendEmbed(client, provider, res, chans);
  }

  await setLastBlock(client, to);
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;

  console.log("🧹 Engine Sweep notifier started (TEST SERVER ONLY)");

  // ✅ run immediately
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };




