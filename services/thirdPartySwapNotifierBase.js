const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ======= CONFIG =======
const ADRIAN = '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'.toLowerCase();
const WETH   = '0x4200000000000000000000000000000000000006'.toLowerCase();

// ✅ PUT YOUR ROUTERS HERE (lowercase)
const ROUTERS_TO_WATCH = [
  '0x498581ff718922c3f8e6a244956af099b2652b2b'
].map(a => (a || '').toLowerCase()).filter(Boolean);

// ✅ ENV fallback channels (only used if DB returns 0)
const SWAP_NOTI_CHANNELS = (process.env.SWAP_NOTI_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MIN_USD_TO_POST   = Number(process.env.SWAP_MIN_USD || 0);
const POLL_MS           = Number(process.env.SWAP_POLL_MS || 12000);
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 20);
const MAX_EMOJI_REPEAT  = Number(process.env.SWAP_MAX_EMOJIS || 20);

const BUY_IMG  = process.env.SWAP_BUY_IMG  || 'https://iili.io/f7ifqmB.gif';
const SELL_IMG = process.env.SWAP_SELL_IMG || 'https://iili.io/f7SxSte.gif';

const DEBUG = String(process.env.SWAP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWAP_BOOT_PING || '').trim() === '1';
const TEST_TX = (process.env.SWAP_TEST_TX || '').trim().toLowerCase();

// ======= TAG SYSTEM =======
const BUY_TAG_ROLE_NAME  = 'WAGMI';
const SELL_TAG_ROLE_NAME = 'NGMI';

// ======= CHECKPOINT (DB) =======
const CHECKPOINT_CHAIN = 'base';
const CHECKPOINT_KEY   = 'third_party_swaps_last_block';

let _checkpointReady = false;
async function ensureCheckpointTable(client) {
  if (_checkpointReady) return true;
  const pg = client.pg;
  if (!pg) return false;
  try {
    await pg.query(`
      CREATE TABLE IF NOT EXISTS swap_checkpoints (
        chain TEXT NOT NULL,
        key   TEXT NOT NULL,
        value BIGINT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT now(),
        PRIMARY KEY (chain, key)
      )
    `);
    _checkpointReady = true;
    return true;
  } catch (e) {
    console.log(`[SWAP] ensureCheckpointTable failed: ${e?.message || e}`);
    return false;
  }
}

async function getLastBlockFromDb(client) {
  const pg = client.pg;
  if (!pg) return null;
  try {
    const res = await pg.query(
      `SELECT value FROM swap_checkpoints WHERE chain=$1 AND key=$2`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY]
    );
    const v = res?.rows?.[0]?.value;
    return (v !== undefined && v !== null) ? Number(v) : null;
  } catch {
    return null;
  }
}

async function setLastBlockInDb(client, blockNum) {
  const pg = client.pg;
  if (!pg) return;
  const v = Number(blockNum);
  if (!Number.isFinite(v) || v <= 0) return;
  try {
    await pg.query(
      `INSERT INTO swap_checkpoints(chain, key, value)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain, key)
       DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [CHECKPOINT_CHAIN, CHECKPOINT_KEY, Math.floor(v)]
    );
  } catch {}
}

// ======= HELPERS =======
const ERC20_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint256 value)'
]);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 5000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) {
      if (ts < cutoff) seenTx.delete(k);
    }
  }
}
function isSeen(txh) {
  return seenTx.has(txh);
}

let _ethUsdCache = { value: 0, ts: 0 };
async function getEthUsdPriceCached(maxAgeMs = 30000) {
  const now = Date.now();
  if (_ethUsdCache.value && now - _ethUsdCache.ts < maxAgeMs) {
    return _ethUsdCache.value;
  }
  try {
    const res = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    const data = await res.json();
    const px = Number(data?.ethereum?.usd || 0);
    if (px > 0) {
      _ethUsdCache = { value: px, ts: now };
      return px;
    }
  } catch {}
  return _ethUsdCache.value || 0;
}

const decimalsCache = new Map();
async function getDecimals(provider, tokenAddr) {
  const key = tokenAddr.toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  try {
    const c = new Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
    const d = Number(await c.decimals());
    decimalsCache.set(key, d);
    return d;
  } catch {
    decimalsCache.set(key, 18);
    return 18;
  }
}

function safeAddr(x) {
  try { return ethers.getAddress(x); }
  catch { return x || ''; }
}
function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';
  if (isBuy && u >= 30) {
    const whales = Math.max(1, Math.floor(u / 2));
    return '🐳🚀'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }
  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻')
    .repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

// ======= TAG HELPERS =======
function resolveRoleTag(channel, roleName) {
  try {
    const role = channel.guild?.roles?.cache?.find(r => r.name === roleName);
    return role ? { mention: `<@&${role.id}>`, roleId: role.id } : null;
  } catch {
    return null;
  }
}

// ======= MARKET CAP HELPERS =======
const totalSupplyCache = new Map();
async function getTotalSupplyCached(provider, tokenAddr) {
  if (totalSupplyCache.has(tokenAddr)) return totalSupplyCache.get(tokenAddr);
  try {
    const erc20 = new Contract(
      tokenAddr,
      ['function totalSupply() view returns (uint256)'],
      provider
    );
    const raw = await erc20.totalSupply();
    const dec = await getDecimals(provider, tokenAddr);
    const supply = Number(ethers.formatUnits(raw, dec));
    if (supply > 0) {
      totalSupplyCache.set(tokenAddr, supply);
      return supply;
    }
  } catch {}
  return 0;
}

function formatCompactUsd(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return 'N/A';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (v >= 1e9)  return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6)  return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3)  return `$${(v / 1e3).toFixed(2)}K`;
  return `$${v.toFixed(4)}`;
}

// ======= CHANNEL RESOLUTION =======
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  try {
    const pg = client.pg;
    if (pg) {
      const res = await pg.query(
        `SELECT DISTINCT channel_id
         FROM tracked_tokens
         WHERE lower(address)=$1
           AND channel_id IS NOT NULL
           AND channel_id <> ''`,
        [ADRIAN]
      );
      for (const r of res.rows || []) {
        const id = String(r.channel_id || '').trim();
        if (!id || added.has(id)) continue;
        const ch = await fetchAndValidateChannel(client, id);
        if (ch) {
          out.push(ch);
          added.add(id);
        }
      }
    }
  } catch {}

  if (!out.length && SWAP_NOTI_CHANNELS.length) {
    for (const id of SWAP_NOTI_CHANNELS) {
      if (added.has(id)) continue;
      const ch = await fetchAndValidateChannel(client, id);
      if (ch) {
        out.push(ch);
        added.add(id);
      }
    }
  }

  return out;
}

async function fetchAndValidateChannel(client, id) {
  let ch = client.channels.cache.get(id) || null;
  if (!ch) ch = await client.channels.fetch(id).catch(() => null);
  if (!ch || !ch.isTextBased()) return null;

  try {
    const me = ch.guild?.members?.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (!perms?.has('SendMessages')) return null;
    if (ch.isThread?.() && !perms?.has('SendMessagesInThreads')) return null;
  } catch {}

  return ch;
}

// ======= ANALYZE SWAP =======
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  let adrianIn = 0n, adrianOut = 0n, wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC) continue;
    const token = lg.address.toLowerCase();
    if (token !== ADRIAN && token !== WETH) continue;
    const p = ERC20_IFACE.parseLog(lg);
    if (addrEq(p.args.to, wallet)) token === ADRIAN ? adrianIn += p.args.value : wethIn += p.args.value;
    if (addrEq(p.args.from, wallet)) token === ADRIAN ? adrianOut += p.args.value : wethOut += p.args.value;
  }

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec   = await getDecimals(provider, WETH);

  const netAdrian = Number(ethers.formatUnits(adrianIn - adrianOut, adrianDec));
  let ethValue = Number(ethers.formatUnits(wethOut || tx.value || 0n, wethDec));
  if (!netAdrian || !ethValue) return null;

  const ethUsd = await getEthUsdPriceCached();
  return {
    wallet,
    txHash: txHash.toLowerCase(),
    isBuy: netAdrian > 0,
    tokenAmount: Math.abs(netAdrian),
    ethValue,
    usdValue: ethValue * ethUsd
  };
}

// ======= SEND EMBED =======
async function sendSwapEmbed(client, swap, provider) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;
  if (MIN_USD_TO_POST > 0 && usdValue < MIN_USD_TO_POST) return;

  const emojiLine = buildEmojiLine(isBuy, usdValue);
  const priceUsd = usdValue / tokenAmount;
  const priceEth = ethValue / tokenAmount;
  const supply = await getTotalSupplyCached(provider, ADRIAN);
  const marketCap = supply ? priceUsd * supply : 0;

  const embed = {
    title: isBuy ? '🅰️ ADRIAN SWAP BUY!' : '🅰️ ADRIAN SWAP SELL!',
    description: `${emojiLine}\n**Price:** $${priceUsd.toFixed(6)} • ${priceEth.toFixed(8)} ETH`,
    image: { url: isBuy ? BUY_IMG : SELL_IMG },
    fields: [
      {
        name: isBuy ? '💸 Spent' : '💰 Received',
        value: `$${usdValue.toFixed(2)}\n${ethValue.toFixed(4)} ETH`,
        inline: true
      },
      {
        name: isBuy ? '🎯 Got' : '📤 Sold',
        value: `${tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADRIAN`,
        inline: true
      },
      {
        name: '📊 Market Cap',
        value: formatCompactUsd(marketCap),
        inline: true
      },
      {
        name: isBuy ? '👤 Swapper' : '🖕 Seller',
        value: shortWalletLink(wallet),
        inline: false
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x2ecc71 : 0xe74c3c,
    footer: { text: 'AdrianSWAP • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const chans = await resolveChannels(client);
  for (const ch of chans) {
    const tag = resolveRoleTag(ch, isBuy ? BUY_TAG_ROLE_NAME : SELL_TAG_ROLE_NAME);
    await ch.send(
      tag
        ? { content: tag.mention, embeds: [embed], allowedMentions: { roles: [tag.roleId] } }
        : { embeds: [embed] }
    ).catch(() => {});
  }
}

// ======= LOOP =======
async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  await ensureCheckpointTable(client);

  if (TEST_TX && !isSeen(TEST_TX)) {
    markSeen(TEST_TX);
    const swap = await analyzeSwap(provider, TEST_TX);
    if (swap) await sendSwapEmbed(client, swap, provider);
  }

  const blockNumber = await provider.getBlockNumber();
  let last = await getLastBlockFromDb(client);
  if (!last) last = Math.max(blockNumber - 2, 0);

  const fromBlock = Math.max(blockNumber - LOOKBACK_BLOCKS, last);
  const toBlock = blockNumber;

  const txs = new Set();
  for (const router of ROUTERS_TO_WATCH) {
    const logs = await provider.getLogs({ address: router, fromBlock, toBlock });
    for (const lg of logs) txs.add(lg.transactionHash.toLowerCase());
  }

  for (const h of txs) {
    if (isSeen(h)) continue;
    markSeen(h);
    const swap = await analyzeSwap(provider, h);
    if (swap) await sendSwapEmbed(client, swap, provider);
  }

  await setLastBlockInDb(client, toBlock);
}

// ======= START =======
function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;
  if (BOOT_PING) console.log('Swap notifier online');
  tick(client).catch(() => {});
  setInterval(() => tick(client).catch(() => {}), POLL_MS);
}

module.exports = { startThirdPartySwapNotifierBase };




