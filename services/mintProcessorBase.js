// ✅ ERC721-only mint processor with dynamic token amount detection and multi-server support
const { Interface, Contract, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const { getProvider } = require('./providerM');
const delay = ms => new Promise(res => setTimeout(res, ms));

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

const ZERO_ADDRESS = ethers.ZeroAddress;
const contractListeners = {};

async function trackBaseContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'base'");
  const contracts = res.rows;
  setupBaseBlockListener(client, contracts);
}

function setupBaseBlockListener(client, contractRows) {
  const provider = getProvider('base');
  if (provider._global_block_listener_base) return;
  provider._global_block_listener_base = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  provider.on('block', async (blockNumber) => {
    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;

    const mintTxMap = new Map();

    for (const row of contractRows) {
      let logs = [];
      try {
        logs = await provider.getLogs({
          address: row.address.toLowerCase(),
          topics: [ethers.id('Transfer(address,address,uint256)')],
          fromBlock,
          toBlock
        });
      } catch {}

      const contract = new Contract(row.address, iface.fragments, provider);
      const name = row.name;
      let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
      let seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => tx.toLowerCase()));

      for (const log of logs) {
        if (log.topics[0] !== ethers.id('Transfer(address,address,uint256)')) continue;
        let parsed;
        try { parsed = iface.parseLog(log); } catch { continue; }
        const { from, to, tokenId } = parsed.args;
        const tokenIdStr = tokenId.toString();
        const txHash = log.transactionHash?.toLowerCase();
        if (!txHash) continue;
        const mintKey = `${log.address}-${tokenIdStr}`;

        if (from === ZERO_ADDRESS) {
          if (seenTokenIds.has(tokenIdStr)) continue;
          seenTokenIds.add(tokenIdStr);
          if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, []);
          mintTxMap.get(txHash).push({ row, contract, tokenId: tokenIdStr, to });
          saveJson(seenPath(name), [...seenTokenIds]);
        } else {
          if (seenSales.has(txHash)) continue;
          seenSales.add(txHash);
          await handleSale(client, row, contract, tokenId, from, to, txHash, row.channel_ids);
          saveJson(seenSalesPath(name), [...seenSales]);
        }
      }
    }

    for (const [txHash, mintList] of mintTxMap.entries()) {
      const grouped = {};
      for (const { row, contract, tokenId, to } of mintList) {
        const key = `${row.address}_${to}`;
        if (!grouped[key]) grouped[key] = { row, contract, tokenIds: [], to };
        grouped[key].tokenIds.push(tokenId);
      }

      for (const group of Object.values(grouped)) {
        const { row, contract, tokenIds, to } = group;
        if (tokenIds.length === 1) {
          await handleMintSingle(client, row, contract, tokenIds[0], txHash, row.channel_ids, to);
        } else {
          await handleMintBulk(client, row, contract, tokenIds, txHash, row.channel_ids, false, to);
        }
      }
    }
  });
}

async function handleMintSingle(client, contractRow, contract, tokenIdStr, txHash, channel_ids, minterAddress) {
  await handleMintBulk(client, contractRow, contract, [tokenIdStr], txHash, channel_ids, true, minterAddress);
}

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false, minterAddress = '') {
  const { name, mint_token, mint_token_symbol } = contractRow;
  const provider = getProvider('base');
  if (!txHash) return;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return;

  let tokenAddr = mint_token?.toLowerCase?.() || '';
  if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol?.toUpperCase?.()]) {
    tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()];
  }

  let tokenAmount = null;
  const buyer = ethers.getAddress(minterAddress);
  for (const log of receipt.logs) {
    if (log.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);
      if (from.toLowerCase() === buyer.toLowerCase() && log.address.toLowerCase() === tokenAddr) {
        try {
          tokenAmount = parseFloat(ethers.formatUnits(log.data, 18));
          break;
        } catch (e) {
          console.warn('❌ Token amount parse error', e);
        }
      }
    }
  }

  let ethValue = null;
  if (tokenAmount && tokenAddr) {
    try {
      ethValue = await getRealDexPriceForToken(tokenAmount, tokenAddr);
      if (!ethValue || isNaN(ethValue)) ethValue = null;
    } catch (err) {
      console.warn(`❌ Error with DEX price for ${tokenAmount} ${mint_token_symbol}:`, err);
      ethValue = null;
    }

    if (!ethValue) {
      try {
        const fallback = await getEthPriceFromToken(tokenAddr);
        if (fallback && !isNaN(fallback)) {
          ethValue = tokenAmount * fallback;
        }
      } catch (err) {
        console.warn(`❌ Fallback price error for ${mint_token_symbol}:`, err);
      }
    }
  }

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenIds[0]);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  const embed = {
    title: isSingle ? `✨ NEW ${name.toUpperCase()} MINT!` : `✨ BULK ${name.toUpperCase()} MINT (${tokenIds.length})!`,
    description: isSingle ? `Minted Token ID: #${tokenIds[0]}` : `Minted Token IDs: ${tokenIds.map(id => `#${id}`).join(', ')}`,
    fields: [
      { name: `💰 Total Spent (${mint_token_symbol})`, value: tokenAmount ? tokenAmount.toFixed(4) : '0.0000', inline: true },
      { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
      { name: `👤 Minter`, value: minterAddress ? shortWalletLink(minterAddress) : 'Unknown', inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 219139,
    footer: { text: 'Live on Base • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const id of [...new Set(channel_ids)]) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids) {
 const { name, mint_token, mint_token_symbol } = contractRow;

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  let receipt, tx;
  try {
    receipt = await getProvider('base').getTransactionReceipt(txHash);
    tx = await getProvider('base').getTransaction(txHash);
    if (!receipt || !tx) return;
  } catch { return; }

  let tokenAmount = null, ethValue = null, methodUsed = null;

  if (tx.value && tx.value > 0n) {
    tokenAmount = parseFloat(ethers.formatEther(tx.value));
    ethValue = tokenAmount;
    methodUsed = '🔦 ETH';
  }

  if (!ethValue) {
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const seller = ethers.getAddress(from);

    for (const log of receipt.logs) {
      if (log.topics[0] === transferTopic && log.topics.length === 3 && log.address !== contract.address) {
        try {
          const toAddr = ethers.getAddress('0x' + log.topics[2].slice(26));
          if (toAddr.toLowerCase() === seller.toLowerCase()) {
            const tokenContract = log.address;
            tokenAmount = parseFloat(ethers.formatUnits(log.data, 18));
            ethValue = await getRealDexPriceForToken(tokenAmount, tokenContract);
            if (!ethValue) {
              const fallback = await getEthPriceFromToken(tokenContract);
              ethValue = fallback ? tokenAmount * fallback : null;
            }
            methodUsed = `🔨 ${mint_token_symbol}`;
            break;
          }
        } catch {}
      }
    }
  }

  if (!tokenAmount || !ethValue) return;

  const embed = {
    title: `💸 NFT SOLD – ${name} #${tokenId}`,
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
  for (const id of channel_ids) {
    if (sentChannels.has(id)) continue;
    sentChannels.add(id);
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

module.exports = {
  trackBaseContracts,
  contractListeners
};
