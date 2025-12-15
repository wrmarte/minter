const { Interface, ethers } = require('ethers');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/* ======================================================
   CONFIG
====================================================== */
const ENGINE_CONTRACT =
  '0x0351f7cba83277e891d4a85da498a7eacd764d58'.toLowerCase();

const POLL_MS    = Number(process.env.SWEEP_POLL_MS || 12000);
const LOOKBACK   = Number(process.env.SWEEP_LOOKBACK_BLOCKS || 80);
const MAX_BLOCKS = Number(process.env.SWEEP_MAX_BLOCKS_PER_TICK || 25);
const MAX_TXS    = Number(process.env.SWEEP_MAX_TX_PER_TICK || 300);

const DEBUG     = process.env.SWEEP_DEBUG === '1';
const BOOT_PING = process.env.SWEEP_BOOT_PING === '1';

const FORCE_RESET_SWEEP = process.env.SWEEP_FORCE_RESET === '1';

const RESERVOIR_KEY = process.env.RESERVOIR_API_KEY || null;

const SWEEP_IMG =
  process.env.SWEEP_IMG || 'https://iili.io/3tSecKP.gif';

/* ======================================================
   CHECKPOINT
====================================================== */
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'engine_sweep_last_block';

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
   ABIS / TOPICS
====================================================== */
const ERC721_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
  'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
  'function tokenURI(uint256) view returns (string)'
]);

const ERC1155_IFACE = new Interface([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)'
]);

const ERC721_TRANSFER = ethers.id('Transfer(address,address,uint256)');
const ERC721_APPROVAL = ethers.id('Approval(address,address,uint256)');
const ERC721_APPROVAL_ALL = ethers.id('ApprovalForAll(address,address,bool)');
const ERC1155_SINGLE = ethers.id('TransferSingle(address,address,address,uint256,uint256)');
const ERC1155_BATCH  = ethers.id('TransferBatch(address,address,address,uint256[],uint256[])');

/* ======================================================
   HELPERS
====================================================== */
const seen = new Set();

function emoji(n) {
  if (n >= 20) return '🐳🐳🐳🐳';
  if (n >= 10) return '🐳🐳🐳';
  if (n >= 5)  return '🐳🐳';
  if (n >= 3)  return '🐳';
  return '🧹';
}

function shortList(ids, max = 25) {
  const out = ids.slice(0, max).map(id => `#${id}`).join(', ');
  return ids.length > max ? `${out} … +${ids.length - max}` : out;
}

function pickMostCommon(arr) {
  const m = new Map();
  for (const v of arr) m.set(v, (m.get(v) || 0) + 1);
  let best = null, bestN = 0;
  for (const [k, n] of m.entries()) {
    if (n > bestN) { best = k; bestN = n; }
  }
  return best;
}

/* ======================================================
   NFT THUMBNAIL (SAFE)
====================================================== */
async function getNftThumbnail(provider, nft, tokenId) {
  try {
    const c = new ethers.Contract(nft, ERC721_IFACE, provider);
    let uri = await c.tokenURI(tokenId);
    if (!uri) return null;

    if (uri.startsWith('ipfs://'))
      uri = 'https://ipfs.io/ipfs/' + uri.slice(7);

    const res = await fetch(uri, { timeout: 5000 });
    if (!res.ok) return null;

    const meta = await res.json();
    let img = meta.image || meta.image_url;
    if (!img) return null;

    if (img.startsWith('ipfs://'))
      img = 'https://ipfs.io/ipfs/' + img.slice(7);

    return img;
  } catch {
    return null;
  }
}

/* ======================================================
   FLOOR PRICE (RESERVOIR, OPTIONAL)
====================================================== */
async function getFloorPrice(nft) {
  if (!RESERVOIR_KEY) return null;
  try {
    const res = await fetch(
      `https://api.reservoir.tools/collections/v7?id=${nft}`,
      { headers: { 'x-api-key': RESERVOIR_KEY } }
    );
    if (!res.ok) return null;
    const j = await res.json();
    const floor = j?.collections?.[0]?.floorAsk?.price?.amount?.decimal;
    return floor ? `${floor.toFixed(3)} ETH` : null;
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
      await client.channels.fetch(row.channel_id).catch(() => null);
    if (ch?.isTextBased()) out.push(ch);
  }
  return out;
}

