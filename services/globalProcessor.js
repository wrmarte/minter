// services/globalProcessor.js
// ======================================================
// Global Processor (Token Buy/Sell scanner) — ENHANCED (FIXED, NO LOGIC CHANGES)
// - ✅ Preserves existing detection/filter logic + embed payload behavior
// - ✅ Fix: channel permission check regression that could block ALL sends
// - ✅ Safety/perf retained: bounded seenTx, cached iface/sets, fetch timeouts, price caches
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

const ROUTERS_LOWER = ROUTERS.map(r => String(r || '').toLowerCase());
const ROUTERS_SET = new Set(ROUTERS_LOWER);

const TAX_OR_BURN = [
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0xdead000000000000000042069420694206942069'
].map(a => a.toLowerCase());
const TAX_OR_BURN_SET = new Set(TAX_OR_BURN);

const TRANSFER_IFACE = new Interface([
  'event Transfer(address indexed from, address indexed to, uint amount)'
]);

/* ======================================================
   DEDUPE / RATE LIMIT
====================================================== */

// seenTx (bounded)
const seenTx = new Set();
const SEEN_TX_MAX = Math.max(1000, Number(process.env.GLOBAL_SEEN_TX_MAX || 8000));
function seenTxAdd(tx) {
  if (!tx) return;
  if (seenTx.has(tx)) return;
  seenTx.add(tx);
  if (seenTx.size > SEEN_TX_MAX) {
    const it = seenTx.values();
    const drop = Math.max(1, Math.floor(SEEN_TX_MAX * 0.2));
    for (let i = 0; i < drop; i++) {
      const v = it.next().value;
      if (v == null) break;
      seenTx.delete(v);
    }
  }
}

// Digest dedupe (in-process)
const _digestSeen = new Set();
function _digestKey(guildId, txHash, tokenAddr, side) {
  return `${String(guildId)}:${String(txHash || '').toLowerCase()}:${String(tokenAddr || '').toLowerCase()}:${String(side || '')}`;
}
function _markDigestSeen(key) {
  _digestSeen.add(key);
  setTimeout(() => _digestSeen.delete(key), 48 * 60 * 60 * 1000);
}

// Log rate-limit
const _rl = new Map();
function logEvery(key, everyMs, fn) {
  const ms = Math.max(0, Number(everyMs || 0));
  if (!ms) return fn();
  const now = Date.now();
  const last = _rl.get(key) || 0;
  if (now - last < ms) return;
  _rl.set(key, now);
  fn();
}

/* ======================================================
   CONTRACT CACHE
====================================================== */

const ERC20_BALANCE_ABI = ['function balanceOf(address account) view returns (uint256)'];
const _erc20ContractCache = new Map(); // tokenAddress -> Contract
function getErc20Contract(tokenAddress, provider) {
  const addr = String(tokenAddress || '').toLowerCase();
  if (!addr || !provider) return null;
  const existing = _erc20ContractCache.get(addr);
  if (existing) return existing;

  const c = new ethers.Contract(addr, ERC20_BALANCE_ABI, provider);
  _erc20ContractCache.set(addr, c);

  if (_erc20ContractCache.size > 2000) {
    const it = _erc20ContractCache.keys();
    const drop = Math.max(1, Math.floor(_erc20ContractCache.size * 0.2));
    for (let i = 0; i < drop; i++) _erc20ContractCache.delete(it.next().value);
  }
  return c;
}

