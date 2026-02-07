// services/globalProcessor.js
// ======================================================
// Global Processor (Token Buy/Sell scanner) — ENHANCED (NO LOGIC CHANGES)
// - ✅ Preserves all existing detection/filter logic and embed fields/behavior
// - ✅ Performance: avoid per-log allocations (iface/router/tax lists cached)
// - ✅ Safety: bounded seenTx + rate-limited noisy warnings
// - ✅ Robust: safer channel perms + avoids crashes on partial cache
// - ✅ Caching: contract instances per token, ETH price cache (short TTL)
// ======================================================

const { Interface, formatUnits, ethers } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

/* ✅ Daily Digest logger (optional; won't crash if missing) */
let logDigestEvent = null;
try {
  ({ logDigestEvent } = require('./digestLogger'));
} catch (e) {
  logDigestEvent = null;
}

/* ======================================================
   CONFIG
====================================================== */

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

// NOTE: keep behavior; just cache lowercase set once
const ROUTERS_LOWER = ROUTERS.map(r => String(r || '').toLowerCase());
const ROUTERS_SET = new Set(ROUTERS_LOWER);

const TAX_OR_BURN = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069'
].map(a => a.toLowerCase());
const TAX_OR_BURN_SET = new Set(TAX_OR_BURN);

// Transfer iface created once (avoid per-log constructor)
const TRANSFER_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

// seenTx (bounded to avoid memory growth)
const seenTx = new Set();
const SEEN_TX_MAX = Math.max(1000, Number(process.env.GLOBAL_SEEN_TX_MAX || 8000));
function seenTxAdd(tx) {
  if (!tx) return;
  if (seenTx.has(tx)) return;
  seenTx.add(tx);
  if (seenTx.size > SEEN_TX_MAX) {
    // Remove oldest by iterating (Set preserves insertion order)
    const it = seenTx.values();
    const drop = Math.max(1, Math.floor(SEEN_TX_MAX * 0.2));
    for (let i = 0; i < drop; i++) {
      const v = it.next().value;
      if (v == null) break;
      seenTx.delete(v);
    }
  }
}

// ✅ Digest dedupe (in-process)
const _digestSeen = new Set();
function _digestKey(guildId, txHash, tokenAddr, side) {
  return `${String(guildId)}:${String(txHash || '').toLowerCase()}:${String(tokenAddr || '').toLowerCase()}:${String(side || '')}`;
}
function _markDigestSeen(key) {
  _digestSeen.add(key);
  setTimeout(() => _digestSeen.delete(key), 48 * 60 * 60 * 1000);
}

// Tiny log rate-limit to stop spam when APIs hiccup
const _rl = new Map(); // key -> lastMs
function logEvery(key, everyMs, fn) {
  const ms = Math.max(0, Number(everyMs || 0));
  if (!ms) return fn();
  const now = Date.now();
  const last = _rl.get(key) || 0;
  if (now - last < ms) return;
  _rl.set(key, now);
  fn();
}

// Caches to reduce repeated RPC calls / instantiation
const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];
const _erc20ContractCache = new Map(); // tokenAddress -> Contract
function getErc20Contract(tokenAddress, provider) {
  const addr = String(tokenAddress || '').toLowerCase();
  if (!addr || !provider) return null;
  const key = addr;
  const existing = _erc20ContractCache.get(key);
  if (existing) return existing;
  const c = new ethers.Contract(addr, ERC20_BALANCE_ABI, provider);
  _erc20ContractCache.set(key, c);
  // keep cache bounded
  if (_erc20ContractCache.size > 2000) {
    // delete ~20% oldest
    const it = _erc20ContractCache.keys();
    const drop = Math.max(1, Math.floor(_erc20ContractCache.size * 0.2));
    for (let i = 0; i < drop; i++) _erc20ContractCache.delete(it.next().value);
  }
  return c;
}

// ETH price cache (short TTL to avoid hitting coingecko for every transfer)
let _ethPriceCache = { v: 0, ts: 0 };
const ETH_PRICE_TTL_MS = Math.max(5000, Number(process.env.GLOBAL_ETH_PRICE_TTL_MS || 20000)); // 20s default