/* ======================================================
   TX ANALYSIS (ENGINE EXECUTION MODEL)
====================================================== */
async function analyzeTx(provider, hash) {
  const tx = await provider.getTransaction(hash);
  const rc = await provider.getTransactionReceipt(hash);
  if (!tx || !rc) return null;

  const toEngine = (tx.to || '').toLowerCase() === ENGINE_CONTRACT;
  const approvals = [];
  const transfers = [];

  for (const log of rc.logs) {
    const t0 = log.topics?.[0];

    if (t0 === ERC721_TRANSFER && log.topics.length >= 4) {
      transfers.push({
        standard: 'ERC721',
        nft: log.address.toLowerCase(),
        tokenId: BigInt(log.topics[3]).toString(),
        from: ('0x' + log.topics[1].slice(26)).toLowerCase(),
        to:   ('0x' + log.topics[2].slice(26)).toLowerCase()
      });
    }

    if (t0 === ERC1155_SINGLE) {
      const p = ERC1155_IFACE.parseLog(log);
      transfers.push({
        standard: 'ERC1155',
        nft: log.address.toLowerCase(),
        tokenId: p.args.id.toString(),
        qty: p.args.value.toString(),
        from: p.args.from.toLowerCase(),
        to: p.args.to.toLowerCase()
      });
    }

    if (t0 === ERC1155_BATCH) {
      const p = ERC1155_IFACE.parseLog(log);
      for (let i = 0; i < p.args.ids.length; i++) {
        transfers.push({
          standard: 'ERC1155',
          nft: log.address.toLowerCase(),
          tokenId: p.args.ids[i].toString(),
          qty: p.args.values[i].toString(),
          from: p.args.from.toLowerCase(),
          to: p.args.to.toLowerCase()
        });
      }
    }

    if (t0 === ERC721_APPROVAL) {
      const approved = ('0x' + log.topics[2].slice(26)).toLowerCase();
      if (approved === ENGINE_CONTRACT) approvals.push(true);
    }

    if (t0 === ERC721_APPROVAL_ALL) {
      const operator = ('0x' + log.topics[2].slice(26)).toLowerCase();
      const ok = ethers.AbiCoder.defaultAbiCoder().decode(['bool'], log.data)[0];
      if (operator === ENGINE_CONTRACT && ok) approvals.push(true);
    }
  }

  if (toEngine && transfers.length) {
    const buyer = pickMostCommon(transfers.map(t => t.to));
    const seller = pickMostCommon(transfers.map(t => t.from));
    const tokenIds = transfers.map(t => t.tokenId);
    return {
      type: transfers.length > 1 ? 'SWEEP' : 'BUY',
      tx,
      buyer,
      seller,
      transfers,
      tokenIds
    };
  }

  if (approvals.length) {
    return { type: 'LIST', tx };
  }

  return null;
}

/* ======================================================
   EMBEDS
====================================================== */
async function sendBuy(client, data, chans, provider) {
  const first = data.transfers[0];
  const thumb =
    first.standard === 'ERC721'
      ? await getNftThumbnail(provider, first.nft, first.tokenId)
      : null;

  const floor = first.standard === 'ERC721'
    ? await getFloorPrice(first.nft)
    : null;

  const priceETH = data.tx.value
    ? `${ethers.formatEther(data.tx.value)} ETH`
    : 'N/A';

  const embed = {
    title:
      data.type === 'SWEEP'
        ? `🧹 Engine Sweep – ${data.transfers.length} NFTs`
        : `🛒 NFT Bought via Engine`,
    description: shortList(data.tokenIds),
    fields: [
      { name: 'Buyer', value: shortWalletLink(data.buyer), inline: true },
      { name: 'Seller', value: shortWalletLink(data.seller), inline: true },
      { name: 'Price Paid', value: priceETH, inline: true },
      { name: 'Floor', value: floor || 'N/A', inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: 0xf1c40f,
    footer: { text: 'Engine • PimpsDev' },
    timestamp: new Date().toISOString()
  };

  if (thumb) embed.thumbnail = { url: thumb };

  for (const c of chans) await c.send({ embeds: [embed] }).catch(() => {});
}

async function sendList(client, data, chans) {
  const embed = {
    title: '📌 NFT Listed in Engine',
    description: 'Approval granted to Engine',
    fields: [
      { name: 'Lister', value: shortWalletLink(data.tx.from), inline: true },
      { name: 'Method', value: 'ENGINE', inline: true }
    ],
    url: `https://basescan.org/tx/${data.tx.hash}`,
    color: 0x2ecc71,
    footer: { text: 'Engine • PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const c of chans) await c.send({ embeds: [embed] }).catch(() => {});
}

/* ======================================================
   MAIN LOOP
====================================================== */
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpoint(client);

  const latest = await provider.getBlockNumber();

  if (FORCE_RESET_SWEEP && !global.__engineSweepResetDone) {
    await setLastBlock(client, latest - 25);
    global.__engineSweepResetDone = true;
    console.log('🧹 [SWEEP] checkpoint force-reset');
  }

  let last = await getLastBlock(client);
  if (!last) last = latest - 5;

  const from = Math.max(last + 1, latest - LOOKBACK);
  const to   = Math.min(latest, from + MAX_BLOCKS);

  DEBUG && console.log(`[SWEEP] blocks ${from} → ${to}`);

  const engineLogs = await provider.getLogs({
    address: ENGINE_CONTRACT,
    fromBlock: from,
    toBlock: to
  });

  const txs = [...new Set(engineLogs.map(l => l.transactionHash))].slice(0, MAX_TXS);
  const chans = await resolveChannels(client);

  for (const h of txs) {
    if (seen.has(h)) continue;
    seen.add(h);

    const res = await analyzeTx(provider, h);
    if (!res) continue;

    if (res.type === 'LIST')
      await sendList(client, res, chans);

    if (res.type === 'BUY' || res.type === 'SWEEP')
      await sendBuy(client, res, chans, provider);
  }

  await setLastBlock(client, to);
}

/* ======================================================
   START
====================================================== */
function startEngineSweepNotifierBase(client) {
  if (global.__engineSweepStarted) return;
  global.__engineSweepStarted = true;

  console.log('🧹 Engine Sweep notifier started');

  if (BOOT_PING) {
    resolveChannels(client).then(chs => {
      for (const ch of chs)
        ch.send('🧹 Engine Sweep notifier online').catch(() => {});
    });
  }

  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startEngineSweepNotifierBase };
