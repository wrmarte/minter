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
const LOOKBACK_BLOCKS   = Number(process.env.SWAP_LOOKBACK_BLOCKS || 20); // still used as safety fallback
const MAX_EMOJI_REPEAT  = Number(process.env.SWAP_MAX_EMOJIS || 20);

const BUY_IMG  = process.env.SWAP_BUY_IMG  || 'https://iili.io/f7ifqmB.gif';
const SELL_IMG = process.env.SWAP_SELL_IMG || 'https://iili.io/f7SxSte.gif';

const DEBUG = String(process.env.SWAP_DEBUG || '').trim() === '1';
const BOOT_PING = String(process.env.SWAP_BOOT_PING || '').trim() === '1';
const TEST_TX = (process.env.SWAP_TEST_TX || '').trim().toLowerCase();

// ======= TAG SYSTEM (PATCH) =======
// These should be ROLE NAMES in the server. Create roles named exactly "WAGMI" and "NGMI".
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

  // ✅ whale scaling
  if (isBuy && u >= 30) {
    const whales = Math.max(1, Math.floor(u / 2));
    return '🐳🚀'.repeat(Math.min(whales, MAX_EMOJI_REPEAT));
  }

  const count = Math.max(1, Math.floor(u / 2));
  return (isBuy ? '🟥🟦🚀' : '🔻💀🔻').repeat(Math.min(count, MAX_EMOJI_REPEAT));
}

// ======= TAG HELPERS (PATCH) =======
function resolveRoleTag(channel, roleName) {
  try {
    const guild = channel?.guild;
    if (!guild) return null;
    const role = guild.roles?.cache?.find(r => r?.name === roleName) || null;
    if (!role) return null;
    return { mention: `<@&${role.id}>`, roleId: role.id };
  } catch {
    return null;
  }
}

/**
 * ✅ DB-backed channel routing (same DB the mint system uses)
 * We route swaps to the channels where ADRIAN is tracked in `tracked_tokens`.
 * Falls back to SWAP_NOTI_CHANNELS env if DB returns nothing.
 */
async function resolveChannels(client) {
  const out = [];
  const added = new Set();

  // 1) Try DB routing via tracked_tokens
  try {
    const pg = client.pg;
    if (pg) {
      const res = await pg.query(
        `SELECT DISTINCT channel_id
         FROM tracked_tokens
         WHERE lower(address) = $1
           AND channel_id IS NOT NULL
           AND channel_id <> ''`,
        [ADRIAN]
      );
      const ids = (res.rows || [])
        .map(r => String(r.channel_id || '').trim())
        .filter(Boolean);

      for (const id of ids) {
        if (added.has(id)) continue;
        const ch = await fetchAndValidateChannel(client, id);
        if (ch) {
          out.push(ch);
          added.add(id);
        }
      }

      if (DEBUG) console.log(`[SWAP] DB channels=${out.length}`);
    }
  } catch (e) {
    console.log(`[SWAP] DB channel lookup failed: ${e?.message || e}`);
  }

  // 2) Fallback to env channels if DB returned none
  if (out.length === 0 && SWAP_NOTI_CHANNELS.length) {
    for (const id of SWAP_NOTI_CHANNELS) {
      if (!id || added.has(id)) continue;
      const ch = await fetchAndValidateChannel(client, id);
      if (ch) {
        out.push(ch);
        added.add(id);
      }
    }
    if (DEBUG) console.log(`[SWAP] ENV fallback channels=${out.length}`);
  }

  return out;
}