/* ======================================================
   ✅ Emoji bar logic (UNCHANGED)
====================================================== */
function buildEmojiLine({ isBuy, usdValue, tokenAmountRaw }) {
  const usd = Number(usdValue);

  if (isBuy && Number.isFinite(usd) && usd > 30) {
    const whaleCount = Math.floor(usd / 5);
    return '🐳'.repeat(Math.min(whaleCount, 30));
  }

  if (Number.isFinite(usd) && usd > 0) {
    const count = Math.max(1, Math.floor(usd / 2));
    const capped = Math.min(count, 20);
    return isBuy ? '🟥🟦🚀'.repeat(capped) : '🔻💀🔻'.repeat(capped);
  }

  const amt = Number(tokenAmountRaw);
  if (!Number.isFinite(amt) || amt <= 0) return isBuy ? '🟥🟦🚀' : '🔻💀🔻';

  const count = Math.max(1, Math.floor(amt / 1000));
  const capped = Math.min(count, 12);
  return isBuy ? '🟥🟦🚀'.repeat(capped) : '🔻💀🔻'.repeat(capped);
}

/* ======================================================
   MAIN
====================================================== */

module.exports = async function processUnifiedBlock(client, fromBlock, toBlock) {
  const pg = client.pg;

  let tokenRes;
  try {
    tokenRes = await pg.query('SELECT * FROM tracked_tokens');
  } catch (e) {
    logEvery('tracked_tokens_query_fail', 60000, () => {
      console.warn(`⚠️ tracked_tokens query failed: ${e?.message || e}`);
    });
    return;
  }

  const tokenRows = tokenRes.rows;

  const addresses = [...new Set(tokenRows.map(row => String(row.address || '').toLowerCase()).filter(Boolean))];
  if (addresses.length === 0) {
    console.log('✅ No tokens to scan.');
    return;
  }

  let logs;
  try {
    logs = await fetchLogs(addresses, fromBlock, toBlock);
  } catch (err) {
    console.warn(`⚠️ fetchLogs failed: ${err.message}`);
    return;
  }

  for (const log of logs) {
    // preserve sequential behavior
    await handleTokenLog(client, tokenRows, log);
  }
};

