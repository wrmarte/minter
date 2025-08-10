// mintProcessorApe.js — enhanced to mirror Base/ETH behavior without breaking your logic
const { Interface, Contract, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall, getProvider } = require('../services/providerM');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

/* ===================== Config ===================== */
const ROUTERS = [
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d', // Magic Eden Router (ApeChain)
];

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';

/* ===================== IPFS helpers ===================== */
const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/',
];

function toIpfsHttp(url = '') {
  if (!url || typeof url !== 'string') return [url].filter(Boolean);
  if (!url.startsWith('ipfs://')) return [url];
  const cid = url.replace('ipfs://', '');
  return IPFS_GATEWAYS.map((g) => g + cid);
}

async function fetchJsonWithFallback(urlOrList, timeoutMs = 6000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      // Some gateways mislabel; still attempt JSON parse
      const json = await res.json().catch(() => null);
      if (json) return json;
    } catch {
      // try next
    }
  }
  return null;
}

/* ===================== Utils ===================== */
function uniq(arr) {
  return [...new Set(arr)];
}

function normalizeChannels(channel_ids) {
  if (Array.isArray(channel_ids)) return channel_ids.filter(Boolean).map(String);
  if (!channel_ids) return [];
  return channel_ids.toString().split(',').map((s) => s.trim()).filter(Boolean);
}

/* ===================== Listener bootstrap ===================== */
const contractListeners = {};
let apeCooldown = false;

async function trackApeContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'ape'");
  const contracts = res.rows;
  setupApeBlockListener(client, contracts);
}

/* ===================== Block listener ===================== */
function setupApeBlockListener(client, contractRows) {
  if (global._ape_block_listener) return;
  global._ape_block_listener = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)',
  ]);

  const globalSeenSales = new Set(); // per-guild tx dedupe
  const globalSeenMints = new Set(); // per-guild mint dedupe (tx+token)
  global.apeOfflineNotified = false;

  setInterval(async () => {
    if (apeCooldown) return;

    const provider = getProvider('ape');
    if (!provider) {
      if (!global.apeOfflineNotified) {
        console.warn(`⛔ ApeChain is offline. Will retry silently.`);
        global.apeOfflineNotified = true;
      }
      apeCooldown = true;
      setTimeout(() => {
        apeCooldown = false;
      }, 90000); // cool down 90s to avoid thrash
      return;
    }
    if (global.apeOfflineNotified) {
      console.log(`✅ ApeChain is back online.`);
      global.apeOfflineNotified = false;
    }

    const block = await safeRpcCall('ape', (p) => p.getBlockNumber());
    if (!block) return;

    // Lookback slightly to avoid missing late logs
    const fromBlock = Math.max(block - 3, 0);
    const toBlock = block;

    // Group mints by tx per guild like Base/ETH
    const mintTxMap = new Map(); // txHash -> Map(guildId, { row, contract, tokenIds:Set, to })

    for (const row of contractRows) {
      const name = row.name || 'Collection';
      const address = (row.address || '').toLowerCase();

      const filter = {
        address,
        topics: [id('Transfer(address,address,uint256)')],
        fromBlock,
        toBlock,
      };

      await delay(150);

      let logs = await safeRpcCall('ape', (p) => p.getLogs(filter)).catch(() => []);
      if (!Array.isArray(logs)) logs = [];

      const contract = new Contract(address, iface.fragments, provider);
      const seenTokenIds = new Set(loadJson(seenPath(name)) || []);
      const seenSales = new Set((loadJson(seenSalesPath(name)) || []).map((tx) => (tx || '').toLowerCase()));

      // Get guilds per tracked channels once
      const allChannelIds = uniq(normalizeChannels(row.channel_ids));
      const allGuildIds = [];
      for (const id of allChannelIds) {
        try {
          const ch = await client.channels.fetch(id);
          if (ch?.guildId && !allGuildIds.includes(ch.guildId)) allGuildIds.push(ch.guildId);
        } catch {}
      }

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }

        const { from, to, tokenId } = parsed.args;
        const tokenIdStr = tokenId.toString();
        const txHash = (log.transactionHash || '').toLowerCase();
        if (!txHash) continue;

        const isMint = from === ZeroAddress;
        const isDeadTransfer = (from || '').toLowerCase() === DEAD_ADDRESS;

        if (isMint) {
          // Per-guild mint grouping and dedupe
          for (const gid of allGuildIds) {
            const mintDedupeKey = `${gid}-${address}-${tokenIdStr}`;
            if (globalSeenMints.has(mintDedupeKey)) continue; // already seen this token for this guild
            globalSeenMints.add(mintDedupeKey);

            if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, new Map());
            const perGuild = mintTxMap.get(txHash);
            if (!perGuild.has(gid)) perGuild.set(gid, { row, contract, tokenIds: new Set(), to });
            perGuild.get(gid).tokenIds.add(tokenIdStr);
          }

          if (!seenTokenIds.has(tokenIdStr)) {
            seenTokenIds.add(tokenIdStr);
          }
          // Do NOT send here — we’ll send after grouping
          continue;
        }

        // Non-mint (or dead transfer): treat as sale/transfer candidate
        // Pull tx + receipt; detect sale conditions similar to your original logic
        let tx, receipt, tokenPayment = null, isNativeSale = false;
        try {
          tx = await safeRpcCall('ape', (p) => p.getTransaction(txHash));
          receipt = await safeRpcCall('ape', (p) => p.getTransactionReceipt(txHash));
          if (!tx || !receipt) throw new Error('missing tx or receipt');

          const toAddr = (tx.to || '').toLowerCase();
          const isTransferToRouter = ROUTERS.includes((to || '').toLowerCase());
          isNativeSale = ROUTERS.includes(toAddr) || isTransferToRouter;

          // Scan receipt for ERC20 Transfer events that credit the seller/router side
          const transferIface = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);

          for (const lg of receipt.logs) {
            try {
              const parsedLog = transferIface.parseLog(lg);
              const toLog = (parsedLog.args?.to || '').toLowerCase();
              if (ROUTERS.includes(toLog) || toLog === (from || '').toLowerCase() || toLog === toAddr) {
                try {
                  const tokenContract = new Contract(lg.address, [
                    'function symbol() view returns (string)',
                    'function decimals() view returns (uint8)',
                  ], provider);
                  const [symbol, decimals] = await Promise.all([
                    tokenContract.symbol().catch(() => 'TOKEN'),
                    tokenContract.decimals().catch(() => 18),
                  ]);
                  const raw = parsedLog.args.value;
                  const amount = Number(ethers.formatUnits(raw, Number(decimals) || 18));
                  const displaySymbol = (lg.address || '').toLowerCase() === '0x3429c4973be6eb5f3c1223f53d7bda78d302d2f3' ? 'WAPE' : (symbol || 'TOKEN');
                  tokenPayment = `${amount.toFixed(4)} ${displaySymbol}`;
                } catch {
                  // fallback assumes 18
                  const raw = (transferIface.parseLog(lg).args.value);
                  const amount = Number(ethers.formatUnits(raw, 18));
                  const tokenAddr = (lg.address || '').toLowerCase();
                  const display = tokenAddr === '0x3429c4973be6eb5f3c1223f53d7bda78d302d2f3' ? 'WAPE' : 'TOKEN';
                  tokenPayment = `${amount.toFixed(4)} ${display}`;
                }
                break;
              }
            } catch {
              // not an ERC20 Transfer, ignore
            }
          }

          if (!isNativeSale && !tokenPayment && tx.value > 0n) {
            const paid = Number(ethers.formatUnits(tx.value, 18));
            if (paid > 0) tokenPayment = `${paid.toFixed(4)} APE`;
          }

          if (!isNativeSale && !tokenPayment) {
            // Not a sale pattern that we recognize — skip
            continue;
          }
        } catch (err) {
          console.warn(`[${name}] Tx fetch failed for ${txHash}: ${err.message}`);
          continue;
        }

        // Per-guild sale dedupe
        let shouldSend = false;
        for (const gid of allGuildIds) {
          const dedupeKey = `${gid}-${txHash}`;
          if (globalSeenSales.has(dedupeKey)) continue;
          globalSeenSales.add(dedupeKey);
          shouldSend = true;
        }

        if (!shouldSend || seenSales.has(txHash)) continue;

        seenSales.add(txHash);
        await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds, tokenPayment);
      }

      // Persist seen sets for this collection
      saveJson(seenPath(name), [...seenTokenIds]);
      saveJson(seenSalesPath(name), [...seenSales]);
    }

    // Emit grouped mints by (tx -> guild)
    for (const [txHash, perGuild] of mintTxMap.entries()) {
      for (const [guildId, { row, contract, tokenIds, to }] of perGuild.entries()) {
        const tokens = Array.from(tokenIds);
        const isSingle = tokens.length === 1;
        const channels = normalizeChannels(row.channel_ids).filter((id) => {
          const ch = client.channels.cache.get(id);
          return ch?.guildId === guildId;
        });
        await handleMintBulk(client, row, contract, tokens, txHash, channels, isSingle, to);
      }
    }
  }, 12000);
}

