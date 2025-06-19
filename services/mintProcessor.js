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

async function trackAllContracts(client) {
  const pg = client.pg;
  const res = await pg.query('SELECT * FROM contract_watchlist');
  const contracts = res.rows;

  // Group contracts by chain
  const contractsByChain = {};
  for (const row of contracts) {
    const chain = row.chain || 'base';
    if (!contractsByChain[chain]) contractsByChain[chain] = [];
    contractsByChain[chain].push(row);

    const addressKey = row.address.toLowerCase();
    if (!contractListeners[addressKey]) contractListeners[addressKey] = [];
    contractListeners[addressKey].push(row);
  }

  // Launch 1 block listener per chain
  for (const chain of Object.keys(contractsByChain)) {
    setupChainBlockListener(client, chain, contractsByChain[chain]);
  }
}

function setupChainBlockListener(client, chain, contractRows) {
  const provider = getProvider(chain);
  if (provider[`_global_block_listener_${chain}`]) return;
  provider[`_global_block_listener_${chain}`] = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

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

        await delay(150); // 🧠 throttle each getLogs to avoid batch cap
        const logs = await provider.getLogs(filter);
        const contract = new Contract(address, iface.fragments, provider);

        let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
        let seenSales = new Set(loadJson(seenSalesPath(name)) || []);

        for (const log of logs) {
          let parsed;
          try { parsed = iface.parseLog(log); } catch { continue; }
          const { from, to, tokenId } = parsed.args;
          const tokenIdStr = tokenId.toString();

          const allChannelIds = [...new Set([...(row.channel_ids || [])])];

          if (from === ZeroAddress) {
            if (seenTokenIds.has(tokenIdStr)) continue;
            seenTokenIds.add(tokenIdStr);
            await handleMint(client, row, contract, tokenId, to, allChannelIds);
          } else {
            if (seenSales.has(tokenIdStr)) continue;
            seenSales.add(tokenIdStr);
            await handleSale(client, row, contract, tokenId, from, to, log.transactionHash, allChannelIds);
          }
        }

        if (blockNumber % 10 === 0) {
          saveJson(seenPath(name), [...seenTokenIds]);
          saveJson(seenSalesPath(name), [...seenSales]);
        }
      } catch (err) {
        console.warn(`[${row.name}] Block processing error: ${err.message}`);
      }
    }
  });
}

// (unchanged handleMint / handleSale functions below)

async function handleMint(client, contractRow, contract, tokenId, to, channel_ids) {
  const { name, mint_price, mint_token, mint_token_symbol } = contractRow;

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  const total = Number(mint_price);
  let tokenAddr = mint_token?.toLowerCase?.() || '';
  if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol?.toUpperCase?.()]) {
    tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()];
  }

  let ethValue = await getRealDexPriceForToken(total, tokenAddr);
  if (!ethValue) {
    const fallback = await getEthPriceFromToken(tokenAddr);
    ethValue = fallback ? total * fallback : null;
  }

  const embed = {
    title: `✨ NEW ${name.toUpperCase()} MINT!`,
    description: `Minted by: ${shortWalletLink(to)}\nToken #${tokenId}`,
    fields: [
      { name: `💰 Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
      { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 219139,
    footer: { text: 'Live on Base • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const id of channel_ids) {
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
    receipt = await getProvider().getTransactionReceipt(txHash);
    tx = await getProvider().getTransaction(txHash);
    if (!receipt || !tx) return;
  } catch { return; }

  let tokenAmount = null, ethValue = null, methodUsed = null;

  if (tx.value && tx.value > 0n) {
    tokenAmount = parseFloat(ethers.formatEther(tx.value));
    ethValue = tokenAmount;
    methodUsed = '🟦 ETH';
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
            methodUsed = `🟨 ${mint_token_symbol}`;
            break;
          }
        } catch {}
      }
    }
  }

  if (!tokenAmount || !ethValue) return;

  const embed = {
    title: `💸 NFT SOLD – ${name} #${tokenId}`,
    description: `Token \`#${tokenId}\` just sold!`,
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

  for (const id of channel_ids) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

module.exports = {
  trackAllContracts,
  contractListeners
};

















