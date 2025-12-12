const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const { safeRpcCall } = require('./providerM');
const delay = ms => new Promise(res => setTimeout(res, ms));

/* ===================== CONSTANTS / HELPERS ===================== */

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

const ZERO_ADDRESS = ethers.ZeroAddress;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const TRANSFER_ERC20_TOPIC = ethers.id('Transfer(address,address,uint256)'); // ERC20 shares same signature

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

function toIpfsHttp(url = '') {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('ipfs://')) return url;
  const cid = url.replace('ipfs://', '');
  return IPFS_GATEWAYS.map(g => g + cid);
}

async function fetchJsonWithFallback(urlOrList, timeoutMs = 5000) {
  const urls = Array.isArray(urlOrList) ? urlOrList : [urlOrList];
  for (const url of urls) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) continue;
      const json = await res.json().catch(() => null);
      if (json) return json;
    } catch {}
  }
  return null;
}

function normalizeChannels(channel_ids) {
  if (Array.isArray(channel_ids)) return channel_ids.filter(Boolean).map(String);
  if (!channel_ids) return [];
  return channel_ids.toString().split(',').map(s => s.trim()).filter(Boolean);
}

function uniq(arr) {
  return [...new Set(arr)];
}

function toShort(addr = '') {
  if (!addr) return '';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

/* ===================== ETH USD PRICE (CACHED) ===================== */

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

/* Decimals cache for ERC20 tokens */
const decimalsCache = new Map();
async function getErc20Decimals(provider, tokenAddr) {
  const key = (tokenAddr || '').toLowerCase();
  if (decimalsCache.has(key)) return decimalsCache.get(key);
  try {
    const erc20 = new Contract(tokenAddr, ['function decimals() view returns (uint8)'], provider);
    const d = await erc20.decimals();
    decimalsCache.set(key, d);
    return d;
  } catch {
    decimalsCache.set(key, 18);
    return 18;
  }
}

async function formatErc20(provider, tokenAddr, rawDataHex) {
  const decimals = await getErc20Decimals(provider, tokenAddr);
  try {
    return parseFloat(ethers.formatUnits(rawDataHex, decimals));
  } catch {
    return parseFloat(ethers.formatUnits(rawDataHex, 18));
  }
}

/* Resolve ERC-20 name/symbol */
async function getErc20NameSymbol(provider, tokenAddr) {
  try {
    const erc20 = new Contract(tokenAddr, [
      'function name() view returns (string)',
      'function symbol() view returns (string)'
    ], provider);
    const [nm, sym] = await Promise.all([
      erc20.name().catch(() => null),
      erc20.symbol().catch(() => null)
    ]);
    return { name: nm || null, symbol: sym || null };
  } catch {
    return { name: null, symbol: null };
  }
}

/* ===================== LISTENER BOOTSTRAP ===================== */

const contractListeners = {};

async function trackBaseContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'base'");
  const contracts = res.rows;
  setupBaseBlockListener(client, contracts);
}

/* ===================== BLOCK LISTENER ===================== */

