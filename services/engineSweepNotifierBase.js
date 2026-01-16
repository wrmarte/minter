// services/thirdPartySwapNotifierBase.js
const { Interface, Contract, ethers, PermissionsBitField } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall, rotateProvider } = require('./providerM');
const { shortWalletLink } = require('../utils/helpers');

// ✅ Daily Digest logger (safe optional import)
let logDigestEvent = null;
try {
  ({ logDigestEvent } = require('./digestLogger'));
} catch {
  logDigestEvent = null;
}

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

// Poll cadence
const POLL_MS           = Number(process.env.SWAP_POLL_MS || 12000);

// How far back to scan each tick (upper bound)
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 20);

// How many blocks per getLogs call (to avoid "range invalid" + rate limits)
const LOGS_SPAN         = Math.max(1, Number(process.env.SWAP_LOGS_SPAN || 6));

// Hard cap for safety
const MAX_LOOKBACK_CAP  = Math.max(5, Number(process.env.SWAP_LOOKBACK_CAP || 80));

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
  const key = tokenAddr.toLowerCase();
  if (totalSupplyCache.has(key)) return totalSupplyCache.get(key);
  try {
    const erc20 = new Contract(
      tokenAddr,
      ['function totalSupply() view returns (uint256)'],
      provider
    );
    const raw = await erc20.totalSupply();
    const dec = await getDecimals(provider, tokenAddr);
    const supply = Number(ethers.formatUnits(raw, dec));
    if (Number.isFinite(supply) && supply > 0) {
      totalSupplyCache.set(key, supply);
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

// ======= TOKEN PRICE + MCAP (PATCH) =======
let _tokenMarketCache = { ts: 0, data: null };

async function getAdrianMarketDataCached(maxAgeMs = 30_000) {
  const now = Date.now();
  if (_tokenMarketCache.data && (now - _tokenMarketCache.ts) < maxAgeMs) return _tokenMarketCache.data;

  const out = {
    priceUsd: 0,
    marketCapUsd: 0,
    fdvUsd: 0,
    liquidityUsd: 0,
    source: ''
  };

  // 1) GeckoTerminal (Base)
  try {
    const url = `https://api.geckoterminal.com/api/v2/networks/base/tokens/${ADRIAN}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
    const js = res ? await res.json().catch(() => null) : null;
    const attrs = js?.data?.attributes || null;

    const priceUsd = Number(attrs?.price_usd || 0);
    const mcap = Number(attrs?.market_cap_usd || 0);
    const fdv  = Number(attrs?.fdv_usd || 0);
    const liq  = Number(attrs?.total_reserve_in_usd || 0);

    if (priceUsd > 0) {
      out.priceUsd = priceUsd;
      out.marketCapUsd = mcap > 0 ? mcap : 0;
      out.fdvUsd = fdv > 0 ? fdv : 0;
      out.liquidityUsd = liq > 0 ? liq : 0;
      out.source = 'geckoterminal';
      _tokenMarketCache = { ts: now, data: out };
      return out;
    }
  } catch {}

  // 2) DexScreener fallback
  try {
    const url = `https://api.dexscreener.com/latest/dex/tokens/${ADRIAN}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } }).catch(() => null);
    const js = res ? await res.json().catch(() => null) : null;
    const pair = (js?.pairs || [])[0] || null;

    const priceUsd = Number(pair?.priceUsd || 0);
    const mcap = Number(pair?.marketCap || 0);
    const fdv = Number(pair?.fdv || 0);
    const liq = Number(pair?.liquidity?.usd || 0);

    if (priceUsd > 0) {
      out.priceUsd = priceUsd;
      out.marketCapUsd = mcap > 0 ? mcap : 0;
      out.fdvUsd = fdv > 0 ? fdv : 0;
      out.liquidityUsd = liq > 0 ? liq : 0;
      out.source = 'dexscreener';
      _tokenMarketCache = { ts: now, data: out };
      return out;
    }
  } catch {}

  _tokenMarketCache = { ts: now, data: out };
  return out;
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
      if (DEBUG) console.log(`[SWAP] DB channels=${out.length}`);
    }
  } catch (e) {
    if (DEBUG) console.log(`[SWAP] DB channel lookup failed: ${e?.message || e}`);
  }

  if (!out.length && SWAP_NOTI_CHANNELS.length) {
    for (const id of SWAP_NOTI_CHANNELS) {
      if (!id || added.has(id)) continue;
      const ch = await fetchAndValidateChannel(client, id);
      if (ch) {
        out.push(ch);
        added.add(id);
      }
    }
    if (DEBUG) console.log(`[SWAP] ENV channels=${out.length}`);
  }

  return out;
}

