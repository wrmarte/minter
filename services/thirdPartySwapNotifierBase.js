const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/**
 * Third Party Swap Notifier (Base)
 * Detects swaps:
 *   - ETH/WETH -> ADRIAN  (BUY)
 *   - ADRIAN -> ETH/WETH  (SELL)
 *
 * It only posts when it can infer BOTH sides of the swap (token + eth/weth).
 */

// --- CONFIG ---
const ADRIAN = '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'.toLowerCase();

// Base canonical WETH
// (Base uses 0x4200...0006 for WETH)
const WETH = '0x4200000000000000000000000000000000000006'.toLowerCase();

// Where to post (comma list of Discord channel IDs)
// Example: SWAP_NOTI_CHANNELS="123,456,789"
const SWAP_NOTI_CHANNELS = (process.env.SWAP_NOTI_CHANNELS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// Anti-spam: only post if >= this USD
const MIN_USD_TO_POST = Number(process.env.SWAP_MIN_USD || 0.25);

// Scan cadence / blocks
const POLL_MS = Number(process.env.SWAP_POLL_MS || 8000);
const LOOKBACK_BLOCKS = Number(process.env.SWAP_LOOKBACK_BLOCKS || 5);

// Images (swap these anytime)
const BUY_IMG = 'https://iili.io/3tSecKP.gif';
const SELL_IMG = 'https://iili.io/f7SxSte.gif';

// --- Topics / iface ---
const ERC20_IFACE = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

// tx dedupe
const seenTx = new Set();

// --- ETH/USD cache ---
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

// --- ERC20 decimals cache ---
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

function normalizeChannels(chs) {
  if (Array.isArray(chs)) return chs.map(String).filter(Boolean);
  return [];
}

function sumBN(a, b) {
  try { return (a || 0n) + (b || 0n); } catch { return a || 0n; }
}

function safeAddr(x) {
  try { return ethers.getAddress(x); } catch { return x || ''; }
}

function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

/**
 * Build emoji bar:
 * - if usd >= 10: 🐳 per $5
 * - else: 🟥🟦🚀 per $2
 */
function buildEmojiLine(isBuy, usd) {
  const u = Number(usd);
  if (!Number.isFinite(u) || u <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';

  if (isBuy && u >= 10) {
    const whales = Math.max(1, Math.floor(u / 5));
    return '🐳'.repeat(Math.min(whales, 20));
  }

  const count = Math.max(1, Math.floor(u / 2));
  const capped = Math.min(count, 20);
  return isBuy ? '🟥🟦🚀'.repeat(capped) : '🔻💀🔻'.repeat(capped);
}

/**
 * Core: infer swap amounts from receipt logs.
 * We treat tx.from as the trader.
 * We compute net ADRIAN and net WETH for trader:
 *   received - sent
 * If trader net ADRIAN > 0 and net WETH/ETH < 0 => BUY
 * If trader net ADRIAN < 0 and net WETH/ETH > 0 => SELL
 */
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const trader = safeAddr(tx.from);
  if (!trader) return null;

  // ETH side (native)
  let ethNative = 0;
  try {
    if (tx.value && tx.value > 0n) ethNative = Number(ethers.formatEther(tx.value));
  } catch {}

  // Token side raw sums (in smallest units)
  let adrianIn = 0n, adrianOut = 0n;
  let wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    const logAddr = (lg.address || '').toLowerCase();
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length !== 3) continue;

    // Only care about ADRIAN and WETH transfers
    if (logAddr !== ADRIAN && logAddr !== WETH) continue;

    let parsed;
    try { parsed = ERC20_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const val = parsed.args.value;

    if (logAddr === ADRIAN) {
      if (addrEq(to, trader)) adrianIn = sumBN(adrianIn, val);
      if (addrEq(from, trader)) adrianOut = sumBN(adrianOut, val);
    }

    if (logAddr === WETH) {
      if (addrEq(to, trader)) wethIn = sumBN(wethIn, val);
      if (addrEq(from, trader)) wethOut = sumBN(wethOut, val);
    }
  }

  // Convert to decimals
  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec = await getDecimals(provider, WETH);

  const adrianInF = Number(ethers.formatUnits(adrianIn, adrianDec));
  const adrianOutF = Number(ethers.formatUnits(adrianOut, adrianDec));
  const wethInF = Number(ethers.formatUnits(wethIn, wethDec));
  const wethOutF = Number(ethers.formatUnits(wethOut, wethDec));

  const netAdrian = adrianInF - adrianOutF;
  const netWeth = wethInF - wethOutF;

  // We only want swaps, so we require BOTH sides to be present
  // BUY: gets ADRIAN, pays ETH/WETH
  const isBuy = netAdrian > 0 && (ethNative > 0 || netWeth < 0);
  // SELL: gives ADRIAN, receives WETH (native receive isn't visible in tx.value)
  const isSell = netAdrian < 0 && netWeth > 0;

  if (!isBuy && !isSell) return null;

  const ethValue = isBuy
    ? (ethNative > 0 ? ethNative : Math.abs(netWeth)) // spent
    : Math.abs(netWeth);                               // received

  const tokenAmount = Math.abs(netAdrian);

  // sanity
  if (!Number.isFinite(ethValue) || ethValue <= 0) return null;
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;

  const ethUsd = await getEthUsdPriceCached();
  const usdValue = ethUsd > 0 ? ethValue * ethUsd : 0;

  return {
    trader,
    txHash: txHash.toLowerCase(),
    isBuy,
    isSell,
    ethValue,
    usdValue,
    tokenAmount
  };
}

