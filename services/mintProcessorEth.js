// mintProcessorEth.js — Enhanced to match Base logic (bulk mint grouping, ERC20 name/symbol resolve, IPFS fallbacks, decimals-aware)
// Keeps your existing behavior and adds stronger detection + nicer embeds.

const { Interface, Contract, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const { getProvider } = require('./providerM');

const delay = ms => new Promise(res => setTimeout(res, ms));

/* ===================== CONSTANTS / HELPERS ===================== */

const TOKEN_NAME_TO_ADDRESS = {
  ADRIAN: '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea',
  WETH:   '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
};

const TRANSFER_NFT_TOPIC   = id('Transfer(address,address,uint256)');
const TRANSFER_ERC20_TOPIC = id('Transfer(address,address,uint256)'); // same signature; ERC20 has amount in `data`

const IPFS_GATEWAYS = [
  'https://cloudflare-ipfs.com/ipfs/',
  'https://ipfs.io/ipfs/',
  'https://dweb.link/ipfs/'
];

function toIpfsHttp(url = '') {
  if (!url || typeof url !== 'string') return url;
  if (!url.startsWith('ipfs://')) return [url];
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
    } catch { /* try next */ }
  }
  return null;
}

function normalizeChannels(channel_ids) {
  if (Array.isArray(channel_ids)) return channel_ids.filter(Boolean).map(String);
  if (!channel_ids) return [];
  return channel_ids.toString().split(',').map(s => s.trim()).filter(Boolean);
}

function uniq(arr) { return [...new Set(arr)]; }

/* ===== ERC-20 helpers (decimals + name/symbol) ===== */
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
  try { return parseFloat(ethers.formatUnits(rawDataHex, decimals)); }
  catch { return parseFloat(ethers.formatUnits(rawDataHex, 18)); }
}
async function getErc20NameSymbol(provider, tokenAddr) {
  try {
    const erc20 = new Contract(tokenAddr, [
      'function name() view returns (string)',
      'function symbol() view returns (string)'
    ], provider);
    const [nm, sym] = await Promise.all([erc20.name().catch(() => null), erc20.symbol().catch(() => null)]);
    return { name: nm || null, symbol: sym || null };
  } catch {
    return { name: null, symbol: null };
  }
}

/* ===================== LISTENER BOOTSTRAP ===================== */

const contractListeners = {};

async function trackEthContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'eth'");
  const contracts = res.rows;
  setupEthBlockListener(client, contracts);
}

/* ===================== BLOCK LISTENER (ETH) ===================== */

function setupEthBlockListener(client, contractRows) {
  const provider = getProvider('eth');
  if (!provider || provider._global_block_listener_eth) return;
  provider._global_block_listener_eth = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const globalSeenSales = new Set();
  const globalSeenMints = new Set();

  provider.on('block', async (blockNumber) => {
    // window of last 5 blocks similar to Base logic
    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;
    const mintTxMap = new Map(); // txHash -> Map(guildId, { row, contract, tokenIds:Set, to })

    for (const row of contractRows) {
      const name = row.name || 'Unknown';
      const address = (row.address || '').toLowerCase();

      const filter = { address, topics: [TRANSFER_NFT_TOPIC], fromBlock, toBlock };

      // small pacing to avoid rate-limit bursts across many contracts
      await delay(150);

      let logs = [];
      try {
        logs = await provider.getLogs(filter);
      } catch (err) {
        if (String(err?.message || '').includes('batch') || String(err?.message || '').includes('429')) return;
        console.warn(`[${name}] ETH log fetch error: ${err.message}`);
        return;
      }

      const contract = new Contract(address, iface.fragments, provider);
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
        let parsed;
        try { parsed = iface.parseLog(log); } catch { continue; }

        const { from, to, tokenId } = parsed.args;
        const tokenIdStr = tokenId.toString();
        const txHash = (log.transactionHash || '').toLowerCase();
        if (!txHash) continue;

        const mintKey = `${(log.address || '').toLowerCase()}-${tokenIdStr}`;

        if (from === ZeroAddress) {
          // MINT — group by tx and guild (bulk-aware)
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
          // SALE / TRANSFER
          let shouldSend = false;
          for (const gid of allGuildIds) {
            const dedupeKey = `${gid}-${txHash}`;
            if (globalSeenSales.has(dedupeKey)) continue;
            globalSeenSales.add(dedupeKey);
            shouldSend = true;
          }
          if (!shouldSend || seenSales.has(txHash)) continue;

          seenSales.add(txHash);
          await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds, provider);
          saveJson(seenSalesPath(name), [...seenSales]);
        }
      }
    }

    // Emit grouped mint notifications (per tx per guild)
    for (const [txHash, txGuildMap] of mintTxMap.entries()) {
      for (const [guildId, { row, contract, tokenIds, to }] of txGuildMap.entries()) {
        const tokenIdArray = Array.from(tokenIds);
        const isSingle = tokenIdArray.length === 1;
        const channels = normalizeChannels(row.channel_ids).filter(id => {
          const ch = client.channels.cache.get(id);
          return ch?.guildId === guildId;
        });
        await handleMintBulk(client, row, contract, tokenIdArray, txHash, channels, isSingle, to, provider);
      }
    }
  });
}