function setupBaseBlockListener(client, contractRows) {
  if (global._base_block_listener) return;
  global._base_block_listener = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const globalSeenSales = new Set();
  const globalSeenMints = new Set();

  setInterval(async () => {
    const provider = await safeRpcCall('base', p => p);
    if (!provider) return;

    const blockNumber = await provider.getBlockNumber().catch(() => null);
    if (!blockNumber) return;

    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;
    const mintTxMap = new Map(); // txHash -> Map(guildId, { row, contract, tokenIds, to })

    for (const row of contractRows) {
      let logs = [];
      try {
        logs = await provider.getLogs({
          address: (row.address || '').toLowerCase(),
          topics: [TRANSFER_TOPIC],
          fromBlock,
          toBlock
        });
      } catch {}

      const nftAddress = row.address;
      const contract = new Contract(nftAddress, iface.fragments, provider);
      const name = row.name || 'Unknown';
      let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
      let seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => (tx || '').toLowerCase()));

      const allChannelIds = uniq(normalizeChannels(row.channel_ids));
      const allGuildIds = [];
      for (const id of allChannelIds) {
        try {
          const ch = await client.channels.fetch(id);
          if (ch?.guildId) allGuildIds.push(ch.guildId);
        } catch {}
      }

      for (const log of logs) {
        if (log.topics[0] !== TRANSFER_TOPIC) continue;
        let parsed;
        try { parsed = iface.parseLog(log); } catch { continue; }

        const { from, to, tokenId } = parsed.args;
        const tokenIdStr = tokenId.toString();
        const txHash = (log.transactionHash || '').toLowerCase();
        if (!txHash) continue;

        const mintKey = `${(log.address || '').toLowerCase()}-${tokenIdStr}`;

        if (from === ZERO_ADDRESS) {
          // MINT
          for (const gid of allGuildIds) {
            const dedupeKey = `${gid}-${mintKey}`;
            if (globalSeenMints.has(dedupeKey)) continue;
            globalSeenMints.add(dedupeKey);

            if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, new Map());
            const txGuildMap = mintTxMap.get(txHash);

            if (!txGuildMap.has(gid)) txGuildMap.set(gid, { row, contract, tokenIds: new Set(), to });
            txGuildMap.get(gid).tokenIds.add(tokenIdStr);
          }

          if (!seenTokenIds.has(tokenIdStr)) {
            seenTokenIds.add(tokenIdStr);
            saveJson(seenPath(name), [...seenTokenIds]);
          }
        } else {
          // SALE/TRANSFER
          let shouldSend = false;
          for (const gid of allGuildIds) {
            const dedupeKey = `${gid}-${txHash}`;
            if (globalSeenSales.has(dedupeKey)) continue;
            globalSeenSales.add(dedupeKey);
            shouldSend = true;
          }
          if (!shouldSend || seenSales.has(txHash)) continue;

          seenSales.add(txHash);
          await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds);
          saveJson(seenSalesPath(name), [...seenSales]);
        }
      }
    }

    // Emit mint notifications grouped by tx + guild
    for (const [txHash, txGuildMap] of mintTxMap.entries()) {
      for (const [guildId, { row, contract, tokenIds, to }] of txGuildMap.entries()) {
        const tokenIdArray = Array.from(tokenIds);
        const isSingle = tokenIdArray.length === 1;
        const channels = normalizeChannels(row.channel_ids).filter(id => {
          const ch = client.channels.cache.get(id);
          return ch?.guildId === guildId;
        });
        await handleMintBulk(client, row, contract, tokenIdArray, txHash, channels, isSingle, to);
      }
    }
  }, 8000);
}

/* ===================== UTILITY: FILTER ACTUAL BUYER TRANSFERS ===================== */
function isValidBuyerTransfer(log, buyerAddr, nftAddr) {
  try {
    const logFrom = ethers.getAddress('0x' + log.topics[1].slice(26));
    const logTo = ethers.getAddress('0x' + log.topics[2].slice(26));
    if (logFrom.toLowerCase() !== buyerAddr.toLowerCase()) return false;

    const nftLower = (nftAddr || '').toLowerCase();
    const toLower = logTo.toLowerCase();

    // Accept only transfers to NFT contract
    if (toLower === nftLower) return true;

    // Otherwise ignore (tax, LP, router, etc)
    return false;
  } catch {
    return false;
  }
}

