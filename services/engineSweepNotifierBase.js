const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

// 🔒 TEST SERVER ONLY
const TEST_GUILD_ID = "1109969059497386054";

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = 80;
const MAX_BLOCKS = 25;
const MAX_TXS = 150;

const DEBUG = process.env.SWEEP_DEBUG === "1";

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
   TIMEOUT GUARD
====================================================== */
function withTimeout(p, ms = 7000) {
  return Promise.race([
    p,
    new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))
  ]);
}

/* ======================================================
   CACHES
====================================================== */
const nameCache = new Map();
const tokenCache = new Map();

/* ======================================================
   HELPERS
====================================================== */
function fmt(x) {
  const [a, b] = String(x).split(".");
  return b ? `${a.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${b}` : a;
}

async function safeName(provider, addr) {
  if (nameCache.has(addr)) return nameCache.get(addr);
  try {
    const n = await withTimeout(
      new ethers.Contract(addr, ERC721, provider).name()
    );
    nameCache.set(addr, n);
    return n;
  } catch {
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

    const r = await withTimeout(fetch(uri));
    const j = await r.json();

    let img = j.image || j.image_url;
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
    const info = { symbol, decimals };
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
      await client.channels.fetch(row.channel_id).catch(() => null);

    if (ch?.isTextBased() && ch.guild?.id === TEST_GUILD_ID) out.push(ch);
  }
  return out;
}

/* ======================================================
   SAFE LOG FETCH (ENGINE ONLY)
====================================================== */
async function getEngineLogs(provider, from, to) {
  try {
    return await withTimeout(
      provider.getLogs({
        address: ENGINE_CONTRACT,
        fromBlock: from,
        toBlock: to
      })
    );
  } catch (e) {
    DEBUG && console.log(`[SWEEP] log fetch failed ${from}-${to}, splitting`);
    if (to - from <= 1) return [];
    const mid = Math.floor((from + to) / 2);
    const a = await getEngineLogs(provider, from, mid);
    const b = await getEngineLogs(provider, mid + 1, to);
    return [...a, ...b];
  }
}

/* ======================================================
   ANALYZE TX (UNCHANGED LOGIC)
====================================================== */
async function analyzeTx(provider, hash) {
  const rc = await withTimeout(provider.getTransactionReceipt(hash));
  if (!rc) return null;

  let nft, tokenId, buyer, seller;
  let approved = false;
  let tokenPayment = null;

  for (const log of rc.logs) {
    if (
      log.topics[0] === T_ERC721_TRANSFER &&
      log.topics.length === 4
    ) {
      nft = log.address.toLowerCase();
      seller = "0x" + log.topics[1].slice(26);
      buyer  = "0x" + log.topics[2].slice(26);
      tokenId = BigInt(log.topics[3]).toString();
    }
  }

  for (const log of rc.logs) {
    if (
      log.topics[0] === T_ERC721_APPROVAL ||
      log.topics[0] === T_ERC721_APPROVAL_ALL
    ) {
      const op = "0x" + log.topics[2].slice(26);
      if (op.toLowerCase() === ENGINE_CONTRACT) {
        approved = true;
        seller = seller || rc.from.toLowerCase();
        nft = nft || log.address.toLowerCase();
      }
    }
  }

  for (const log of rc.logs) {
    if (log.topics[0] !== T_ERC20_TRANSFER) continue;
    const to = "0x" + log.topics[2].slice(26);
    if (seller && to.toLowerCase() === seller.toLowerCase()) {
      tokenPayment = {
        token: log.address.toLowerCase(),
        amount: ERC20.parseLog(log).args.value
      };
    }
  }

  if (approved && (!buyer || buyer.toLowerCase() === ENGINE_CONTRACT)) {
    if (!tokenId) return null;
    return { type: "LIST", nft, tokenId, seller, txHash: hash };
  }

  if (buyer && buyer.toLowerCase() !== ENGINE_CONTRACT) {
    if (!tokenId) return null;
    return { type: "BUY", nft, tokenId, buyer, seller, tokenPayment, txHash: hash };
  }

  return null;
}

/* ======================================================
   EMBEDS (UNCHANGED)
====================================================== */
async function sendEmbed(client, provider, data, chans) {
  const [name, thumb] = await Promise.all([
    safeName(provider, data.nft),
    safeThumb(provider, data.nft, data.tokenId)
  ]);

  const fields = [];

  if (data.type === "LIST") {
    fields.push(
      { name: "List Price", value: "N/A (Engine order)" },
      { name: "Seller", value: shortWalletLink(data.seller) },
      { name: "Method", value: "ENGINE" }
    );
  }

  if (data.type === "BUY") {
    let price = "N/A";
    if (data.tokenPayment) {
      const info = await tokenInfo(provider, data.tokenPayment.token);
      if (info) {
        price = `${fmt(
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

  const logs = await getEngineLogs(provider, from, to);
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
  console.log("🧹 Engine Sweep notifier started (stable)");
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };



