const { Interface, Contract, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const { getProvider } = require('./providerM');
const delay = ms => new Promise(res => setTimeout(res, ms));

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

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

  const globalSeenSales = new Set();
  const globalSeenMints = new Set();

  provider.on('block', async (blockNumber) => {
    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;

    let logs = [];
    try { logs = await provider.getLogs({
      topics: [id('Transfer(address,address,uint256)')],
      fromBlock,
      toBlock
    }); } catch (err) { return; }

    const mintTxMap = new Map();

    for (const log of logs) {
      if (log.topics[0] !== id('Transfer(address,address,uint256)')) continue;
      const matchedContract = contractRows.find(row => row.address.toLowerCase() === log.address.toLowerCase());
      if (!matchedContract) continue;

      const contract = new Contract(log.address, iface.fragments, provider);
      const name = matchedContract.name;
      let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
      let seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => tx.toLowerCase()));

      let parsed;
      try { parsed = iface.parseLog(log); } catch { continue; }
      const { from, to, tokenId } = parsed.args;
      const tokenIdStr = tokenId.toString();
      const txHash = log.transactionHash.toLowerCase();
      const allChannelIds = [...new Set([...(matchedContract.channel_ids || [])])];
      const allGuildIds = [];

      for (const id of allChannelIds) {
        try {
          const ch = await client.channels.fetch(id);
          if (ch.guildId) allGuildIds.push(ch.guildId);
        } catch {}
      }

      const mintKey = `${log.address}-${tokenIdStr}`;
      const saleKey = `${log.address}-${txHash}`;

      if (from === ZeroAddress) {
        let shouldSend = false;
        for (const gid of allGuildIds) {
          const dedupeKey = `${gid}-${mintKey}`;
          if (globalSeenMints.has(dedupeKey)) continue;
          globalSeenMints.add(dedupeKey);
          shouldSend = true;
        }
        if (!shouldSend || seenTokenIds.has(tokenIdStr)) continue;
        seenTokenIds.add(tokenIdStr);

        if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, { matchedContract, contract, tokenIds: [] });
        mintTxMap.get(txHash).tokenIds.push(tokenIdStr);

        saveJson(seenPath(name), [...seenTokenIds]);
      } else {
        let shouldSend = false;
        for (const gid of allGuildIds) {
          const dedupeKey = `${gid}-${txHash}`;
          if (globalSeenSales.has(dedupeKey)) continue;
          globalSeenSales.add(dedupeKey);
          shouldSend = true;
        }
        if (!shouldSend || seenSales.has(txHash)) continue;
        seenSales.add(txHash);
        await handleSale(client, matchedContract, contract, tokenId, from, to, txHash, allChannelIds);
        saveJson(seenSalesPath(name), [...seenSales]);
      }
    }

    for (const [txHash, { matchedContract, contract, tokenIds }] of mintTxMap.entries()) {
      if (tokenIds.length === 1) {
        await handleMintSingle(client, matchedContract, contract, tokenIds[0], txHash, matchedContract.channel_ids);
      } else {
        await handleMintBulk(client, matchedContract, contract, tokenIds, txHash, matchedContract.channel_ids);
      }
    }
  });
}

// ✅ HANDLE MINT SINGLE
async function handleMintSingle(client, contractRow, contract, tokenIdStr, txHash, channel_ids) {
  await handleMintBulk(client, contractRow, contract, [tokenIdStr], txHash, channel_ids, true);
}

// ✅ HANDLE MINT BULK
async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids, isSingle = false) {
  const { name, mint_price, mint_token, mint_token_symbol } = contractRow;
  const provider = getProvider('base');
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) return;

  let tokenAddr = mint_token?.toLowerCase?.() || '';
  if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol?.toUpperCase?.()]) {
    tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()];
  }

  let total = Number(mint_price) * tokenIds.length;
  let ethValue = await getRealDexPriceForToken(total, tokenAddr);
  if (!ethValue) {
    const fallback = await getEthPriceFromToken(tokenAddr);
    ethValue = fallback ? total * fallback : null;
  }

  const imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  const embed = {
    title: isSingle ? `✨ NEW ${name.toUpperCase()} MINT!` : `✨ BULK ${name.toUpperCase()} MINT (${tokenIds.length})!`,
    description: isSingle ? `Minted Token ID: #${tokenIds[0]}` : `Minted Token IDs: ${tokenIds.map(id => `#${id}`).join(', ')}`,
    fields: [
      { name: `💰 Total Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
      { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true }
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
    const transferTopic = id('Transfer(address,address,uint256)');
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
