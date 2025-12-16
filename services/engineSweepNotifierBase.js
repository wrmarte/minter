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
const BOOT_PING = process.env.SWEEP_BOOT_PING === "1";
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
  try {
    const [a, b] = String(x).split(".");
    const aa = a.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return b ? `${aa}.${b}` : aa;
  } catch {
    return String(x);
  }
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
    const c = new ethers.Contract(nftAddr, ERC721_IFACE, provider);
    return await c.name();
  } catch {
    return null;
  }
}

async function safeThumbnail(provider, nftAddr, tokenId) {
  try {
    const c = new ethers.Contract(nftAddr, ERC721_IFACE, provider);
    let uri = await c.tokenURI(tokenId);
    if (!uri) return null;
    if (uri.startsWith("ipfs://"))
      uri = "https://ipfs.io/ipfs/" + uri.slice(7);

    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(uri, { signal: controller.signal }).catch(() => null);
    clearTimeout(t);
    if (!res || !res.ok) return null;

    const meta = await res.json().catch(() => null);
    if (!meta) return null;

    let img = meta.image || meta.image_url;
    if (!img) return null;
    if (img.startsWith("ipfs://"))
      img = "https://ipfs.io/ipfs/" + img.slice(7);
    return img;
  } catch {
    return null;
  }
}

/* ======================================================
   CHANNEL ROUTING
====================================================== */
async function resolveChannels(client) {
  const out = [];
  const r = await client.pg.query(`
    SELECT DISTINCT channel_id
    FROM tracked_tokens
    WHERE channel_id IS NOT NULL AND channel_id <> ''
  `);

  for (const row of r.rows) {
    const ch =
      client.channels.cache.get(row.channel_id) ||
      (await client.channels.fetch(row.channel_id).catch(() => null));
    if (ch?.isTextBased()) out.push(ch);
  }
  return out;
}

/* ======================================================
   ANALYZE TX (UNCHANGED)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  let nft = null;
  let tokenId = null;
  let buyer = null;
  let seller = null;
  let approvalToEngine = false;

  let ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;
  let tokenPayment = null;
  let engineOrderPayment = null;

  // pass 1
  for (const log of rc.logs) {
    const t0 = log.topics[0];

    if (t0 === T_ERC721_TRANSFER) {
      seller = ("0x" + log.topics[1].slice(26)).toLowerCase();
      buyer = ("0x" + log.topics[2].slice(26)).toLowerCase();
      tokenId = BigInt(log.topics[3]).toString();
      nft = log.address.toLowerCase();
      continue;
    }

    if (t0 === T_ERC721_APPROVAL || t0 === T_ERC721_APPROVAL_ALL) {
      const operator = ("0x" + log.topics[2].slice(26)).toLowerCase();
      if (operator === ENGINE_CONTRACT) {
        approvalToEngine = true;
        seller = tx.from.toLowerCase();
        nft = nft || log.address.toLowerCase();
      }
    }
  }

  // pass 2
  for (const log of rc.logs) {
    if (log.topics[0] !== T_ERC20_TRANSFER) continue;

    const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
    const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
    let parsed;
    try {
      parsed = ERC20_IFACE.parseLog(log);
    } catch {
      continue;
    }

    if (seller && to === seller) {
      tokenPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }

    if (approvalToEngine && from === seller && to === ENGINE_CONTRACT) {
      engineOrderPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }
  }

  if (approvalToEngine && !buyer && !ethPaid && !tokenPayment) {
    return { type: "LIST", nft, tokenId, seller, orderPayment: engineOrderPayment, tx };
  }

  if (nft && buyer && seller) {
    return { type: "BUY", nft, tokenId, buyer, seller, ethPaid, tokenPayment, tx };
  }

  return null;
}

/* ======================================================
   EMBEDS (POLISHED)
====================================================== */
async function buildPriceString(provider, ethPaid, tokenPayment) {
  if (ethPaid && ethPaid > 0n)
    return `${fmtNumber(ethers.formatEther(ethPaid))} ETH`;

  if (tokenPayment) {
    const info = await safeTokenInfo(provider, tokenPayment.token);
    if (info) {
      return `${fmtNumber(
        ethers.formatUnits(tokenPayment.amount, info.decimals)
      )} ${info.symbol}`;
    }
  }
  return "N/A (Engine order)";
}

async function sendEngineEmbed(client, provider, data, chans) {
  const name = data.nft ? await safeCollectionName(provider, data.nft) : "NFT";
  const titleBase = `${name} #${data.tokenId}`;
  const thumb =
    data.nft && data.tokenId
      ? await safeThumbnail(provider, data.nft, data.tokenId)
      : null;

  const fields = [];

  if (data.type === "LIST") {
    const price = data.orderPayment
      ? await buildPriceString(provider, 0n, data.orderPayment)
      : "N/A (Engine order)";

    fields.push(
      { name: "Price", value: price, inline: false },
      { name: "Seller", value: shortWalletLink(data.seller), inline: false },
      { name: "Method", value: "ENGINE", inline: false }
    );
  }

  if (data.type === "BUY") {
    const price = await buildPriceString(provider, data.ethPaid, data.tokenPayment);

    fields.push(
      { name: "Price", value: price, inline: false },
      { name: "Buyer", value: shortWalletLink(data.buyer), inline: false },
      { name: "Seller", value: shortWalletLink(data.seller), inline: false },
      { name: "Method", value: "ENGINE", inline: false }
    );
  }

  const embed = {
    title:
      data.type === "LIST"
        ? `📌 ${titleBase} — LISTED`
        : `🛒 ${titleBase} — SOLD`,
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
}

/* ======================================================
   MAIN LOOP (UNCHANGED)
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall("base", (p) => p);
  if (!provider) return;

  await ensureCheckpoint(client);

  const latest = await provider.getBlockNumber();
  if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
    await setLastBlock(client, latest - 25);
    global.__engineSweepResetDone = true;
  }

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to = Math.min(latest, from + MAX_BLOCKS);

  const engineLogs = await provider.getLogs({
    address: ENGINE_CONTRACT,
    fromBlock: from,
    toBlock: to
  });

  const approvalLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [T_ERC721_APPROVAL, null, ENGINE_TOPIC]
  });

  const approvalAllLogs = await provider.getLogs({
    fromBlock: from,
    toBlock: to,
    topics: [T_ERC721_APPROVAL_ALL, null, ENGINE_TOPIC]
  });

  const merged = [
    ...engineLogs.map(l => l.transactionHash),
    ...approvalLogs.map(l => l.transactionHash),
    ...approvalAllLogs.map(l => l.transactionHash)
  ];

  const txs = [...new Set(merged)].slice(0, MAX_TXS);
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

  if (BOOT_PING) {
    resolveChannels(client).then((chs) => {
      for (const ch of chs)
        ch.send("🧹 Engine Sweep notifier online").catch(() => {});
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };

