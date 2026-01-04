// services/mintProcessorBase.js
const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const { safeRpcCall } = require('./providerM');
const delay = ms => new Promise(res => setTimeout(res, ms));

/* ✅ Daily Digest logger (optional; won't crash if missing) */
let logDigestEvent = null;
try {
  ({ logDigestEvent } = require('./digestLogger'));
} catch {
  logDigestEvent = null;
}

/* ===================== CONSTANTS / HELPERS ===================== */

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

// ✅ FIX: If payment token contract == this CA, show "AdrianBot" in Method field
const ADRIANBOT_PAYMENT_CA = '0xa41d5faf7ba8b82e276125de2a053216e91f4814'.toLowerCase();

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

function addrEq(a, b) {
  return (a || '').toLowerCase() === (b || '').toLowerCase();
}

/* ===================== ETH USD (CACHED) ===================== */

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

/* ===================== DIGEST DEDUPE (in-process) ===================== */

const _digestSeen = new Set();
function _digestKey({ guildId, type, txHash, tokenId }) {
  return `${String(guildId || '')}:${String(type || '')}:${String(txHash || '').toLowerCase()}:${String(tokenId || '')}`;
}
function _markDigestSeen(key) {
  _digestSeen.add(key);
  setTimeout(() => _digestSeen.delete(key), 72 * 60 * 60 * 1000); // 72h TTL
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

      const nftAddress = (row.address || '').toLowerCase();
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
          // SALE/TRANSFER (we validate sale by detecting payment in handleSale)
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

/* ===================== MINT HANDLER ===================== */

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false, minterAddress = '') {
  let { name, mint_token, mint_token_symbol, address: nftAddress } = contractRow;
  const provider = await safeRpcCall('base', p => p);
  if (!provider || !txHash) return;

  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return;

  // ✅ fetch tx (used for payer fallback + native value if any)
  const tx = await provider.getTransaction(txHash).catch(() => null);

  // Resolve configured token address if provided
  let tokenAddr = (mint_token || '').toLowerCase();
  if (!tokenAddr && mint_token_symbol) {
    const mapped = TOKEN_NAME_TO_ADDRESS[(mint_token_symbol || '').toUpperCase()];
    if (mapped) tokenAddr = mapped.toLowerCase();
  }

  // Determine buyer/minter address safely (recipient)
  let buyer = '';
  try { buyer = minterAddress ? ethers.getAddress(minterAddress) : ''; } catch { buyer = ''; }

  // ✅ Payer fallback (the wallet that submitted the tx)
  let payer = '';
  try { payer = tx?.from ? ethers.getAddress(tx.from) : ''; } catch { payer = tx?.from || ''; }

  // ✅ Find payment transfers from buyer/payer
  let tokenAmount = null;
  let inferredTokenAddr = tokenAddr;

  const nftLower = (contract.target || contract.address || nftAddress || '').toLowerCase();

  const payerCandidates = uniq([buyer, payer].filter(Boolean));

  async function findPaymentFrom(fromAddrCandidate) {
    if (!fromAddrCandidate) return { amount: null, token: null };

    // A) If tokenAddr configured, look for that token first (from == candidate)
    if (tokenAddr) {
      for (const lg of receipt.logs) {
        if (lg.topics[0] !== TRANSFER_ERC20_TOPIC || lg.topics.length !== 3) continue;
        if ((lg.address || '').toLowerCase() !== tokenAddr) continue;

        const fromTopic = '0x' + lg.topics[1].slice(26);
        if (!addrEq(fromTopic, fromAddrCandidate)) continue;

        try {
          const amt = await formatErc20(provider, tokenAddr, lg.data);
          if (amt && amt > 0) return { amount: amt, token: tokenAddr };
        } catch {}
      }
    }

    // B) Fallback inference: biggest ERC20 Transfer where from == candidate (skip NFT contract logs)
    let best = { amount: 0, token: null };
    for (const lg of receipt.logs) {
      if (lg.topics[0] !== TRANSFER_ERC20_TOPIC || lg.topics.length !== 3) continue;

      const logAddr = (lg.address || '').toLowerCase();
      if (!logAddr || logAddr === nftLower) continue;

      const fromTopic = '0x' + lg.topics[1].slice(26);
      if (!addrEq(fromTopic, fromAddrCandidate)) continue;

      try {
        const amt = await formatErc20(provider, logAddr, lg.data);
        if (amt > best.amount) best = { amount: amt, token: logAddr };
      } catch {}
    }

    return best.amount > 0 ? best : { amount: null, token: null };
  }

  // Try candidates (buyer first, then payer)
  for (const c of payerCandidates) {
    const found = await findPaymentFrom(c);
    if (found.amount && found.token) {
      tokenAmount = found.amount;
      inferredTokenAddr = found.token;
      break;
    }
  }

  // 🔹 If we have a token address but no known name/symbol, fetch from chain
  let displayTokenSymbol = mint_token_symbol || 'TOKEN';
  let displayTokenName = mint_token || null;

  const tokenToDescribe = inferredTokenAddr || tokenAddr;
  if (tokenToDescribe && (!mint_token_symbol || !mint_token)) {
    const { name: chainName, symbol: chainSym } = await getErc20NameSymbol(provider, tokenToDescribe);
    if (chainSym) displayTokenSymbol = chainSym;
    if (chainName) displayTokenName = chainName;

    // Optional: persist to DB so we don't fetch again next time
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

  // ✅ ETH value
  let ethValue = null;

  try {
    if (tx?.value && tx.value > 0n) {
      ethValue = parseFloat(ethers.formatEther(tx.value));
    }
  } catch {}

  if (!ethValue && tokenAmount && tokenToDescribe) {
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

  // ✅ USD value (derived from ETH value)
  let usdValue = null;
  try {
    if (ethValue && isFinite(ethValue) && ethValue > 0) {
      const ethUsd = await getEthUsdPriceCached();
      if (ethUsd && ethUsd > 0) usdValue = ethValue * ethUsd;
    }
  } catch { usdValue = null; }

  // Resolve image (tokenURI of first token)
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
      { name: `👤 Minter`, value: buyer ? shortWalletLink(buyer) : (minterAddress ? shortWalletLink(minterAddress) : (payer ? shortWalletLink(payer) : 'Unknown')), inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0x35A3B3,
    footer: { text: 'Live on Base • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  // ✅ Send + track successful guilds
  const sentGuilds = new Set();
  const sentChannels = new Set();

  for (const id of uniq(normalizeChannels(channel_ids))) {
    if (sentChannels.has(id)) continue;
    sentChannels.add(id);

    const ch = client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
    if (!ch) continue;

    try {
      await ch.send({ embeds: [embed] });
      if (ch?.guildId) sentGuilds.add(String(ch.guildId));
    } catch {}
  }

  // ✅ DIGEST LOGGING (MINT) — only for guilds where we actually sent
  try {
    if (logDigestEvent && txHash && tokenIds?.length && sentGuilds.size) {
      for (const gid of sentGuilds) {
        for (const tid of tokenIds) {
          const key = _digestKey({ guildId: gid, type: 'mint', txHash, tokenId: tid });
          if (_digestSeen.has(key)) continue;
          _markDigestSeen(key);

          await logDigestEvent(client, {
            guildId: gid,
            eventType: 'mint',
            chain: 'base',
            contract: (nftAddress || contract.target || contract.address || '').toLowerCase(),
            tokenId: String(tid),
            amountNative: tokenAmount != null ? Number(tokenAmount) : null,
            amountEth: ethValue != null ? Number(ethValue) : null,
            amountUsd: usdValue != null ? Number(usdValue) : null,
            buyer: buyer || payer || null,
            seller: null,
            txHash: String(txHash)
          });
        }
      }
    }
  } catch {}
}

/* ===================== SALE HANDLER (PATCHED PAYMENT DETECTION) ===================== */

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids) {
  const { name, mint_token_symbol, address: nftAddress } = contractRow;

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
  } catch {
    return;
  }

  const buyer = (() => { try { return ethers.getAddress(to); } catch { return (to || ''); } })();
  const seller = (() => { try { return ethers.getAddress(from); } catch { return (from || ''); } })();

  const nftLower = (contract.target || contract.address || nftAddress || '').toLowerCase();

  let tokenAmount = null;
  let ethValue = null;
  let usdValue = null;
  let methodUsed = null;

  // 1) Native ETH paid
  try {
    if (tx.value && tx.value > 0n) {
      const v = parseFloat(ethers.formatEther(tx.value));
      if (v > 0) {
        tokenAmount = v;
        ethValue = v;
        methodUsed = '🟦 ETH';
      }
    }
  } catch {}

  // 2) ERC20 payment evidence: look for transfers OUT of buyer (largest value)
  if (!ethValue) {
    const candidates = [];
    for (const lg of receipt.logs || []) {
      if (lg.topics?.[0] !== TRANSFER_ERC20_TOPIC || lg.topics.length !== 3) continue;

      const tokenContract = (lg.address || '').toLowerCase();
      if (!tokenContract || tokenContract === nftLower) continue;

      const fromTopic = '0x' + lg.topics[1].slice(26);
      if (!addrEq(fromTopic, buyer)) continue;

      try {
        const amt = await formatErc20(provider, tokenContract, lg.data);
        if (!Number.isFinite(amt) || amt <= 0) continue;
        candidates.push({ tokenContract, amt });
      } catch {}
    }

    // Choose best candidate by ETH value (preferred) else by raw amount
    let best = null;
    for (const c of candidates) {
      let cEth = null;
      try {
        cEth = await getRealDexPriceForToken(c.amt, c.tokenContract);
        if (!cEth || isNaN(cEth) || cEth <= 0) cEth = null;
      } catch { cEth = null; }

      if (!cEth) {
        try {
          const px = await getEthPriceFromToken(c.tokenContract);
          if (px && !isNaN(px) && px > 0) cEth = c.amt * px;
        } catch {}
      }

      const score = cEth != null ? cEth : (c.amt / 1e6); // fallback weak score
      if (!best || score > best.score) best = { ...c, eth: cEth, score };
    }

    if (best && best.amt > 0) {
      tokenAmount = best.amt;
      ethValue = best.eth != null ? best.eth : null;

      if (best.tokenContract === ADRIANBOT_PAYMENT_CA) {
        methodUsed = '🤖 AdrianBot';
      } else {
        // Try resolving symbol
        let sym = null;
        try {
          const ns = await getErc20NameSymbol(provider, best.tokenContract);
          sym = (ns?.symbol || '').trim() || null;
        } catch {}
        methodUsed = `🟨 ${sym || mint_token_symbol || 'TOKEN'}`;
      }
    }
  }

  // ✅ IMPORTANT: If we found no payment evidence, skip (avoids normal transfers being treated as sales)
  if (!tokenAmount || tokenAmount <= 0) return;

  // USD from ETH if possible
  try {
    if (ethValue && isFinite(ethValue) && ethValue > 0) {
      const ethUsd = await getEthUsdPriceCached();
      if (ethUsd && ethUsd > 0) usdValue = ethValue * ethUsd;
    }
  } catch {}

  const paidLine = (() => {
    if (methodUsed === '🟦 ETH') return `${tokenAmount.toFixed(4)} ETH`;
    return tokenAmount ? `${tokenAmount.toFixed(4)}` : 'N/A';
  })();

  const embed = {
    title: `💸 NFT SOLD – ${name || 'Collection'} #${tokenId}`,
    description: `Token \`${tokenId}\` just sold!`,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: paidLine, inline: true },
      { name: `⇄ ETH Value`, value: (ethValue && ethValue > 0) ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
      { name: `💵 USD Value`, value: (usdValue && usdValue > 0) ? `$${usdValue.toFixed(2)}` : 'N/A', inline: true },
      { name: `💳 Method`, value: methodUsed || 'Unknown', inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0x66cc66,
    footer: { text: 'Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  // ✅ Send + track successful guilds
  const sentGuilds = new Set();
  const sentChannels = new Set();

  for (const id of uniq(normalizeChannels(channel_ids))) {
    if (sentChannels.has(id)) continue;
    sentChannels.add(id);

    const ch = client.channels.cache.get(id) || (await client.channels.fetch(id).catch(() => null));
    if (!ch) continue;

    try {
      await ch.send({ embeds: [embed] });
      if (ch?.guildId) sentGuilds.add(String(ch.guildId));
    } catch {}
  }

  // ✅ DIGEST LOGGING (SALE) — only for guilds where we actually sent
  try {
    if (logDigestEvent && txHash && sentGuilds.size) {
      const tidStr = tokenId?.toString?.() || String(tokenId);

      for (const gid of sentGuilds) {
        const key = _digestKey({ guildId: gid, type: 'sale', txHash, tokenId: tidStr });
        if (_digestSeen.has(key)) continue;
        _markDigestSeen(key);

        await logDigestEvent(client, {
          guildId: gid,
          eventType: 'sale',
          chain: 'base',
          contract: (nftAddress || contract.target || contract.address || '').toLowerCase(),
          tokenId: tidStr,
          amountNative: tokenAmount != null ? Number(tokenAmount) : null,
          amountEth: ethValue != null ? Number(ethValue) : null,
          amountUsd: usdValue != null ? Number(usdValue) : null,
          buyer: buyer ? String(buyer).toLowerCase() : null,
          seller: seller ? String(seller).toLowerCase() : null,
          txHash: String(txHash)
        });
      }
    }
  } catch {}
}

/* ===================== EXPORTS ===================== */

module.exports = {
  trackBaseContracts,
  contractListeners
};
