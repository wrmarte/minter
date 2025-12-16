const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

const ENGINE_TOPIC = "0x000000000000000000000000" + ENGINE_CONTRACT.slice(2);

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS = Number(process.env.SWEEP_MAX_TX_PER_TICK || 250);

const DEBUG = process.env.SWEEP_DEBUG === "1";

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
const ERC721_IFACE = new Interface([
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
  "event ApprovalForAll(address indexed owner, address indexed operator, bool approved)",
  "function tokenURI(uint256) view returns (string)",
  "function name() view returns (string)"
]);

const ERC20_IFACE = new Interface([
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
  const [a, b] = String(x).split(".");
  return b ? `${a.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${b}` :
             a.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

async function safeTokenInfo(provider, tokenAddr) {
  try {
    const c = new ethers.Contract(tokenAddr, ERC20_IFACE, provider);
    const [symbol, decimals] = await Promise.all([c.symbol(), c.decimals()]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

async function safeCollectionName(provider, nftAddr) {
  try {
    return await new ethers.Contract(nftAddr, ERC721_IFACE, provider).name();
  } catch {
    return "NFT";
  }
}

async function safeThumbnail(provider, nftAddr, tokenId) {
  try {
    let uri = await new ethers.Contract(nftAddr, ERC721_IFACE, provider).tokenURI(tokenId);
    if (uri.startsWith("ipfs://")) uri = "https://ipfs.io/ipfs/" + uri.slice(7);
    const r = await fetch(uri).catch(() => null);
    if (!r?.ok) return null;
    const j = await r.json().catch(() => null);
    let img = j?.image || j?.image_url;
    if (img?.startsWith("ipfs://")) img = "https://ipfs.io/ipfs/" + img.slice(7);
    return img || null;
  } catch {
    return null;
  }
}

/* ======================================================
   CHANNEL ROUTING
====================================================== */
async function resolveChannels(client) {
  const r = await client.pg.query(`
    SELECT DISTINCT channel_id FROM tracked_tokens
    WHERE channel_id IS NOT NULL AND channel_id <> ''
  `);
  const out = [];
  for (const row of r.rows) {
    const ch =
      client.channels.cache.get(row.channel_id) ||
      (await client.channels.fetch(row.channel_id).catch(() => null));
    if (ch?.isTextBased()) out.push(ch);
  }
  return out;
}

/* ======================================================
   ANALYZE TX (USER ONLY)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  let nft, tokenId, buyer, seller, approvalToEngine;
  let ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;
  let tokenPayment, orderPayment;

  for (const log of rc.logs) {
    if (log.topics[0] === T_ERC721_TRANSFER) {
      seller = "0x" + log.topics[1].slice(26);
      buyer  = "0x" + log.topics[2].slice(26);
      tokenId = BigInt(log.topics[3]).toString();
      nft = log.address.toLowerCase();
    }

    if (
      log.topics[0] === T_ERC721_APPROVAL ||
      log.topics[0] === T_ERC721_APPROVAL_ALL
    ) {
      const operator = "0x" + log.topics[2].slice(26);
      if (operator.toLowerCase() === ENGINE_CONTRACT) {
        approvalToEngine = true;
        seller = tx.from.toLowerCase();
        nft = nft || log.address.toLowerCase();
      }
    }
  }

  for (const log of rc.logs) {
    if (log.topics[0] !== T_ERC20_TRANSFER) continue;
    const from = "0x" + log.topics[1].slice(26);
    const to   = "0x" + log.topics[2].slice(26);
    const parsed = ERC20_IFACE.parseLog(log);

    if (seller && to.toLowerCase() === seller.toLowerCase())
      tokenPayment = { token: log.address, amount: parsed.args.value };

    if (approvalToEngine && from.toLowerCase() === seller && to.toLowerCase() === ENGINE_CONTRACT)
      orderPayment = { token: log.address, amount: parsed.args.value };
  }

  // 🔥 LIST (user only)
  if (approvalToEngine && !buyer && !tokenPayment && !ethPaid) {
    return { type: "LIST", nft, tokenId, seller, orderPayment, tx };
  }

  // 🔥 BUY (ignore engine buys)
  if (
    nft && buyer && seller &&
    buyer.toLowerCase() !== ENGINE_CONTRACT
  ) {
    return { type: "BUY", nft, tokenId, buyer, seller, ethPaid, tokenPayment, tx };
  }

  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function buildPrice(provider, ethPaid, tokenPayment) {
  if (ethPaid && ethPaid > 0n)
    return `${fmtNumber(ethers.formatEther(ethPaid))} ETH`;

  if (tokenPayment) {
    const info = await safeTokenInfo(provider, tokenPayment.token);
    if (info)
      return `${fmtNumber(
        ethers.formatUnits(tokenPayment.amount, info.decimals)
      )} ${info.symbol}`;
  }
  return "N/A (Engine order)";
}

async function sendEngineEmbed(client, provider, data, chans) {
  const name = await safeCollectionName(provider, data.nft);
  const thumb = await safeThumbnail(provider, data.nft, data.tokenId);
  const fields = [];

  if (data.type === "LIST") {
    fields.push(
      { name: "List Price", value: await buildPrice(provider, 0n, data.orderPayment) },
      { name: "Seller", value: shortWalletLink(data.seller) },
      { name: "Method", value: "ENGINE" }
    );
  }

  if (data.type === "BUY") {
    fields.push(
      { name: "Sale Price", value: await buildPrice(provider, data.ethPaid, data.tokenPayment) },
      { name: "Buyer", value: shortWalletLink(data.buyer) },
      { name: "Seller", value: shortWalletLink(data.seller) },
      { name: "Method", value: "ENGINE" }
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

  for (const c of chans) await c.send({ embeds: [embed] }).catch(() => {});
}

/* ======================================================
   MAIN LOOP
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall("base", p => p);
  if (!provider) return;

  await ensureCheckpoint(client);
  const latest = await provider.getBlockNumber();
  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to = Math.min(latest, from + MAX_BLOCKS);

  const engineLogs = await provider.getLogs({ address: ENGINE_CONTRACT, fromBlock: from, toBlock: to });
  const approvalLogs = await provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL, null, ENGINE_TOPIC] });
  const approvalAllLogs = await provider.getLogs({ fromBlock: from, toBlock: to, topics: [T_ERC721_APPROVAL_ALL, null, ENGINE_TOPIC] });

  const txs = [...new Set([
    ...engineLogs,
    ...approvalLogs,
    ...approvalAllLogs
  ].map(l => l.transactionHash))].slice(0, MAX_TXS);

  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seenTx.has(h)) continue;
    seenTx.add(h);
    const res = await analyzeTx(provider, h);
    if (res) await sendEngineEmbed(client, provider, res, chans);
  }

  await setLastBlock(client, to);
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;
  console.log("🧹 Engine Sweep notifier started");
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };


