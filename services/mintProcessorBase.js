// ✅ ERC721-only mint processor with dynamic token amount detection
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

  const globalSeenSales = new Set();
  const globalSeenMints = new Set();

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

      const allChannelIds = [...new Set([...(row.channel_ids || [])])];
      const allGuildIds = [];
      for (const id of allChannelIds) {
        try {
          const ch = await client.channels.fetch(id);
          if (ch.guildId) allGuildIds.push(ch.guildId);
        } catch {}
      }

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
          let shouldSend = false;
          for (const gid of allGuildIds) {
            const dedupeKey = `${gid}-${mintKey}`;
            if (globalSeenMints.has(dedupeKey)) continue;
            globalSeenMints.add(dedupeKey);
            shouldSend = true;
          }
          if (!shouldSend || seenTokenIds.has(tokenIdStr)) continue;
          seenTokenIds.add(tokenIdStr);

          if (!mintTxMap.has(txHash)) mintTxMap.set(txHash, { row, contract, tokenIds: new Set(), to });
          mintTxMap.get(txHash).tokenIds.add(tokenIdStr);

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
          await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds);
          saveJson(seenSalesPath(name), [...seenSales]);
        }
      }
    }

    for (const [txHash, { row, contract, tokenIds, to }] of mintTxMap.entries()) {
      if (!txHash) continue;
      const tokenIdArray = Array.from(tokenIds);
      if (tokenIdArray.length === 1) {
        await handleMintSingle(client, row, contract, tokenIdArray[0], txHash, row.channel_ids, to);
      } else {
        await handleMintBulk(client, row, contract, tokenIdArray, txHash, row.channel_ids, false, to);
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

  // ✅ Fixed: Look for token spent by buyer
  let tokenAmount = null;
  const buyer = ethers.getAddress(minterAddress);
  for (const log of receipt.logs) {
    if (log.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
      const from = '0x' + log.topics[1].slice(26);
      const to = '0x' + log.topics[2].slice(26);

      // Check if buyer sent token from their wallet
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

  let ethValue = tokenAmount ? await getRealDexPriceForToken(tokenAmount, tokenAddr) : null;
  if (!ethValue && tokenAmount) {
    const fallback = await getEthPriceFromToken(tokenAddr);
    ethValue = fallback ? tokenAmount * fallback : null;
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
  // [leave your existing handleSale as is — it's already working]
}

module.exports = {
  trackBaseContracts,
  contractListeners
};