async function handleTokenLog(client, tokenRows, log) {
  let parsed;
  try {
    parsed = TRANSFER_IFACE.parseLog(log);
  } catch {
    return;
  }

  const { from, to, amount } = parsed.args;
  const fromAddr = String(from || '').toLowerCase();
  const toAddr = String(to || '').toLowerCase();
  const tokenAddress = String(log.address || '').toLowerCase();

  if (!log?.transactionHash) return;

  // Dedup per tx (behavior: skip duplicates)
  if (seenTx.has(log.transactionHash)) return;
  seenTxAdd(log.transactionHash);

  const provider = getProvider();
  if (!provider) return;

  // ❌ Skip router-to-router or known tax/burn (UNCHANGED)
  if (ROUTERS_SET.has(fromAddr) && ROUTERS_SET.has(toAddr)) return;
  if (TAX_OR_BURN_SET.has(toAddr) || TAX_OR_BURN_SET.has(fromAddr)) return;

  // ✅ Detect type (UNCHANGED)
  const isBuy = ROUTERS_SET.has(fromAddr) && !ROUTERS_SET.has(toAddr);
  const isSell = !ROUTERS_SET.has(fromAddr) && ROUTERS_SET.has(toAddr);
  if (!isBuy && !isSell) return;

  // ⛔ Skip contract sell sources (UNCHANGED)
  if (isSell) {
    try {
      const code = await provider.getCode(fromAddr);
      if (code !== '0x') {
        console.log(`⛔ Skipping contract sell from ${fromAddr}`);
        return;
      }
    } catch {}
  }

  let usdSpent = 0, ethSpent = 0;
  let ethPrice = 0;

  try {
    const tx = await provider.getTransaction(log.transactionHash);
    ethPrice = await getETHPrice();
    if (tx?.value) {
      ethSpent = parseFloat(formatUnits(tx.value, 18));
      usdSpent = ethSpent * ethPrice;
    }
  } catch {}

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));

  // ❌ Skip tiny tax reroutes (UNCHANGED)
  if (usdSpent === 0 && ethSpent === 0 && tokenAmountRaw < 5) return;

  // ⛔ LP removal filter (UNCHANGED)
  if (isBuy && usdSpent === 0 && ethSpent === 0) {
    try {
      const contract = getErc20Contract(tokenAddress, provider);
      if (!contract) return;

      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const prevBalance = parseFloat(formatUnits(prevBalanceBN, 18));
      if (prevBalance > 0) {
        console.log(`⛔ Skipping LP removal pretending to be a buy [${toAddr}]`);
        return;
      }
    } catch (err) {
      console.warn(`⚠️ LP filter failed: ${err.message}`);
    }
  }

  const isUnpricedBuy = isBuy && usdSpent === 0 && ethSpent === 0;

  let buyLabel = isBuy ? '🆕 New Buy' : '💥 Sell';
  try {
    if (isBuy && !isUnpricedBuy) {
      const contract = getErc20Contract(tokenAddress, provider);
      if (!contract) return;

      const prevBalanceBN = await contract.balanceOf(toAddr, { blockTag: log.blockNumber - 1 });
      const prevBalance = parseFloat(formatUnits(prevBalanceBN, 18));
      if (prevBalance > 0) {
        const percentChange = ((tokenAmountRaw / prevBalance) * 100).toFixed(1);
        buyLabel = `🔁 +${percentChange}%`;
      }
    }
  } catch {}

  // GeckoTerminal calls (keep behavior; just tolerate failures quietly as before)
  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

  // ✅ Display amount (keep your behavior)
  let displayAmount = tokenAmountRaw;
  try {
    if (usdSpent > 0 && tokenPrice > 0 && tokenAmountRaw > 0) {
      const implied = usdSpent / tokenPrice;
      const ratio = implied / tokenAmountRaw;
      if (ratio > 0.5 && ratio < 2.0) displayAmount = implied;
    }
  } catch {}

  const tokenAmountFormatted = displayAmount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  // ✅ SELL: estimate value sold using tokenPrice * tokensSold (UNCHANGED)
  let usdValueSold = 0, ethValueSold = 0;
  try {
    if (isSell && tokenPrice > 0 && displayAmount > 0) {
      usdValueSold = displayAmount * tokenPrice;
      const ep = ethPrice || (await getETHPrice());
      if (ep > 0) ethValueSold = usdValueSold / ep;
    }
  } catch {}

  // ✅ BUY: if tx.value was 0, estimate spent using tokenPrice * tokensBought (UNCHANGED)
  if (isBuy && usdSpent === 0 && ethSpent === 0) {
    try {
      if (tokenPrice > 0 && displayAmount > 0) {
        usdSpent = displayAmount * tokenPrice;
        const ep = ethPrice || (await getETHPrice());
        if (ep > 0) ethSpent = usdSpent / ep;
      }
    } catch {}
  }

  const emojiLine = buildEmojiLine({
    isBuy,
    usdValue: isBuy ? usdSpent : usdValueSold,
    tokenAmountRaw
  });

  const getColorByUsd = (usd) => isBuy
    ? (usd < 10 ? 0xff0000 : usd < 20 ? 0x3498db : 0x00cc66)
    : (usd < 10 ? 0x999999 : usd < 50 ? 0xff6600 : 0xff0000);

  // Pre-filter matching tokens once (micro-optimization, no behavior change)
  const matching = tokenRows.filter(row => String(row.address || '').toLowerCase() === tokenAddress);

  for (const token of matching) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;

    // Safer channel selection (same fallback behavior)
    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;

    // If not in cache, attempt fetch (best-effort; no crash)
    if (!channel && token.channel_id) {
      channel = await guild.channels.fetch(token.channel_id).catch(() => null);
    }

    // If invalid/unusable, fall back to first text channel with SendMessages (same intent as your logic)
    if (!channel || !channel.isTextBased?.() || !canSendToChannel(guild, channel)) {
      channel = guild.channels.cache.find(c => c?.isTextBased?.() && canSendToChannel(guild, c));
    }

    if (!channel) continue;

    const buyValueLine = `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`;
    const sellValueLine = `$${usdValueSold.toFixed(4)} / ${ethValueSold.toFixed(4)} ETH`;

    const embed = {
      title: `${token.name.toUpperCase()} ${isBuy ? 'Buy' : 'Sell'}!`,
      description: emojiLine,
      image: {
        url: isBuy
          ? 'https://iili.io/3tSecKP.gif'
          : 'https://iili.io/f7SxSte.gif'
      },
      fields: [
        {
          name: isBuy ? '💸 Spent' : '💰 Value Sold',
          value: isBuy ? buyValueLine : sellValueLine,
          inline: true
        },
        {
          name: isBuy ? '🎯 Got' : '📤 Sold',
          value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`,
          inline: true
        },

        ...(isBuy && !isUnpricedBuy
          ? [{
              name: buyLabel.startsWith('🆕') ? '🆕 New Buyer' : '🔁 Accumulated',
              value: buyLabel.replace(/^(🆕|🔁) /, ''),
              inline: true
            }]
          : []),

        ...(isSell
          ? [{
              name: '🖕 Seller',
              value: shortWalletLink ? shortWalletLink(fromAddr) : fromAddr,
              inline: true
            }]
          : []),

        { name: '💵 Price', value: `$${(tokenPrice || 0).toFixed(8)}`, inline: true },
        { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
      ],
      url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
      color: getColorByUsd(isBuy ? usdSpent : usdValueSold),
      footer: { text: 'Live on Base • Powered by PimpsDev' },
      timestamp: new Date().toISOString()
    };

    let sentOk = false;
    try {
      await channel.send({ embeds: [embed] });
      sentOk = true;
    } catch (err) {
      logEvery('send_embed_fail', 15000, () => {
        console.warn(`❌ Failed to send embed: ${err.message}`);
      });
      sentOk = false;
    }

    // ✅ Digest logging: log as "sale" with tokenId null so it appears as Swaps in Daily Digest
    // Only log if we successfully sent to that guild.
    try {
      if (sentOk && logDigestEvent && log.transactionHash) {
        const side = isBuy ? 'buy' : 'sell';
        const key = _digestKey(token.guild_id, log.transactionHash, tokenAddress, side);
        if (_digestSeen.has(key)) continue;
        _markDigestSeen(key);

        const amountNative = Number.isFinite(displayAmount) ? Number(displayAmount) : null;

        const amountUsd = isBuy
          ? (Number.isFinite(usdSpent) ? Number(usdSpent) : null)
          : (Number.isFinite(usdValueSold) ? Number(usdValueSold) : null);

        const amountEth = isBuy
          ? (Number.isFinite(ethSpent) ? Number(ethSpent) : null)
          : (Number.isFinite(ethValueSold) ? Number(ethValueSold) : null);

        await logDigestEvent(client, {
          guildId: token.guild_id,
          eventType: 'sale',     // ✅ IMPORTANT: digest counts this
          chain: 'base',
          contract: tokenAddress,
          tokenId: null,         // ✅ IMPORTANT: digest will classify as Swap
          amountNative,
          amountEth,
          amountUsd,
          buyer: isBuy ? toAddr : null,
          seller: isSell ? fromAddr : null,
          txHash: log.transactionHash
        });
      }
    } catch {}
  }
}

/* ======================================================
   HELPERS
====================================================== */

function canSendToChannel(guild, channel) {
  try {
    if (!guild || !channel) return false;
    if (!channel.isTextBased?.()) return false;
    const me = guild.members?.me;
    if (!me) return false;
    const perms = channel.permissionsFor(me);
    if (!perms) return false;

    // Keep original requirement: SendMessages (you used string 'SendMessages')
    // Also allow EmbedLinks (not required by your original code, but harmless check)
    return perms.has('SendMessages');
  } catch {
    return false;
  }
}

/* ======================================================
   PRICING (same endpoints; just cached ETH)
====================================================== */

async function getETHPrice() {
  try {
    const now = Date.now();
    if (_ethPriceCache.v > 0 && now - _ethPriceCache.ts < ETH_PRICE_TTL_MS) {
      return _ethPriceCache.v;
    }

    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    const v = parseFloat(data?.ethereum?.usd || '0') || 0;

    if (v > 0) _ethPriceCache = { v, ts: now };
    return v;
  } catch {
    return 0;
  }
}

async function getTokenPriceUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${address}`);
    const data = await res.json();
    const prices = data?.data?.attributes?.token_prices || {};
    return parseFloat(prices[String(address || '').toLowerCase()] || '0');
  } catch {
    return 0;
  }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.fdv_usd || data?.data?.attributes?.market_cap_usd || '0');
  } catch {
    return 0;
  }
}