/* ===================== MINT HANDLER ===================== */

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false, minterAddress = '') {
  let { name, mint_token, mint_token_symbol, address: nftAddress } = contractRow;
  const provider = await safeRpcCall('base', p => p);
  if (!provider || !txHash) return;

  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return;

  let tokenAddr = (mint_token || '').toLowerCase();
  if (!tokenAddr && mint_token_symbol) {
    const mapped = TOKEN_NAME_TO_ADDRESS[(mint_token_symbol || '').toUpperCase()];
    if (mapped) tokenAddr = mapped.toLowerCase();
  }

  let buyer = '';
  try { buyer = minterAddress ? ethers.getAddress(minterAddress) : ''; } catch { buyer = ''; }

  let tokenAmount = null;
  let inferredTokenAddr = tokenAddr;

  if (buyer) {
    if (tokenAddr) {
      for (const log of receipt.logs) {
        if (log.topics[0] === TRANSFER_ERC20_TOPIC && log.topics.length === 3 && (log.address || '').toLowerCase() === tokenAddr) {
          if (isValidBuyerTransfer(log, buyer, contract.address)) {
            try {
              tokenAmount = await formatErc20(provider, tokenAddr, log.data);
              break;
            } catch {}
          }
        }
      }
    }

    if (!tokenAmount) {
      let best = { amount: 0, token: null };
      for (const log of receipt.logs) {
        if (log.topics[0] !== TRANSFER_ERC20_TOPIC || log.topics.length !== 3) continue;
        if (!isValidBuyerTransfer(log, buyer, contract.address)) continue;
        try {
          const candidateToken = (log.address || '').toLowerCase();
          const amt = await formatErc20(provider, candidateToken, log.data);
          if (amt > best.amount) best = { amount: amt, token: candidateToken };
        } catch {}
      }
      if (best.amount > 0 && best.token) {
        tokenAmount = best.amount;
        inferredTokenAddr = best.token;
      }
    }
  }

  let displayTokenSymbol = mint_token_symbol || 'TOKEN';
  let displayTokenName = mint_token || null;

  const tokenToDescribe = inferredTokenAddr || tokenAddr;
  if (tokenToDescribe && (!mint_token_symbol || !mint_token)) {
    const { name: chainName, symbol: chainSym } = await getErc20NameSymbol(provider, tokenToDescribe);
    if (chainSym) displayTokenSymbol = chainSym;
    if (chainName) displayTokenName = chainName;

    try {
      const pg = client.pg;
      if (pg && (chainSym || chainName)) {
        await pg.query(
          `UPDATE contract_watchlist
           SET mint_token = COALESCE(NULLIF($1,''), mint_token),
               mint_token_symbol = COALESCE(NULLIF($2,''), mint_token_symbol)
           WHERE address = $3 AND chain = 'base'`,
          [chainName || '', chainSym || '', nftAddress]
        );
        contractRow.mint_token = contractRow.mint_token || chainName || null;
        contractRow.mint_token_symbol = contractRow.mint_token_symbol || chainSym || null;
      }
    } catch {}
  }

  // ✅ ETH value (already)
  let ethValue = null;
  if (tokenAmount && tokenToDescribe) {
    try {
      ethValue = await getRealDexPriceForToken(tokenAmount, tokenToDescribe);
      if (!ethValue || isNaN(ethValue)) ethValue = null;
    } catch { ethValue = null; }

    if (!ethValue) {
      try {
        const fallback = await getEthPriceFromToken(tokenToDescribe);
        if (fallback && !isNaN(fallback)) ethValue = tokenAmount * fallback;
      } catch {}
    }
  }

  // ✅ NEW: USD value derived from ETH value * ETH/USD
  let usdValue = null;
  try {
    if (ethValue && isFinite(ethValue) && ethValue > 0) {
      const ethUsd = await getEthUsdPriceCached();
      if (ethUsd && ethUsd > 0) usdValue = ethValue * ethUsd;
    }
  } catch { usdValue = null; }

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenIds[0]);
    const urls = uri.startsWith('ipfs://') ? toIpfsHttp(uri) : [uri];
    const meta = await fetchJsonWithFallback(urls, 5000);
    const img = meta?.image;
    if (img) {
      imageUrl = img.startsWith('ipfs://') ? (toIpfsHttp(img)[0] || imageUrl) : img;
    }
  } catch {}

  const embed = {
    title: isSingle
      ? `✨ NEW ${String(name || '').toUpperCase()} MINT!`
      : `✨ BULK ${String(name || '').toUpperCase()} MINT (${tokenIds.length})!`,
    description: isSingle
      ? `Minted Token ID: #${tokenIds[0]}`
      : `Minted Token IDs: ${tokenIds.map(id => `#${id}`).join(', ')}`,
    fields: [
      { name: `💰 Total Spent (${displayTokenSymbol})`, value: tokenAmount ? tokenAmount.toFixed(4) : '0.0000', inline: true },
      { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
      { name: `💵 USD Value`, value: usdValue ? `$${usdValue.toFixed(2)}` : 'N/A', inline: true },
      { name: `👤 Minter`, value: buyer ? shortWalletLink(buyer) : (minterAddress ? shortWalletLink(minterAddress) : 'Unknown'), inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0x35A3B3,
    footer: { text: 'Live on Base • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const sent = new Set();
  for (const id of uniq(normalizeChannels(channel_ids))) {
    if (sent.has(id)) continue;
    sent.add(id);
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ===================== SALE HANDLER ===================== */

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids) {
  const { name, mint_token_symbol } = contractRow;

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  try {
    let uri = await contract.tokenURI(tokenId);
    const urls = uri.startsWith('ipfs://') ? toIpfsHttp(uri) : [uri];
    const meta = await fetchJsonWithFallback(urls, 5000);
    const img = meta?.image;
    if (img) {
      imageUrl = img.startsWith('ipfs://') ? (toIpfsHttp(img)[0] || imageUrl) : img;
    }
  } catch {}

  const provider = await safeRpcCall('base', p => p);
  if (!provider) return;

  let receipt, tx;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
    tx = await provider.getTransaction(txHash);
    if (!receipt || !tx) return;
  } catch { return; }

  let tokenAmount = null, ethValue = null, methodUsed = null;

  try {
    if (tx.value && tx.value > 0n) {
      tokenAmount = parseFloat(ethers.formatEther(tx.value));
      ethValue = tokenAmount;
      methodUsed = '🟦 ETH';
    }
  } catch {}

  if (!ethValue) {
    for (const log of receipt.logs) {
      if (log.topics[0] !== TRANSFER_ERC20_TOPIC || log.topics.length !== 3) continue;
      if (!isValidBuyerTransfer(log, to, contract.address)) continue;

      try {
        const tokenContract = (log.address || '').toLowerCase();
        const amt = await formatErc20(provider, tokenContract, log.data);
        if (!isFinite(amt) || amt <= 0) continue;

        tokenAmount = amt;

        let priceEth = null;
        try {
          priceEth = await getRealDexPriceForToken(amt, tokenContract);
        } catch {}
        if (!priceEth) {
          try {
            const px = await getEthPriceFromToken(tokenContract);
            if (px) priceEth = amt * px;
          } catch {}
        }
        ethValue = priceEth || null;
        methodUsed = `🟨 ${mint_token_symbol || 'TOKEN'}`;
        if (ethValue) break;
      } catch {}
    }
  }

  if (!tokenAmount || !ethValue) return;

  const embed = {
    title: `💸 NFT SOLD – ${name || 'Collection'} #${tokenId}`,
    description: `Token \`${tokenId}\` just sold!`,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: `${tokenAmount.toFixed(4)}`, inline: true },
      { name: `⇄ ETH Value`, value: `${ethValue.toFixed(4)} ETH`, inline: true },
      { name: `💳 Method`, value: methodUsed || 'Unknown', inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0x66cc66,
    footer: { text: 'Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  const sentChannels = new Set();
  for (const id of normalizeChannels(channel_ids)) {
    if (sentChannels.has(id)) continue;
    sentChannels.add(id);
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

/* ===================== EXPORTS ===================== */

module.exports = {
  trackBaseContracts,
  contractListeners
};