async function fetchAndValidateChannel(client, id) {
  let ch = client.channels.cache.get(id) || null;
  if (!ch) ch = await client.channels.fetch(id).catch(() => null);

  if (!ch) {
    if (DEBUG) console.log(`[SWAP] channel fetch failed: ${id}`);
    return null;
  }

  const isText = typeof ch.isTextBased === 'function' ? ch.isTextBased() : false;
  if (!isText) {
    if (DEBUG) console.log(`[SWAP] channel not text-based: ${id}`);
    return null;
  }

  try {
    const guild = ch.guild;
    const me = guild?.members?.me;
    if (guild && me) {
      const perms = ch.permissionsFor(me);
      if (!perms?.has('SendMessages')) {
        if (DEBUG) console.log(`[SWAP] missing SendMessages in ${id}`);
        return null;
      }
      if (ch.isThread?.() && !perms?.has('SendMessagesInThreads')) {
        if (DEBUG) console.log(`[SWAP] missing SendMessagesInThreads in ${id}`);
        return null;
      }
    }
  } catch {}

  return ch;
}

// Core: compute net ADRIAN + (ETH native or WETH) for tx.from wallet
async function analyzeSwap(provider, txHash) {
  const tx = await provider.getTransaction(txHash).catch(() => null);
  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!tx || !receipt) return null;

  const wallet = safeAddr(tx.from);
  if (!wallet) return null;

  const adrianDec = await getDecimals(provider, ADRIAN);
  const wethDec = await getDecimals(provider, WETH);

  let adrianIn = 0n, adrianOut = 0n;
  let wethIn = 0n, wethOut = 0n;

  for (const lg of receipt.logs) {
    if (lg.topics?.[0] !== TRANSFER_TOPIC || lg.topics.length !== 3) continue;

    const token = (lg.address || '').toLowerCase();
    if (token !== ADRIAN && token !== WETH) continue;

    let parsed;
    try { parsed = ERC20_IFACE.parseLog(lg); } catch { continue; }

    const from = safeAddr(parsed.args.from);
    const to = safeAddr(parsed.args.to);
    const val = parsed.args.value;

    if (token === ADRIAN) {
      if (addrEq(to, wallet)) adrianIn += val;
      if (addrEq(from, wallet)) adrianOut += val;
    } else {
      if (addrEq(to, wallet)) wethIn += val;
      if (addrEq(from, wallet)) wethOut += val;
    }
  }

  const adrianInF  = Number(ethers.formatUnits(adrianIn, adrianDec));
  const adrianOutF = Number(ethers.formatUnits(adrianOut, adrianDec));
  const wethInF    = Number(ethers.formatUnits(wethIn, wethDec));
  const wethOutF   = Number(ethers.formatUnits(wethOut, wethDec));

  const netAdrian = adrianInF - adrianOutF;

  let ethNativeSpent = 0;
  try {
    if (tx.value && tx.value > 0n) ethNativeSpent = Number(ethers.formatEther(tx.value));
  } catch {}

  // ✅ keep your original buy/sell detection
  const isBuy  = netAdrian > 0 && (ethNativeSpent > 0 || wethOutF > 0);
  const isSellOriginal = netAdrian < 0 && (wethInF > 0 || ethNativeSpent > 0);

  // ✅ PATCH: allow ADRIAN->ETH sells paid in *native ETH* (no WETH in, tx.value usually 0)
  // We do NOT change buy logic. We only extend sell detection when netAdrian < 0.
  let isSell = isSellOriginal;

  // compute tokenAmount early (needed for sell fallback)
  const tokenAmount = Math.abs(netAdrian);
  if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) return null;

  // Start with original ethValue logic
  let ethValue = isBuy
    ? (ethNativeSpent > 0 ? ethNativeSpent : wethOutF)
    : (wethInF > 0 ? wethInF : ethNativeSpent);

  // If neither buy nor original sell matched, you used to return null.
  // We keep that behavior UNLESS it is the native-ETH sell case.
  if (!isBuy && !isSellOriginal) {
    // Only attempt sell fallback if ADRIAN moved out
    if (!(netAdrian < 0)) return null;

    // ✅ Native ETH received fallback:
    // balance delta across block + gas reimbursement (+ tx.value)
    try {
      const bn = receipt.blockNumber;
      if (typeof bn === 'number' && bn > 0) {
        const [balBefore, balAfter] = await Promise.all([
          provider.getBalance(wallet, bn - 1).catch(() => 0n),
          provider.getBalance(wallet, bn).catch(() => 0n)
        ]);

        const gasUsed = receipt.gasUsed || 0n;
        const gasPrice = receipt.effectiveGasPrice || 0n;
        const gasCost = gasUsed * gasPrice;
        const txValue = tx.value || 0n;

        // received ≈ (after - before) + gas + tx.value
        const delta = (balAfter - balBefore);
        const receivedApprox = delta + gasCost + txValue;

        const receivedEth = Number(ethers.formatEther(receivedApprox > 0n ? receivedApprox : 0n));
        if (Number.isFinite(receivedEth) && receivedEth > 0) {
          ethValue = receivedEth;
          isSell = true;
        } else {
          return null;
        }
      } else {
        return null;
      }
    } catch (e) {
      if (DEBUG) console.log(`[SWAP] native-eth sell fallback failed tx=${txHash}: ${e?.message || e}`);
      return null;
    }
  }

  // ✅ If we matched original buy/sell, we keep your existing guardrails
  if (!isBuy && !isSell) return null;
  if (!Number.isFinite(ethValue) || ethValue <= 0) return null;

  const ethUsd = await getEthUsdPriceCached();
  const usdValue = ethUsd > 0 ? ethValue * ethUsd : 0;

  return { wallet, txHash: txHash.toLowerCase(), isBuy, isSell, ethValue, usdValue, tokenAmount };
}