/* ======================================================
   EMOJI BAR (UNCHANGED)
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

  const tokenRows = tokenRes.rows || [];
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
    try {
      await handleTokenLog(client, tokenRows, log);
    } catch (e) {
      logEvery('handleTokenLog_crash', 15000, () => {
        console.warn(`⚠️ handleTokenLog crashed: ${e?.message || e}`);
      });
    }
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

  if (seenTx.has(log.transactionHash)) return;
  seenTxAdd(log.transactionHash);

  const provider = getProvider();
  if (!provider) return;

  if (ROUTERS_SET.has(fromAddr) && ROUTERS_SET.has(toAddr)) return;
  if (TAX_OR_BURN_SET.has(toAddr) || TAX_OR_BURN_SET.has(fromAddr)) return;

  const isBuy = ROUTERS_SET.has(fromAddr) && !ROUTERS_SET.has(toAddr);
  const isSell = !ROUTERS_SET.has(fromAddr) && ROUTERS_SET.has(toAddr);
  if (!isBuy && !isSell) return;

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

  if (usdSpent === 0 && ethSpent === 0 && tokenAmountRaw < 5) return;

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

  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

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

  let usdValueSold = 0, ethValueSold = 0;
  try {
    if (isSell && tokenPrice > 0 && displayAmount > 0) {
      usdValueSold = displayAmount * tokenPrice;
      const ep = ethPrice || (await getETHPrice());
      if (ep > 0) ethValueSold = usdValueSold / ep;
    }
  } catch {}

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

  const matching = tokenRows.filter(row => String(row.address || '').toLowerCase() === tokenAddress);

  for (const token of matching) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;

    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel && token.channel_id) {
      channel = await guild.channels.fetch(token.channel_id).catch(() => null);
    }

    if (!channel || !channel.isTextBased?.() || !canSendToChannel(guild, channel)) {
      channel = guild.channels.cache.find(c => c?.isTextBased?.() && canSendToChannel(guild, c));
    }

    if (!channel) continue;

    const buyValueLine = `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`;
    const sellValueLine = `$${usdValueSold.toFixed(4)} / ${ethValueSold.toFixed(4)} ETH`;

    const embed = {
      title: `${token.name.toUpperCase()} ${isBuy ? 'Buy' : 'Sell'}!`,
      description: emojiLine,
      image: { url: isBuy ? 'https://iili.io/3tSecKP.gif' : 'https://iili.io/f7SxSte.gif' },
      fields: [
        { name: isBuy ? '💸 Spent' : '💰 Value Sold', value: isBuy ? buyValueLine : sellValueLine, inline: true },
        { name: isBuy ? '🎯 Got' : '📤 Sold', value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`, inline: true },

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
          eventType: 'sale',
          chain: 'base',
          contract: tokenAddress,
          tokenId: null,
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
   CHANNEL PERMS (FIXED)
====================================================== */

function canSendToChannel(guild, channel) {
  try {
    if (!guild || !channel) return false;
    if (!channel.isTextBased?.()) return false;

    // ✅ IMPORTANT:
    // If guild.members.me isn't cached, we do NOT block sending.
    // We let channel.send() succeed/fail like your original behavior effectively did.
    const me = guild.members?.me;
    if (!me) return true;

    const perms = channel.permissionsFor(me);
    if (!perms) return true;

    // Keep original intent: require SendMessages only.
    // In discord.js v14, string flag names are valid resolvables.
    return perms.has('SendMessages');
  } catch {
    // If perms calc fails, don't block notifications.
    return true;
  }
}

/* ======================================================
   FETCH HELPERS + PRICING (CACHED / TIMEOUTS)
====================================================== */

function _abortableFetch(url, ms = 8000) {
  const timeout = Math.max(1000, Number(ms || 0));
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function _fetchJson(url, timeoutMs = 8000) {
  try {
    const res = await _abortableFetch(url, timeoutMs);
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e };
  }
}

// ETH price cache
let _ethPriceCache = { v: 0, ts: 0 };
const ETH_PRICE_TTL_MS = Math.max(5000, Number(process.env.GLOBAL_ETH_PRICE_TTL_MS || 20000));

async function getETHPrice() {
  try {
    const now = Date.now();
    if (_ethPriceCache.v > 0 && now - _ethPriceCache.ts < ETH_PRICE_TTL_MS) {
      return _ethPriceCache.v;
    }

    const { ok, data } = await _fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd',
      Math.max(2000, Number(process.env.GLOBAL_ETH_PRICE_TIMEOUT_MS || 8000))
    );

    const v = parseFloat(data?.ethereum?.usd || '0') || 0;
    if (ok && v > 0) _ethPriceCache = { v, ts: now };
    return v;
  } catch {
    return 0;
  }
}

