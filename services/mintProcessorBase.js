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

    for (const row of contractRows) {
      try {
        const name = row.name;
        const address = row.address.toLowerCase();
        const filter = {
          address,
          topics: [id('Transfer(address,address,uint256)')],
          fromBlock,
          toBlock
        };

        await delay(150);
        let logs = [];
        try { logs = await provider.getLogs(filter); } catch (err) { return; }

        const contract = new Contract(address, iface.fragments, provider);
        let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
        let seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => tx.toLowerCase()));

        const mintTxMap = new Map();

        for (const log of logs) {
          let parsed;
          try { parsed = iface.parseLog(log); } catch { continue; }
          const { from, to, tokenId } = parsed.args;
          const tokenIdStr = tokenId.toString();
          const txHash = log.transactionHash.toLowerCase();
          const allChannelIds = [...new Set([...(row.channel_ids || [])])];
          const allGuildIds = [];

          for (const id of allChannelIds) {
            try {
              const ch = await client.channels.fetch(id);
              if (ch.guildId) allGuildIds.push(ch.guildId);
            } catch {}
          }

          const mintKey = `${address}-${tokenIdStr}`;
          const saleKey = `${address}-${txHash}`;

          const isMint = from === ZeroAddress || from.toLowerCase() === address || from.toLowerCase() === '0x0000000000000000000000000000000000000001';

          if (isMint) {
            let shouldSend = false;
            for (const gid of allGuildIds) {
              const dedupeKey = `${gid}-${mintKey}`;
              if (globalSeenMints.has(dedupeKey)) continue;
              globalSeenMints.add(dedupeKey);
              shouldSend = true;
            }
            if (!shouldSend || seenTokenIds.has(tokenIdStr)) continue;
            seenTokenIds.add(tokenIdStr);

            if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, []);
            mintTxMap.get(txHash).push(tokenIdStr);

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
            await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds);
          }
        }

        for (const [txHash, tokenIds] of mintTxMap.entries()) {
          if (tokenIds.length > 1) {
            await handleMintBulk(client, row, contract, tokenIds, txHash, allChannelIds);
          } else {
            await handleMintSingle(client, row, contract, tokenIds[0], txHash, allChannelIds);
          }
        }

        saveJson(seenPath(name), [...seenTokenIds]);
        saveJson(seenSalesPath(name), [...seenSales]);
      } catch (err) {
        console.warn(`[${row.name}] Block processing error: ${err.message}`);
      }
    }
  });
}

async function handleMintSingle(client, contractRow, contract, tokenId, txHash, channel_ids) {
  const { name, mint_price, mint_token, mint_token_symbol } = contractRow;
  const provider = getProvider('base');

  let tokenAddr = mint_token?.toLowerCase?.() || '';
  if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol?.toUpperCase?.()]) {
    tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()];
  }

  let ethValue = await getRealDexPriceForToken(Number(mint_price), tokenAddr);
  if (!ethValue) {
    const fallback = await getEthPriceFromToken(tokenAddr);
    ethValue = fallback ? Number(mint_price) * fallback : null;
  }

  const imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  const embed = {
    title: `✨ NEW ${name.toUpperCase()} MINT!`,
    description: `Minted Token ID: #${tokenId}`,
    fields: [
      { name: `💰 Spent (${mint_token_symbol})`, value: Number(mint_price).toFixed(4), inline: true },
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

async function handleMintBulk(client, contractRow, contract, tokenIds, txHash, channel_ids) {
  const { name, mint_price, mint_token, mint_token_symbol } = contractRow;
  const provider = getProvider('base');

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
    title: `✨ BULK ${name.toUpperCase()} MINT (${tokenIds.length})!`,
    description: `Minted Token IDs:\n${tokenIds.map(id => `#${id}`).join(', ')}`,
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