async function sendSwapEmbed(client, swap) {
  const { wallet, isBuy, ethValue, usdValue, tokenAmount, txHash } = swap;

  if (MIN_USD_TO_POST > 0 && usdValue > 0 && usdValue < MIN_USD_TO_POST) {
    if (DEBUG) console.log(`[SWAP] skip < MIN_USD ${usdValue.toFixed(2)} tx=${txHash}`);
    return;
  }

  const emojiLine = buildEmojiLine(isBuy, usdValue);

  const embed = {
    title: isBuy ? `🅰️DRIAN SWAP BUY!` : `🅰️DRIAN SWAP SELL!`,
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
        value: shortWalletLink ? shortWalletLink(wallet) : wallet,
        inline: true
      }
    ],
    url: `https://basescan.org/tx/${txHash}`,
    color: isBuy ? 0x3498db : 0xff0000,
    footer: { text: 'AdrianSWAP • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const chans = await resolveChannels(client);
  if (DEBUG) console.log(`[SWAP] send -> channels=${chans.length} tx=${txHash}`);

  if (!chans.length) {
    console.log('[SWAP] No channels resolved (DB empty + env empty). Nothing to post.');
    return;
  }

  for (const ch of chans) {
    // ======= TAG PATCH (per-channel / per-guild) =======
    const tag = isBuy
      ? resolveRoleTag(ch, BUY_TAG_ROLE_NAME)
      : resolveRoleTag(ch, SELL_TAG_ROLE_NAME);

    const payload = tag
      ? { content: tag.mention, embeds: [embed], allowedMentions: { roles: [tag.roleId] } }
      : { embeds: [embed] };

    await ch.send(payload).catch(err => {
      console.log(`[SWAP] send failed channel=${ch.id} err=${err?.message || err}`);
    });
  }
}

async function bootPing(client) {
  const chans = await resolveChannels(client);
  if (DEBUG) console.log(`[SWAP] bootPing channels=${chans.length}`);

  if (!chans.length) {
    console.log('[SWAP] bootPing: No channels resolved (DB empty + env empty).');
    return;
  }

  for (const ch of chans) {
    await ch.send(`✅ Swap notifier online (Base).`).catch(err => {
      console.log(`[SWAP] bootPing failed channel=${ch.id} err=${err?.message || err}`);
    });
  }
}