function hasSendPerms(ch) {
  try {
    const me = ch.guild?.members?.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (!perms) return false;

    if (perms.has?.('SendMessages')) return true;
    if (perms.has?.(PermissionsBitField?.Flags?.SendMessages)) return true;

    return false;
  } catch {
    return false;
  }
}

async function fetchAndValidateChannel(client, id) {
  let ch = client.channels.cache.get(id) || null;
  if (!ch) ch = await client.channels.fetch(id).catch(() => null);
  if (!ch) return null;

  const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
  if (!isText) return null;

  if (!hasSendPerms(ch)) return null;

  try {
    const me = ch.guild?.members?.me;
    const perms = me ? ch.permissionsFor(me) : null;
    if (ch.isThread?.() && perms) {
      if (perms.has?.('SendMessagesInThreads')) return ch;
      if (perms.has?.(PermissionsBitField?.Flags?.SendMessagesInThreads)) return ch;
      return null;
    }
  } catch {}

  return ch;
}

// ======= ANALYZE SWAP (PATCHED FOR SELL) =======
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  let adrianIn = 0n, adrianOut = 0n, wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC) continue;
    const token = (lg.address || '').toLowerCase();
    if (token !== ADRIAN && token !== WETH) continue;

    let p;
    try { p = ERC20_IFACE.parseLog(lg); } catch { continue; }

    if (addrEq(p.args.to, wallet)) {
      if (token === ADRIAN) adrianIn += p.args.value;
      else wethIn += p.args.value;
    }
    if (addrEq(p.args.from, wallet)) {
      if (token === ADRIAN) adrianOut += p.args.value;
      else wethOut += p.args.value;
    }
  }

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec   = await getDecimals(provider, WETH);

  const netAdrianNum = Number(ethers.formatUnits(adrianIn - adrianOut, adrianDec));
  if (!Number.isFinite(netAdrianNum) || netAdrianNum === 0) return null;

  const isBuy = netAdrianNum > 0;
  const tokenAmount = Math.abs(netAdrianNum);

  const netWeth = (wethIn - wethOut);
  let ethValue = 0;

  if (netWeth !== 0n) {
    ethValue = Math.abs(Number(ethers.formatUnits(netWeth, wethDec)));
  } else {
    const v = Number(ethers.formatUnits(tx.value || 0n, wethDec));
    ethValue = (isBuy && v > 0) ? v : 0;
  }

  const ethUsd = await getEthUsdPriceCached();
  const usdValue = (ethUsd > 0 && ethValue > 0) ? (ethValue * ethUsd) : 0;

  if (DEBUG) {
    console.log(
      `[SWAP][ANALYZE] tx=${txHash.toLowerCase()} ` +
      `isBuy=${isBuy} netAdrian=${netAdrianNum.toFixed(4)} ` +
      `wethIn=${ethers.formatUnits(wethIn, wethDec)} wethOut=${ethers.formatUnits(wethOut, wethDec)} ` +
      `ethValue=${ethValue.toFixed(6)} usd=${usdValue.toFixed(2)}`
    );
  }

  return {
    wallet,
    txHash: txHash.toLowerCase(),
    isBuy,
    tokenAmount,
    ethValue,
    usdValue
  };
}

