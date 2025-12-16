const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

// 🔒 TEST SERVER ONLY (TEMP)
const TEST_GUILD_ID = "1109969059497386054";

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = 80;

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
    if (uri.startsWith("ipfs://"))
      uri = "https://ipfs.io/ipfs/" + uri.slice(7);

    const r = await fetch(uri);
    const j = await r.json();

    let img = j.image || j.image_url;
    if (img?.startsWith("ipfs://"))
      img = "https://ipfs.io/ipfs/" + img.slice(7);

    return img;
  } catch {
    return null;
  }
}

async function tokenInfo(provider, addr) {
  try {
    const c = new ethers.Contract(addr, ERC20, provider);
    return { symbol: await c.symbol(), decimals: await c.decimals() };
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

    if (ch?.guild?.id === TEST_GUILD_ID) out.push(ch);
  }
  return out;
}

/* ======================================================
   ANALYZE TX (WORKING LOGIC)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  let nft, tokenId, buyer, seller;
  let approvedToEngine = false;
  let ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;
  let tokenPayment = null;

  for (const log of rc.logs) {
    if (log.topics[0] === T_ERC721_TRANSFER && log.topics.length === 4) {
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
      const operator = "0x" + log.topics[2].slice(26);
      if (operator.toLowerCase() === ENGINE_CONTRACT) {
        approvedToEngine = true;
        seller = tx.from.toLowerCase();
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

  if (approvedToEngine && !buyer) {
    return { type: "LIST", nft, tokenId, seller, tx };
  }

  if (buyer && buyer.toLowerCase() !== ENGINE_CONTRACT) {
    return {
      type: "BUY",
      nft,
      tokenId,
      buyer,
      seller,
      ethPaid,
      tokenPayment,
      tx
    };
  }

  return null;
}

/* ======================================================
   EMBEDS (WORKING)
====================================================== */
async function sendEmbed(client, provider, data, chans) {
  if (!data.tokenId) return;

  const name = await safeName(provider, data.nft);
  const thumb = await safeThumb(provider, data.nft, data.tokenId);

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
    if (data.ethPaid > 0n)
      price = `${ethers.formatEther(data.ethPaid)} ETH`;

    if (data.tokenPayment) {
      const info = await tokenInfo(provider, data.tokenPayment.token);
      if (info)
        price = `${ethers.formatUnits(
          data.tokenPayment.amount,
          info.decimals
        )} ${info.symbol}`;
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
    url: `https://basescan.org/tx/${data.tx.hash}`,
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

  const logs = await provider.getLogs({ fromBlock: from, toBlock: to });
  const txs = [...new Set(logs.map(l => l.transactionHash))];
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
  console.log("🧹 Engine Sweep notifier started (BASELINE)");
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };



