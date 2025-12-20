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
const ERC20_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

const seenTx = new Map();
function markSeen(txh) {
  const now = Date.now();
  seenTx.set(txh, now);
  if (seenTx.size > 5000) {
    const cutoff = now - 6 * 60 * 60 * 1000;
    for (const [k, ts] of seenTx.entries()) if (ts < cutoff) seenTx.delete(k);
  }
}
function isSeen(txh) { return seenTx.has(txh); }

let _ethUsdCache = { value: 0, ts: 0 };
async function getEthUsdPriceCached(maxAgeMs = 30_000) {
  const now = Date.now();
  if (_ethUsdCache.value > 0 && (now - _ethUsdCache.ts) < maxAgeMs) return _ethUsdCache.value;
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json().catch(() => null);
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

function safeAddr(x) { try { return ethers.getAddress(x); } catch { return x || ''; } }
function addrEq(a, b) { return (a || '').toLowerCase() === (b || '').toLowerCase(); }

function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';
  if (isBuy && u >= 30) {
    const whales = Math.max(1, Math.floor(u / 2));
    return '🐳🚀'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }
  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻').repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

// ======= TAG HELPERS =======
function resolveRoleTag(channel, roleName) {
  try {
    const role = channel.guild.roles.cache.find(r => r.name === roleName);
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
    const erc20 = new Contract(tokenAddr, ['function totalSupply() view returns (uint256)'], provider);
    const raw = await erc20.totalSupply();
    const dec = await getDecimals(provider, tokenAddr);
    const supply = Number(ethers.formatUnits(raw, dec));
    totalSupplyCache.set(tokenAddr, supply);
    return supply;
  } catch {
    return 0;
  }
}

function formatCompactUsd(n) {
  if (!n || !isFinite(n)) return 'N/A';
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3)  return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

// ================= EMBED (ONLY PATCHED PART) =================
async function sendSwapEmbed(client, swap, provider) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  const emojiLine = buildEmojiLine(isBuy, usdValue);

  const priceUsd = usdValue && tokenAmount ? usdValue / tokenAmount : 0;
  const priceEth = ethValue && tokenAmount ? ethValue / tokenAmount : 0;

  let marketCapText = 'N/A';
  if (priceUsd > 0) {
    const supply = await getTotalSupplyCached(provider, ADRIAN);
    if (supply > 0) marketCapText = formatCompactUsd(priceUsd * supply);
  }

  const embed = {
    title: isBuy ? `🅰️ ADRIAN BUY` : `🅰️ ADRIAN SELL`,
    description: emojiLine,
    image: { url: isBuy ? BUY_IMG : SELL_IMG },
    fields: [
      { name: '💸 Value', value: `$${usdValue.toFixed(2)} / ${ethValue.toFixed(4)} ETH`, inline: true },
      { name: '🎯 Amount', value: `${tokenAmount.toLocaleString()} ADRIAN`, inline: true },
      { name: '🏷️ Price', value: `$${priceUsd.toFixed(6)} / ${priceEth.toFixed(8)} ETH`, inline: true },
      { name: '📊 Market Cap', value: marketCapText, inline: true },
      { name: '👤 Wallet', value: shortWalletLink(wallet), inline: true }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x2ecc71 : 0xe74c3c,
    footer: { text: 'AdrianSWAP • PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const channels = await resolveChannels(client);
  for (const ch of channels) {
    const tag = isBuy ? resolveRoleTag(ch, BUY_TAG_ROLE_NAME) : resolveRoleTag(ch, SELL_TAG_ROLE_NAME);
    const payload = tag
      ? { content: tag.mention, embeds: [embed], allowedMentions: { roles: [tag.roleId] } }
      : { embeds: [embed] };
    await ch.send(payload).catch(() => {});
  }
}

// ======= START LOOP (UNCHANGED) =======
function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  if (BOOT_PING) bootPing(client);
  tick(client);

  setInterval(() => tick(client), POLL_MS);
}

module.exports = { startThirdPartySwapNotifierBase };