/* ===================== MINT HANDLER (ETH, bulk-aware) ===================== */

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false, minterAddress = '', provider) {
  let { name, mint_token, mint_token_symbol, address: nftAddress } = contractRow;
  provider = provider || getProvider('eth');
  if (!provider || !txHash) return;

  const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
  if (!receipt) return;

  // Resolve token address from config or mapping
  let tokenAddr = (mint_token || '').toLowerCase();
  if (!tokenAddr && mint_token_symbol) {
    const mapped = TOKEN_NAME_TO_ADDRESS[(mint_token_symbol || '').toUpperCase()];
    if (mapped) tokenAddr = mapped.toLowerCase();
  }

  // Determine minter
  let buyer = '';
  try { buyer = minterAddress ? ethers.getAddress(minterAddress) : ''; } catch { buyer = ''; }

  // Detect token spend:
  // 1) If tokenAddr known: ERC20 Transfer from buyer for that token
  // 2) Else: infer largest ERC20 Transfer from buyer (exclude NFT contract)
  let tokenAmount = null;
  let inferredTokenAddr = tokenAddr;

  if (buyer) {
    const addrEq = (a, b) => (a || '').toLowerCase() === (b || '').toLowerCase();

    if (tokenAddr) {
      for (const log of receipt.logs) {
        if (log.topics[0] === TRANSFER_ERC20_TOPIC && log.topics.length === 3 && (log.address || '').toLowerCase() === tokenAddr) {
          const from = '0x' + log.topics[1].slice(26);
          if (addrEq(from, buyer)) {
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
        if ((log.address || '').toLowerCase() === (contract.target || contract.address || '').toLowerCase()) continue;
        if (log.topics[0] !== TRANSFER_ERC20_TOPIC || log.topics.length !== 3) continue;
        const from = '0x' + log.topics[1].slice(26);
        if (!addrEq(from, buyer)) continue;
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

  // If we know token address but not name/symbol, fetch it and persist
  let displayTokenSymbol = mint_token_symbol || 'TOKEN';
  let displayTokenName = mint_token || null;
  const tokenToDescribe = inferredTokenAddr || tokenAddr;

  if (tokenToDescribe && (!mint_token_symbol || !mint_token)) {
    const { name: chainName, symbol: chainSym } = await getErc20NameSymbol(provider, tokenToDescribe);
    if (chainSym) displayTokenSymbol = chainSym;
    if (chainName) displayTokenName = chainName;
    // Persist best-effort
    try {
      const pg = client.pg;
      if (pg && (chainSym || chainName)) {
        await pg.query(
          `UPDATE contract_watchlist
           SET mint_token = COALESCE(NULLIF($1,''), mint_token),
               mint_token_symbol = COALESCE(NULLIF($2,''), mint_token_symbol)
           WHERE address = $3 AND chain = 'eth'`,
          [chainName || '', chainSym || '', nftAddress]
        );
        contractRow.mint_token = contractRow.mint_token || chainName || null;
        contractRow.mint_token_symbol = contractRow.mint_token_symbol || chainSym || null;
      }
    } catch {}
  }

  // Convert to ETH value
  let ethValue = null;
  if (tokenAmount && tokenToDescribe) {
    try {
      ethValue = await getRealDexPriceForToken(tokenAmount, tokenToDescribe);
      if (!ethValue || isNaN(ethValue)) ethValue = null;
    } catch { ethValue = null; }
    if (!ethValue) {
      try {
        const px = await getEthPriceFromToken(tokenToDescribe);
        if (px && !isNaN(px)) ethValue = tokenAmount * px;
      } catch {}
    }
  }

  // Image from tokenURI (first token)
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenIds[0]);
    const meta = await fetchJsonWithFallback(toIpfsHttp(uri), 5000);
    const img = meta?.image;
    if (img) imageUrl = img.startsWith('ipfs://') ? toIpfsHttp(img)[0] : img;
  } catch {}

  const embed = {
    title: isSingle ? `✨ NEW ${(name || '').toUpperCase()} MINT!` : `✨ BULK ${(name || '').toUpperCase()} MINT (${tokenIds.length})!`,
    description: isSingle ? `Minted Token ID: #${tokenIds[0]}` : `Minted Token IDs: ${tokenIds.map(id => `#${id}`).join(', ')}`,
    fields: [
      { name: `💰 Total Spent (${displayTokenSymbol})`, value: tokenAmount ? tokenAmount.toFixed(4) : '0.0000', inline: true },
      { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
      { name: `👤 Minter`, value: buyer ? shortWalletLink(buyer) : (minterAddress ? shortWalletLink(minterAddress) : 'Unknown'), inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0xF29D38,
    footer: { text: 'Live on Ethereum • Powered by PimpsDev' },
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

/* ===================== SALE HANDLER (ETH) ===================== */

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids, provider) {
  const { name, mint_token_symbol, address } = contractRow;
  provider = provider || getProvider('eth');
  if (!provider) return;

  // NFT image
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  try {
    let uri = await contract.tokenURI(tokenId);
    const meta = await fetchJsonWithFallback(toIpfsHttp(uri), 5000);
    const img = meta?.image;
    if (img) imageUrl = img.startsWith('ipfs://') ? toIpfsHttp(img)[0] : img;
  } catch {}

  let receipt, tx;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
    tx = await provider.getTransaction(txHash);
    if (!receipt || !tx) return;
  } catch { return; }

  let tokenAmount = null, ethValue = null, methodUsed = null;

  // Case 1: Paid in native ETH
  try {
    if (tx.value && tx.value > 0n) {
      tokenAmount = parseFloat(ethers.formatEther(tx.value));
      ethValue = tokenAmount;
      methodUsed = '🟦 ETH';
    }
  } catch {}

  // Case 2: Paid in ERC20 (WETH/others) — find ERC20 transfer TO seller
  if (!ethValue) {
    const seller = (() => { try { return ethers.getAddress(from); } catch { return (from || ''); } })();
    for (const log of receipt.logs) {
      const notNft = (log.address || '').toLowerCase() !== (contract.target || contract.address || '').toLowerCase();
      if (log.topics[0] === TRANSFER_ERC20_TOPIC && log.topics.length === 3 && notNft) {
        try {
          const toAddr = ethers.getAddress('0x' + log.topics[2].slice(26));
          if (toAddr.toLowerCase() === seller.toLowerCase()) {
            const tokenContract = (log.address || '').toLowerCase();
            const amt = await formatErc20(provider, tokenContract, log.data);
            if (!isFinite(amt) || amt <= 0) continue;
            tokenAmount = amt;

            let priceEth = null;
            try { priceEth = await getRealDexPriceForToken(amt, tokenContract); } catch {}
            if (!priceEth) {
              try {
                const px = await getEthPriceFromToken(tokenContract);
                if (px) priceEth = amt * px;
              } catch {}
            }
            ethValue = priceEth || null;

            // try resolve real symbol
            let symbol = mint_token_symbol || 'TOKEN';
            if (tokenContract === TOKEN_NAME_TO_ADDRESS.WETH.toLowerCase()) symbol = 'WETH';
            else {
              try {
                const info = await getErc20NameSymbol(provider, tokenContract);
                if (info?.symbol) symbol = info.symbol;
              } catch {}
            }
            methodUsed = `🟨 ${symbol}`;
            if (ethValue) break;
          }
        } catch {}
      }
    }
  }

  if (!tokenAmount || !ethValue) return;

  // USD (best-effort)
  let usdValue = 'N/A';
  try {
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd').then(r => r.json());
    const ethUsd = cg?.ethereum?.usd;
    if (ethUsd) usdValue = (ethValue * ethUsd).toFixed(2);
  } catch {}

  const osUrl = `https://opensea.io/assets/ethereum/${address}/${tokenId}`;

  const embed = {
    title: `💸 ${name || 'Collection'} #${tokenId} SOLD`,
    url: osUrl,
    description: `Token \`#${tokenId}\` just sold!`,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: `$${usdValue}`, inline: true },
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
  trackEthContracts,
  contractListeners
};