/* ===================== Mint handlers ===================== */

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false, minterAddress = '') {
  const { name, address } = contractRow;
  const magicEdenUrl = `https://magiceden.us/item-details/apechain/${address}/${tokenIds[0]}`;

  // Resolve tokenURI image for the first token only (thumbnail)
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenIds[0]);
    const urls = uri?.startsWith?.('ipfs://') ? toIpfsHttp(uri) : [uri];
    const meta = await fetchJsonWithFallback(urls, 6000);
    const img = meta?.image;
    if (img) {
      imageUrl = img.startsWith('ipfs://') ? (toIpfsHttp(img)[0] || imageUrl) : img;
    }
  } catch {}

  const embed = {
    title: isSingle ? `🦍 New ${String(name || '').toUpperCase()} Mint!` : `🦍 Bulk ${String(name || '').toUpperCase()} Mint (${tokenIds.length})`,
    description: isSingle
      ? `Minted by: ${minterAddress ? shortWalletLink(minterAddress) : 'Unknown'}\nToken #${tokenIds[0]}`
      : `Minted by: ${minterAddress ? shortWalletLink(minterAddress) : 'Unknown'}\nToken IDs: ${tokenIds.map((id) => `#${id}`).join(', ')}`,
    thumbnail: { url: imageUrl },
    color: 0x9966ff,
    footer: { text: 'Live on ApeChain • Powered by PimpsDev' },
    timestamp: new Date().toISOString(),
    url: magicEdenUrl,
  };

  // One embed per guild (avoid duplicates across multiple channels in same guild)
  const notifiedGuilds = new Set();
  for (const id of uniq(channel_ids)) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || notifiedGuilds.has(ch.guildId)) continue;
    notifiedGuilds.add(ch.guildId);
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ===================== Sale handler ===================== */
async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids, tokenPayment = null) {
  const { name, address } = contractRow;
  const magicEdenUrl = `https://magiceden.us/item-details/apechain/${address}/${tokenId}`;

  // Resolve image
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  try {
    let uri = await contract.tokenURI(tokenId);
    const urls = uri?.startsWith?.('ipfs://') ? toIpfsHttp(uri) : [uri];
    const meta = await fetchJsonWithFallback(urls, 6000);
    const img = meta?.image;
    if (img) {
      imageUrl = img.startsWith('ipfs://') ? (toIpfsHttp(img)[0] || imageUrl) : img;
    }
  } catch {}

  // Fallback price if tokenPayment is missing (native)
  let pricePaid = tokenPayment || 'N/A';
  if (!tokenPayment) {
    try {
      const tx = await safeRpcCall('ape', (p) => p.getTransaction(txHash));
      if (tx?.value && tx.value > 0n) {
        const paid = Number(ethers.formatUnits(tx.value, 18));
        if (paid > 0) pricePaid = `${paid.toFixed(4)} APE`;
      }
    } catch (err) {
      // ignore
    }
  }

  const embed = {
    title: `🦍 ${name || 'Collection'} #${tokenId} SOLD`,
    description: `Token \`#${tokenId}\` just sold!`,
    url: magicEdenUrl,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: pricePaid, inline: true },
      { name: `💳 Method`, value: 'ApeChain', inline: true },
    ],
    thumbnail: { url: imageUrl },
    color: 0x33ff99,
    footer: { text: 'Powered by PimpsDev' },
    timestamp: new Date().toISOString(),
  };

  const notifiedGuilds = new Set();
  for (const id of uniq(channel_ids)) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || notifiedGuilds.has(ch.guildId)) continue;
    notifiedGuilds.add(ch.guildId);
    await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ===================== Exports ===================== */
module.exports = {
  trackApeContracts,
  contractListeners,
};







