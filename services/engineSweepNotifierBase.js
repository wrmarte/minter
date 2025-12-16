const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

const ENGINE_TOPIC = "0x000000000000000000000000" + ENGINE_CONTRACT.slice(2);

// 🔒 TEST SERVER ONLY
const TEST_GUILD_ID = "1109969059497386054";

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS = Number(process.env.SWEEP_MAX_TX_PER_TICK || 150);

const DEBUG = process.env.SWEEP_DEBUG === "1";

/* ======================================================
   CHECKPOINT
====================================================== */
const CHECKPOINT_CHAIN = "base";
const CHECKPOINT_KEY = "engine_sweep_last_block";

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
   TIMEOUT WRAPPER (OPT #6)
====================================================== */
function withTimeout(promise, ms = 7000) {
  return Promise.race([
    promise,
    new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))
  ]);
}

/* ======================================================
   CACHES (OPT #3)
====================================================== */
const nameCache = new Map();
const tokenCache = new Map();

/* ======================================================
   HELPERS
====================================================== */
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
  if (nameCache.has(addr)) return nameCache.get(addr);
  try {
    const name = await withTimeout(
      new ethers.Contract(addr, ERC721, provider).name()
    );
    nameCache.set(addr, name);
    return name;
  } catch {
    nameCache.set(addr, "NFT");
    return "NFT";
  }
}

async function safeThumb(provider, addr, id) {
  try {
    let uri = await withTimeout(
      new ethers.Contract(addr, ERC721, provider).tokenURI(id)
    );
    if (!uri) return null;

    if (uri.startsWith("ipfs://"))
      uri = "https://ipfs.io/ipfs/" + uri.slice(7);

    const res = await withTimeout(fetch(uri));
    if (!res.ok) return null;

    const meta = await res.json();
    let img = meta.image || meta.image_url;
    if (!img) return null;

    if (img.startsWith("ipfs://"))
      img = "https://ipfs.io/ipfs/" + img.slice(7);

    return img;
  } catch {
    return null;
  }
}

async function tokenInfo(provider, addr) {
  if (tokenCache.has(addr)) return tokenCache.get(addr);
  try {
    const c = new ethers.Contract(addr, ERC20, provider);
    const [symbol, decimals] = await withTimeout(
      Promise.all([c.symbol(), c.decimals()])
    );
    const info = { symbol, decimals: Number(decimals) };
    tokenCache.set(addr, info);
    return info;
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
   ANALYZE TX (OPT #1 + #2)
====================================================== */
async function analyzeTx(provider, hash) {
  const rc = await withTimeout(provider.getTransactionReceipt(hash));
  if (!rc) return null;

  // OPT #2 — early exit
  if (
    !rc.logs.some(l =>
      l.topics[0] === T_ERC721_TRANSFER ||
      l.topics[0] === T_ERC721_APPROVAL ||
      l.topics[0] === T_ERC721_APPROVAL_ALL
    )
  ) return null;

  let nft, tokenId, buyer, seller;
  let approvedToEngine = false;
  let ethPaid = rc.effectiveGasPrice ? 0n : 0n;
  let tokenPayment = null;
  let listPayment = null;

  /* ---------- PASS 1: ERC721 Transfers ---------- */
  for (const log of rc.logs) {
    if (log.topics[0] !== T_ERC721_TRANSFER) continue;
    nft = log.address.toLowerCase();
    seller = "0x" + log.topics[1].slice(26);
    buyer = "0x" + log.topics[2].slice(26);
    tokenId = BigInt(log.topics[3]).toString();
  }

  /* ---------- PASS 2: Approvals ---------- */
  for (const log of rc.logs) {
    if (
      log.topics[0] === T_ERC721_APPROVAL ||
      log.topics[0] === T_ERC721_APPROVAL_ALL
    ) {
      const operator = "0x" + log.topics[2].slice(26);
      if (operator.toLowerCase() === ENGINE_CONTRACT) {
        approvedToEngine = true;
        nft = nft || log.address.toLowerCase();
        seller = seller || rc.from?.toLowerCase();
      }
    }
  }

  /* ---------- PASS 3: ERC20 Transfers ---------- */
  for (const log of rc.logs) {
    if (log.topics[0] !== T_ERC20_TRANSFER) continue;
    const from = "0x" + log.topics[1].slice(26);
    const to = "0x" + log.topics[2].slice(26);
    const parsed = ERC20.parseLog(log);

    if (seller && to.toLowerCase() === seller.toLowerCase()) {
      tokenPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }

    if (approvedToEngine && from.toLowerCase() === seller && to.toLowerCase() === ENGINE_CONTRACT) {
      listPayment = { token: log.address.toLowerCase(), amount: parsed.args.value };
    }
  }

  if (approvedToEngine && (!buyer || buyer === ENGINE_CONTRACT)) {
    if (!tokenId) return null;
    return { type: "LIST", nft, tokenId, seller, listPayment, txHash: hash };
  }

  if (buyer && buyer !== ENGINE_CONTRACT) {
    if (!tokenId) return null;
    return { type: "BUY", nft, tokenId, buyer, seller, tokenPayment, txHash: hash };
  }

  return null;
}

/* ======================================================
   EMBEDS (OPT #5 parallel fetch)
====================================================== */
async function sendEmbed(client, provider, data, chans) {
  const [name, thumb] = await Promise.all([
    safeName(provider, data.nft),
    safeThumb(provider, data.nft, data.tokenId)
  ]);

  const fields = [];

  if (data.type === "LIST") {
    let price = "N/A (Engine order)";
    if (data.listPayment) {
      const info = await tokenInfo(provider, data.listPayment.token);
      if (info) {
        price = `${fmtNumber(
          ethers.formatUnits(data.listPayment.amount, info.decimals)
        )} ${info.symbol}`;
      }
    }
    fields.push(
      { name: "List Price", value: price },
      { name: "Seller", value: shortWalletLink(data.seller) },
      { name: "Method", value: "ENGINE" }
    );
  }

  if (data.type === "BUY") {
    let price = "N/A";
    if (data.tokenPayment) {
      const info = await tokenInfo(provider, data.tokenPayment.token);
      if (info) {
        price = `${fmtNumber(
          ethers.formatUnits(data.tokenPayment.amount, info.decimals)
        )} ${info.symbol}`;
      }
    }
    fields.push(
      { name: "Sale Price", value: price },
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
    url: `https://basescan.org/tx/${data.txHash}`,
    color: data.type === "LIST" ? 0x2ecc71 : 0xf1c40f,
    footer: { text: "AdrianEngine • Powered by PimpsDev" },
    timestamp: new Date().toISOString()
  };

  if (thumb) embed.thumbnail = { url: thumb };

  for (const c of chans) await c.send({ embeds: [embed] });
}

/* ======================================================
   MAIN LOOP
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall("base", p => p);
  if (!provider) return;

  const latest = await provider.getBlockNumber();
  const from = latest - LOOKBACK;
  const to = latest;

  const logs = await withTimeout(
    provider.getLogs({ fromBlock: from, toBlock: to })
  ).catch(() => []);

  const txs = [...new Set(logs.map(l => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    const res = await analyzeTx(provider, h);
    if (res) await sendEmbed(client, provider, res, chans);
  }
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  console.log("🧹 Engine Sweep notifier started (optimized)");
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };




