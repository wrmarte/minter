const { Interface, ethers } = require("ethers");
const { safeRpcCall } = require("./providerM");
const { shortWalletLink } = require("../utils/helpers");

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  "0x0351f7cba83277e891d4a85da498a7eacd764d58".toLowerCase();

const POLL_MS = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS = Number(process.env.SWEEP_MAX_TX_PER_TICK || 250);

const DEBUG = process.env.SWEEP_DEBUG === "1";
const BOOT_PING = process.env.SWEEP_BOOT_PING === "1";
const FORCE_RESET_SWEEP = process.env.SWEEP_FORCE_RESET === "1"; // one deploy only

const SWEEP_IMG = process.env.SWEEP_IMG || "https://iili.io/3tSecKP.gif";

/* ======================================================
   CHECKPOINT (prevents repeats)
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

const TOPIC_ERC721_TRANSFER = ethers.id("Transfer(address,address,uint256)");
const TOPIC_ERC721_APPROVAL = ethers.id("Approval(address,address,uint256)");
const TOPIC_ERC721_APPROVAL_ALL = ethers.id("ApprovalForAll(address,address,bool)");

const TOPIC_ERC20_TRANSFER = ethers.id("Transfer(address,address,uint256)");

/* ======================================================
   HELPERS
====================================================== */
const seenTx = new Set();

function fmtNumber(x) {
  try {
    // adds commas; safe for decimals string
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
    const n = await c.name();
    return n || null;
  } catch {
    return null;
  }
}

async function safeThumbnail(provider, nftAddr, tokenId) {
  // ERC721 only, best-effort, never throws
  try {
    const c = new ethers.Contract(nftAddr, ERC721_IFACE, provider);
    let uri = await c.tokenURI(tokenId);
    if (!uri) return null;

    if (uri.startsWith("ipfs://")) uri = "https://ipfs.io/ipfs/" + uri.slice(7);

    const res = await fetch(uri, { timeout: 6000 });
    if (!res.ok) return null;

    const meta = await res.json();
    let img = meta.image || meta.image_url;
    if (!img) return null;

    if (img.startsWith("ipfs://")) img = "https://ipfs.io/ipfs/" + img.slice(7);
    return img;
  } catch {
    return null;
  }
}

function pickMostCommon(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  let best = null,
    bestN = 0;
  for (const [k, n] of m.entries()) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function shortList(ids, max = 20) {
  const out = ids.slice(0, max).map((id) => `#${id}`).join(", ");
  return ids.length > max ? `${out} … +${ids.length - max}` : out;
}

/* ======================================================
   CHANNEL ROUTING (same DB mint uses)
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
   ANALYZE TX
   Detects:
   - LIST (approval to engine, no sale)
   - BUY (sale happened; buyer/seller + price)
   - ENGINE BUY (engine is buyer)
   - ENGINE BUY + RELIST (sale + approval to engine in same tx)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  const toEngine = (tx.to || "").toLowerCase() === ENGINE_CONTRACT;

  // Gather transfers and approvals
  /** transfers: [{nft, tokenId, from, to}] */
  const transfers = [];
  /** approvals: [{owner, operator, tokenId?, all}] */
  const approvals = [];

  // ERC20 payments: {token, from, to, amount}
  const erc20Pays = [];

  for (const log of rc.logs) {
    const t0 = log.topics?.[0];

    // ERC721 Transfer
    if (t0 === TOPIC_ERC721_TRANSFER && log.topics.length >= 4) {
      const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
      const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
      const tokenId = BigInt(log.topics[3]).toString();

      transfers.push({
        nft: log.address.toLowerCase(),
        tokenId,
        from,
        to
      });
      continue;
    }

    // ERC721 Approval
    if (t0 === TOPIC_ERC721_APPROVAL && log.topics.length >= 4) {
      const owner = ("0x" + log.topics[1].slice(26)).toLowerCase();
      const operator = ("0x" + log.topics[2].slice(26)).toLowerCase();
      const tokenId = BigInt(log.topics[3]).toString();
      approvals.push({ owner, operator, tokenId, all: false });
      continue;
    }

    // ERC721 ApprovalForAll
    if (t0 === TOPIC_ERC721_APPROVAL_ALL && log.topics.length >= 3) {
      const owner = ("0x" + log.topics[1].slice(26)).toLowerCase();
      const operator = ("0x" + log.topics[2].slice(26)).toLowerCase();
      let ok = false;
      try {
        ok = ethers.AbiCoder.defaultAbiCoder().decode(["bool"], log.data)?.[0];
      } catch {}
      if (ok) approvals.push({ owner, operator, tokenId: null, all: true });
      continue;
    }

    // ERC20 payments
    if (t0 === TOPIC_ERC20_TRANSFER && log.topics.length >= 3) {
      const from = ("0x" + log.topics[1].slice(26)).toLowerCase();
      const to = ("0x" + log.topics[2].slice(26)).toLowerCase();
      try {
        const parsed = ERC20_IFACE.parseLog(log);
        erc20Pays.push({
          token: log.address.toLowerCase(),
          from,
          to,
          amount: parsed.args.value
        });
      } catch {}
      continue;
    }
  }

  // If no engine interaction, ignore (we only scan engineLogs anyway)
  if (!toEngine && approvals.length === 0 && transfers.length === 0) return null;

  // Identify primary NFT in this tx (most common collection)
  const nftAddress = pickMostCommon(transfers.map((t) => t.nft)) || null;
  const nftTransfers = nftAddress
    ? transfers.filter((t) => t.nft === nftAddress)
    : [];

  // If multiple token IDs in same collection, we can still show them (sweep-style)
  const tokenIds = nftTransfers.map((t) => t.tokenId);

  // Determine sale vs list:
  // SALE = has at least one transfer AND there is payment (ETH>0 OR ERC20 pay)
  const ethPaid = tx.value && tx.value > 0n ? tx.value : 0n;

  // Best guess buyer/seller from transfers
  const buyer = nftTransfers.length ? pickMostCommon(nftTransfers.map((t) => t.to)) : null;
  const seller = nftTransfers.length ? pickMostCommon(nftTransfers.map((t) => t.from)) : null;

  // Determine ERC20 payment to seller (most common pay "to")
  let tokenPayment = null;
  if (seller) {
    // choose the largest ERC20 transfer sent to seller (common)
    const paysToSeller = erc20Pays.filter((p) => p.to === seller);
    if (paysToSeller.length) {
      paysToSeller.sort((a, b) => (b.amount > a.amount ? 1 : -1));
      tokenPayment = paysToSeller[0];
    }
  }

  const hasSale = nftTransfers.length > 0 && (ethPaid > 0n || !!tokenPayment);

  // Detect “relist” in same tx: approval to engine by the *new owner/buyer* (or engine)
  const approvalToEngine = approvals.some((a) => a.operator === ENGINE_CONTRACT);
  const relistSameTx =
    hasSale &&
    approvalToEngine &&
    buyer &&
    approvals.some((a) => a.operator === ENGINE_CONTRACT && a.owner === buyer);

  // If no sale but approval-to-engine exists => LIST action
  if (!hasSale && approvalToEngine) {
    // try to associate tokenId if approval event had one and we saw it
    const tok = approvals.find((a) => a.operator === ENGINE_CONTRACT && a.tokenId)?.tokenId || null;
    return {
      type: "LIST",
      tx,
      nft: nftAddress,
      tokenId: tok || (tokenIds[0] || null),
      tokenIds: tok ? [tok] : tokenIds,
      seller: (tx.from || "").toLowerCase(),
      relist: false
    };
  }

  // Sale happened
  if (hasSale) {
    const engineIsBuyer = buyer === ENGINE_CONTRACT;

    return {
      type: relistSameTx ? "ENGINE_BUY_RELIST" : engineIsBuyer ? "ENGINE_BUY" : "BUY",
      tx,
      nft: nftAddress,
      tokenId: tokenIds[0] || null,
      tokenIds,
      buyer,
      seller,
      ethPaid,
      tokenPayment
    };
  }

  // Fallback: if it was an engine tx but neither list nor sale detected, ignore
  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function buildPriceString(provider, ethPaid, tokenPayment) {
  try {
    if (ethPaid && ethPaid > 0n) {
      return `${fmtNumber(ethers.formatEther(ethPaid))} ETH`;
    }
    if (tokenPayment) {
      const info = await safeTokenInfo(provider, tokenPayment.token);
      if (info) {
        const amt = ethers.formatUnits(tokenPayment.amount, info.decimals);
        return `${fmtNumber(amt)} ${info.symbol}`;
      }
      // fallback: assume 18
      const amt = ethers.formatUnits(tokenPayment.amount, 18);
      return `${fmtNumber(amt)} TOKEN`;
    }
    return "N/A";
  } catch {
    return "N/A";
  }
}

async function sendEngineEmbed(client, provider, data, chans) {
  const nftName = data.nft ? (await safeCollectionName(provider, data.nft)) : null;
  const ids = (data.tokenIds && data.tokenIds.length) ? data.tokenIds : (data.tokenId ? [data.tokenId] : []);
  const idLine = ids.length ? shortList(ids, 30) : "N/A";

  // Thumbnail (ERC721 best effort)
  const thumb =
    data.nft && ids.length
      ? await safeThumbnail(provider, data.nft, ids[0])
      : null;

  const when = new Date().toLocaleString();

  let title = "Engine Event";
  let desc = "";
  let color = 0x95a5a6;
  const fields = [];

  if (data.type === "LIST") {
    title = `📌 ${nftName ? nftName + " " : ""}#${ids[0] || ""}`.trim();
    desc = `NFT Listed on Engine\n${when}`;
    color = 0x2ecc71;

    // Price for LIST: engine often stores it internally; without engine ABI we can’t reliably decode.
    // If you later give the engine event signature, we can make this exact.
    fields.push(
      { name: "Token", value: idLine, inline: false },
      { name: "Price", value: "N/A (Engine order data)", inline: true },
      { name: "Seller", value: shortWalletLink(data.seller), inline: true },
      { name: "Method", value: "ENGINE", inline: true }
    );
  }

  if (data.type === "BUY" || data.type === "ENGINE_BUY" || data.type === "ENGINE_BUY_RELIST") {
    const priceStr = await buildPriceString(provider, data.ethPaid, data.tokenPayment);

    if (data.type === "BUY") {
      title = `🛒 ${nftName ? nftName + " " : ""}#${ids[0] || ""}`.trim();
      desc = `NFT Bought via Engine\n${when}`;
      color = 0xf1c40f;
    }

    if (data.type === "ENGINE_BUY") {
      title = `🤖 ${nftName ? nftName + " " : ""}#${ids[0] || ""}`.trim();
      desc = `Engine Auto-Buy\n${when}`;
      color = 0xe67e22;
    }

    if (data.type === "ENGINE_BUY_RELIST") {
      title = `♻️ ${nftName ? nftName + " " : ""}#${ids[0] || ""}`.trim();
      desc = `Engine Auto-Buy + Relist\n${when}`;
      color = 0x9b59b6;
    }

    fields.push(
      { name: "Token", value: idLine, inline: false },
      { name: "Price", value: priceStr, inline: true },
      { name: "Buyer", value: shortWalletLink(data.buyer), inline: true },
      { name: "Seller", value: shortWalletLink(data.seller), inline: true },
      { name: "Method", value: "ENGINE", inline: true }
    );
  }

  const embed = {
    title,
    description: desc,
    fields,
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color,
    footer: { text: "Engine • PimpsDev" },
    timestamp: new Date().toISOString()
  };

  if (thumb) embed.thumbnail = { url: thumb };
  embed.image = { url: SWEEP_IMG }; // optional: keep your gif branding

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

  if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
    await setLastBlock(client, latest - 25);
    global.__engineSweepResetDone = true;
    console.log("🧹 [SWEEP] checkpoint force-reset (one-time)");
  }

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to = Math.min(latest, from + MAX_BLOCKS);

  DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

  // Only engine logs => small & reliable
  const engineLogs = await provider.getLogs({
    address: ENGINE_CONTRACT,
    fromBlock: from,
    toBlock: to
  });

  const txs = [...new Set(engineLogs.map((l) => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seenTx.has(h)) continue;
    seenTx.add(h);

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    DEBUG && console.log(`[SWEEP] MATCH ${res.type} ${h}`);
    await sendEngineEmbed(client, provider, res, chans);
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