// Token USD + MCAP caches
const TOKEN_PRICE_TTL_MS = Math.max(10_000, Number(process.env.GLOBAL_TOKEN_PRICE_TTL_MS || 60_000));
const TOKEN_PRICE_TIMEOUT_MS = Math.max(2000, Number(process.env.GLOBAL_TOKEN_PRICE_TIMEOUT_MS || 8000));
const _tokenPriceCache = new Map(); // addr -> { v, ts }

const MCAP_TTL_MS = Math.max(10_000, Number(process.env.GLOBAL_MCAP_TTL_MS || 120_000));
const MCAP_TIMEOUT_MS = Math.max(2000, Number(process.env.GLOBAL_MCAP_TIMEOUT_MS || 8000));
const _mcapCache = new Map(); // addr -> { v, ts }

// Prefer /tokens first (price_usd), fallback to /simple token_price
async function getTokenPriceUSD(address) {
  try {
    const addr = String(address || '').toLowerCase();
    if (!addr) return 0;

    const now = Date.now();
    const cached = _tokenPriceCache.get(addr);
    if (cached && (now - cached.ts) < TOKEN_PRICE_TTL_MS) return cached.v;

    {
      const { ok, data } = await _fetchJson(
        `https://api.geckoterminal.com/api/v2/networks/base/tokens/${addr}`,
        TOKEN_PRICE_TIMEOUT_MS
      );
      const p = parseFloat(data?.data?.attributes?.price_usd || '0') || 0;
      if (ok && p > 0) {
        _tokenPriceCache.set(addr, { v: p, ts: now });
        if (_tokenPriceCache.size > 5000) {
          const it = _tokenPriceCache.keys();
          const drop = Math.max(1, Math.floor(_tokenPriceCache.size * 0.2));
          for (let i = 0; i < drop; i++) _tokenPriceCache.delete(it.next().value);
        }
        return p;
      }
    }

    {
      const { ok, data } = await _fetchJson(
        `https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${addr}`,
        TOKEN_PRICE_TIMEOUT_MS
      );
      const prices = data?.data?.attributes?.token_prices || {};
      const p = parseFloat(prices[addr] || '0') || 0;
      if (ok && p > 0) {
        _tokenPriceCache.set(addr, { v: p, ts: now });
        if (_tokenPriceCache.size > 5000) {
          const it = _tokenPriceCache.keys();
          const drop = Math.max(1, Math.floor(_tokenPriceCache.size * 0.2));
          for (let i = 0; i < drop; i++) _tokenPriceCache.delete(it.next().value);
        }
        return p;
      }
    }

    _tokenPriceCache.set(addr, { v: 0, ts: now });
    return 0;
  } catch {
    return 0;
  }
}

async function getMarketCapUSD(address) {
  try {
    const addr = String(address || '').toLowerCase();
    if (!addr) return 0;

    const now = Date.now();
    const cached = _mcapCache.get(addr);
    if (cached && (now - cached.ts) < MCAP_TTL_MS) return cached.v;

    const { ok, data } = await _fetchJson(
      `https://api.geckoterminal.com/api/v2/networks/base/tokens/${addr}`,
      MCAP_TIMEOUT_MS
    );

    const v = parseFloat(
      data?.data?.attributes?.fdv_usd ||
      data?.data?.attributes?.market_cap_usd ||
      '0'
    ) || 0;

    if (ok && v > 0) {
      _mcapCache.set(addr, { v, ts: now });
      if (_mcapCache.size > 5000) {
        const it = _mcapCache.keys();
        const drop = Math.max(1, Math.floor(_mcapCache.size * 0.2));
        for (let i = 0; i < drop; i++) _mcapCache.delete(it.next().value);
      }
      return v;
    }

    _mcapCache.set(addr, { v: 0, ts: now });
    return 0;
  } catch {
    return 0;
  }
}