// ======= SEND EMBED (PRICE shows USD only) =======
async function sendSwapEmbed(client, swap, provider) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  if (MIN_USD_TO_POST > 0 && usdValue > 0 && usdValue < MIN_USD_TO_POST) {
    if (DEBUG) console.log(`[SWAP] skip < MIN_USD ${usdValue.toFixed(2)} tx=${txHash}`);
    return;
  }

  const emojiLine = buildEmojiLine(isBuy, usdValue);

  const impliedPriceUsd = (usdValue > 0 && tokenAmount > 0) ? (usdValue / tokenAmount) : 0;

  const md = await getAdrianMarketDataCached().catch(() => null);
  const priceUsd = (md && md.priceUsd > 0) ? md.priceUsd : impliedPriceUsd;

  let marketCapUsd = (md && md.marketCapUsd > 0) ? md.marketCapUsd : 0;
  let marketCapLabelSuffix = '';

  if (!marketCapUsd && md && md.fdvUsd > 0) {
    marketCapUsd = md.fdvUsd;
    marketCapLabelSuffix = ' (FDV)';
  }

  if (!marketCapUsd && provider && priceUsd > 0) {
    const supply = await getTotalSupplyCached(provider, ADRIAN).catch(() => 0);
    if (supply > 0) marketCapUsd = supply * priceUsd;
  }

  const marketCapText = marketCapUsd > 0 ? `${formatCompactUsd(marketCapUsd)}${marketCapLabelSuffix}` : 'N/A';
  const priceText = (priceUsd > 0) ? `$${priceUsd.toFixed(6)}` : `N/A`;

  const spentReceivedUsd = (usdValue > 0) ? `$${usdValue.toFixed(2)}` : 'N/A';
  const spentReceivedEth = (ethValue > 0) ? `${ethValue.toFixed(4)} ETH` : 'N/A';

  const embed = {
    title: isBuy ? '🅰️DRIAN SWAP BUY!' : '🅰️DRIAN SWAP SELL!',
    description: `${emojiLine}`,
    image: { url: isBuy ? BUY_IMG : SELL_IMG },
    fields: [
      {
        name: isBuy ? '💸 Spent' : '💰 Received',
        value: `${spentReceivedUsd}\n${spentReceivedEth}`,
        inline: true
      },
      {
        name: isBuy ? '🎯 Got' : '📤 Sold',
        value: `${tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ADRIAN`,
        inline: true
      },
      {
        name: '🏷️ Price',
        value: priceText,
        inline: true
      },
      {
        name: '📊 Market Cap',
        value: marketCapText,
        inline: true
      },
      {
        name: isBuy ? '👤 Swapper' : '🖕 Seller',
        value: shortWalletLink ? shortWalletLink(wallet) : wallet,
        inline: false
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x2ecc71 : 0xe74c3c,
    footer: { text: 'AdrianSWAP • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const chans = await resolveChannels(client);
  if (DEBUG) console.log(`[SWAP] send -> channels=${chans.length} tx=${txHash}`);

  const sentGuilds = new Set();

  for (const ch of chans) {
    const tag = resolveRoleTag(ch, isBuy ? BUY_TAG_ROLE_NAME : SELL_TAG_ROLE_NAME);

    try {
      const payload = tag
        ? { content: tag.mention, embeds: [embed], allowedMentions: { roles: [tag.roleId] } }
        : { embeds: [embed], allowedMentions: { parse: [] } };

      await ch.send(payload);
      if (ch?.guildId) sentGuilds.add(String(ch.guildId));
    } catch (err) {
      if (DEBUG) console.log(`[SWAP] send failed channel=${ch?.id} err=${err?.message || err}`);
    }
  }

  if (logDigestEvent && sentGuilds.size) {
    for (const guildId of sentGuilds) {
      try {
        await logDigestEvent(client, {
          guildId,
          eventType: 'sale',
          chain: 'base',
          contract: ADRIAN,
          tokenId: null,
          amountNative: tokenAmount,
          amountEth: ethValue,
          amountUsd: usdValue,
          buyer: isBuy ? wallet : null,
          seller: isBuy ? null : wallet,
          txHash,
          ts: new Date()
        });

        if (DEBUG) {
          console.log(`[DIGEST_LOG][SWAP] logged guild=${guildId} isBuy=${isBuy} usd=${Number(usdValue || 0).toFixed(2)} tx=${txHash.slice(0, 10)}`);
        }
      } catch (e) {
        if (DEBUG) console.log(`[DIGEST_LOG][SWAP] failed guild=${guildId}: ${e?.message || e}`);
      }
    }
  }
}

// ======= SAFE getLogs (chunked) =======
async function getRouterLogsChunked(fromBlock, toBlock, router) {
  const out = [];
  let start = Number(fromBlock);
  const endMax = Number(toBlock);

  while (start <= endMax) {
    const end = Math.min(start + LOGS_SPAN - 1, endMax);

    const filter = { address: router, fromBlock: start, toBlock: end };

    const logs = await safeRpcCall(
      'base',
      (p) => p.getLogs(filter),
      3,
      12000
    );

    if (Array.isArray(logs) && logs.length) out.push(...logs);

    start = end + 1;
  }

  return out;
}

// ======= LOOP (NON-OVERLAPPING) =======
let _tickRunning = false;

async function tick(client) {
  if (_tickRunning) return;
  _tickRunning = true;

  try {
    const provider = await safeRpcCall('base', (p) => p, 2, 6000);
    if (!provider) {
      if (DEBUG) console.log('[SWAP] safeRpcCall(base) returned no provider');
      return;
    }

    await ensureCheckpointTable(client);

    if (TEST_TX && !isSeen(TEST_TX)) {
      markSeen(TEST_TX);
      const swap = await analyzeSwap(provider, TEST_TX).catch(() => null);
      if (swap) await sendSwapEmbed(client, swap, provider);
    }

    const blockNumber = await safeRpcCall('base', (p) => p.getBlockNumber(), 2, 8000);
    if (!blockNumber || !Number.isFinite(Number(blockNumber))) return;

    let last = await getLastBlockFromDb(client);

    // ✅ FIX: if DB last is ahead of chain tip, clamp it
    const tip = Number(blockNumber);
    if (!Number.isFinite(last)) last = null;
    if (last != null && last > tip) last = tip;

    // Determine scan window safely
    const lookback = Math.min(Math.max(1, LOOKBACK_BLOCKS), MAX_LOOKBACK_CAP);

    // Always scan at least 1 block, and never invert ranges
    let fromBlock = (last != null) ? Math.max(last, tip - lookback) : Math.max(tip - 2, 0);
    let toBlock = tip;

    if (fromBlock > toBlock) {
      // absolute safety net
      fromBlock = Math.max(toBlock - 1, 0);
    }

    if (DEBUG) console.log(`[SWAP] scan ${fromBlock} -> ${toBlock} (last=${last ?? 'null'})`);

    const txs = new Set();

    for (const router of ROUTERS_TO_WATCH) {
      let logs = [];
      try {
        logs = await getRouterLogsChunked(fromBlock, toBlock, router);
      } catch (e) {
        if (DEBUG) console.log(`[SWAP] router getLogs failed ${router}: ${e?.message || e}`);
        try { await rotateProvider('base'); } catch {}
        continue;
      }

      for (const lg of logs) {
        const h = (lg.transactionHash || '').toLowerCase();
        if (h) txs.add(h);
      }
    }

    for (const h of txs) {
      if (isSeen(h)) continue;
      markSeen(h);
      const swap = await analyzeSwap(provider, h).catch(() => null);
      if (swap) await sendSwapEmbed(client, swap, provider);
    }

    await setLastBlockInDb(client, toBlock);
  } finally {
    _tickRunning = false;
  }
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