async function tick(client) {
  const provider = await safeRpcCall('base', p => p);
  if (!provider) {
    if (DEBUG) console.log('[SWAP] safeRpcCall(base) returned no provider');
    return;
  }

  // ✅ Ensure checkpoint table exists (best-effort)
  await ensureCheckpointTable(client);

  // Force-test tx path
  if (TEST_TX && !isSeen(TEST_TX)) {
    markSeen(TEST_TX);
    if (DEBUG) console.log(`[SWAP] TEST_TX analyze ${TEST_TX}`);
    const swap = await analyzeSwap(provider, TEST_TX).catch(e => {
      console.log(`[SWAP] TEST_TX analyze error: ${e?.message || e}`);
      return null;
    });
    if (swap) {
      if (DEBUG) console.log(`[SWAP] TEST_TX matched ${swap.isBuy ? 'BUY' : 'SELL'} usd=${swap.usdValue?.toFixed?.(2)} eth=${swap.ethValue?.toFixed?.(4)}`);
      await sendSwapEmbed(client, swap);
    } else {
      console.log('[SWAP] TEST_TX did NOT match swap rules (or tx/receipt unavailable)');
    }
  }

  const blockNumber = await provider.getBlockNumber().catch(() => null);
  if (!blockNumber) return;

  // ✅ Checkpoint start:
  // - if checkpoint exists => start from it
  // - if not => start near head (prevents replay on first boot)
  let last = await getLastBlockFromDb(client);

  if (!last || last <= 0) {
    // first boot: no replay history
    last = Math.max(blockNumber - 2, 0);
  }

  // safety: if checkpoint lags too far (or chain reorg), clamp to lookback
  const minFrom = Math.max(blockNumber - LOOKBACK_BLOCKS, 0);
  const fromBlock = Math.max(Math.min(last, blockNumber), minFrom);

  const toBlock = blockNumber;

  if (DEBUG) console.log(`[SWAP] scan blocks ${fromBlock} -> ${toBlock}`);

  if (!ROUTERS_TO_WATCH.length) {
    console.log('[SWAP] ROUTERS_TO_WATCH is empty. Paste router addresses to watch.');
    return;
  }

  // Pull tx hashes by scanning router addresses
  const txs = new Set();

  for (const router of ROUTERS_TO_WATCH) {
    let logs = [];
    try {
      logs = await provider.getLogs({ address: router, fromBlock, toBlock });
    } catch (e) {
      console.log(`[SWAP] router getLogs failed ${router}: ${e?.message || e}`);
      continue;
    }
    if (DEBUG) console.log(`[SWAP] router ${router} logs=${logs.length}`);
    for (const lg of logs) {
      const h = (lg.transactionHash || '').toLowerCase();
      if (h) txs.add(h);
    }
  }

  let analyzed = 0, matched = 0;
  for (const h of txs) {
    if (isSeen(h)) continue;
    markSeen(h);

    analyzed++;
    const swap = await analyzeSwap(provider, h).catch(() => null);
    if (!swap) continue;

    matched++;
    if (DEBUG) console.log(`[SWAP] MATCH tx=${h} ${swap.isBuy ? 'BUY' : 'SELL'} usd=${swap.usdValue?.toFixed?.(2)} eth=${swap.ethValue?.toFixed?.(4)} adrian=${swap.tokenAmount?.toFixed?.(2)}`);
    await sendSwapEmbed(client, swap);
  }

  // ✅ advance checkpoint so restarts don't replay
  await setLastBlockInDb(client, toBlock);

  if (DEBUG) console.log(`[SWAP] analyzed=${analyzed} matched=${matched} checkpoint=${toBlock}`);
}

function startThirdPartySwapNotifierBase(client) {
  if (global._third_party_swap_base) return;
  global._third_party_swap_base = true;

  console.log(`✅ Swap notifier starting (Base) | envChannels=${SWAP_NOTI_CHANNELS.length} | lookback=${LOOKBACK_BLOCKS} | debug=${DEBUG ? 'ON' : 'OFF'} | bootPing=${BOOT_PING ? 'ON' : 'OFF'}`);

  if (BOOT_PING) bootPing(client).catch(() => {});
  tick(client).catch(() => {});

  setInterval(() => {
    tick(client).catch(() => {});
  }, POLL_MS);
}

module.exports = { startThirdPartySwapNotifierBase };