async function sendSwapEmbed(client, swap) {
  const { trader, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  // Filter tiny swaps (optional)
  if (usdValue && usdValue < MIN_USD_TO_POST) return;

  const emojiLine = buildEmojiLine(isBuy, usdValue);
  const title = isBuy ? `🅰️ ADRIAN SWAP BUY!` : `🅰️ ADRIAN SWAP SELL!`;

  const embed = {
    title,
    description: emojiLine,
    image: { url: isBuy ? BUY_IMG : SELL_IMG },
    fields: [
      {
        name: isBuy ? '💸 Spent' : '💰 Received',
        value: `$${usdValue ? usdValue.toFixed(2) : 'N/A'} / ${ethValue.toFixed(4)} ETH`,
        inline: true
      },
      {
        name: isBuy ? '🎯 Got' : '📤 Sold',
        value: `${tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADRIAN`,
        inline: true
      },
      {
        name: isBuy ? '👤 Swapper' : '🖕 Seller',
        value: shortWalletLink ? shortWalletLink(trader) : trader,
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x3498db : 0xff0000,
    footer: { text: 'Third-Party Swap Feed • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const channels = normalizeChannels(SWAP_NOTI_CHANNELS);
  for (const id of channels) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch?.isTextBased?.()) {
      await ch.send({ embeds: [embed] }).catch(() => {});
    }
  }
}

/**
 * Start the swap watcher
 * - Scans ADRIAN Transfer logs for the last N blocks
 * - Groups by txHash and analyzes receipts
 */
function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  if (!SWAP_NOTI_CHANNELS.length) {
    console.log('⚠️ SWAP_NOTI_CHANNELS not set. Swap notifier will run but has nowhere to post.');
  }

  setInterval(async () => {
    const provider = await safeRpcCall('base', p => p);
    if (!provider) return;

    const blockNumber = await provider.getBlockNumber().catch(() => null);
    if (!blockNumber) return;

    const fromBlock = Math.max(blockNumber - LOOKBACK_BLOCKS, 0);
    const toBlock = blockNumber;

    // pull ADRIAN transfers only (cheap)
    let logs = [];
    try {
      logs = await provider.getLogs({
        address: ADRIAN,
        topics: [TRANSFER_TOPIC],
        fromBlock,
        toBlock
      });
    } catch {
      return;
    }

    // group unique txs
    const txs = [];
    for (const lg of logs) {
      const h = (lg.transactionHash || '').toLowerCase();
      if (!h) continue;
      if (seenTx.has(h)) continue;
      seenTx.add(h);
      txs.push(h);
    }

    // analyze + send
    for (const h of txs) {
      const swap = await analyzeSwap(provider, h);
      if (!swap) continue;
      await sendSwapEmbed(client, swap);
    }
  }, POLL_MS);

  console.log('✅ Third-party swap notifier (Base) started.');
}

module.exports = {
  startThirdPartySwapNotifierBase
};
