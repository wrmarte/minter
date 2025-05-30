const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { JsonRpcProvider, Contract, Interface, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const path = require('path');
const { getEthPriceFromToken, getRealDexPriceForToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');

const rpcUrls = [
  'https://mainnet.base.org',
  'https://developer-access-mainnet.base.org',
  'https://base.blockpi.network/v1/rpc/public'
];

let provider;

(async () => {
  for (const url of rpcUrls) {
    try {
      const temp = new JsonRpcProvider(url);
      await temp.getBlockNumber();
      provider = temp;
      console.log(`✅ Connected to RPC: ${url}`);
      break;
    } catch {
      console.warn(`⚠️ Failed RPC: ${url}`);
    }
  }
  if (!provider) throw new Error('❌ All RPCs failed');
})();

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

// Dynamically assign WETH per network
const WETH_BY_NETWORK = {
  base: '0x4200000000000000000000000000000000000006',
  eth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
};

// Fetch metadata image (cached in memory to speed up)
const tokenUriCache = {};
async function fetchTokenImage(contract, tokenId) {
  const cacheKey = `${contract.address}-${tokenId}`;
  if (tokenUriCache[cacheKey]) return tokenUriCache[cacheKey];

  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    let imageUrl = meta?.image || 'https://via.placeholder.com/400x400.png?text=NFT';
    if (imageUrl.startsWith('ipfs://')) imageUrl = imageUrl.replace('ipfs://', 'https://ipfs.io/ipfs/');
    tokenUriCache[cacheKey] = imageUrl;
    return imageUrl;
  } catch {
    return 'https://via.placeholder.com/400x400.png?text=NFT';
  }
}

// Send embeds safely across servers
async function sendToUniqueGuilds(channel_ids, embed, row = null, client) {
  const sentChannels = new Set();
  for (const id of channel_ids) {
    if (sentChannels.has(id)) continue;
    try {
      const ch = await client.channels.fetch(id);
      if (!ch?.send) continue;
      await ch.send({ embeds: [embed], components: row ? [row] : [] });
      sentChannels.add(id);
    } catch (err) {
      console.warn(`❌ Failed to send to channel ${id}: ${err.message}`);
    }
  }
}

async function trackAllContracts(client, contractRow) {
  const { name, address, mint_price, mint_token, mint_token_symbol, channel_ids, network } = contractRow;

  const WETH_ADDRESS = WETH_BY_NETWORK[network];

  const abi = [
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ];
  const iface = new Interface(abi);
  const contract = new Contract(address, abi, provider);

  let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
  let seenSales = new Set(loadJson(seenSalesPath(name)) || []);

  provider.on('block', async (blockNumber) => {
    const fromBlock = blockNumber - 1;
    const toBlock = blockNumber;

    let logs;
    try {
      logs = await provider.getLogs({
        fromBlock,
        toBlock,
        address,
        topics: [id('Transfer(address,address,uint256)')]
      });
    } catch (err) {
      console.warn(`⚠️ getLogs failed: ${err.message}`);
      return;
    }

    const newMints = [];
    const newSales = [];

    for (const log of logs) {
      let parsed;
      try { parsed = iface.parseLog(log); } catch { continue; }

      const { from, to, tokenId } = parsed.args;
      const tokenIdStr = tokenId.toString();

      if (from === ZeroAddress) {
        if (seenTokenIds.has(tokenIdStr)) continue;
        seenTokenIds.add(tokenIdStr);
        const imageUrl = await fetchTokenImage(contract, tokenId);
        newMints.push({ tokenId, imageUrl, to, tokenAmount: mint_price });
      } else {
        if (seenSales.has(tokenIdStr)) continue;
        seenSales.add(tokenIdStr);
        newSales.push({ tokenId, from, to, transactionHash: log.transactionHash });
      }
    }

    if (newMints.length) {
      const total = newMints.reduce((sum, m) => sum + Number(m.tokenAmount), 0);
      let tokenAddr = mint_token.toLowerCase();
      if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()]) {
        tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()].toLowerCase();
      }

      let ethValue = await getRealDexPriceForToken(total, tokenAddr);
      if (!ethValue) {
        const fallback = await getEthPriceFromToken(tokenAddr);
        ethValue = fallback ? total * fallback : null;
      }

      const embed = new EmbedBuilder()
        .setTitle(`✨ NEW ${name.toUpperCase()} MINTS!`)
        .setDescription(`Minted by: ${shortWalletLink(newMints[0].to)}`)
        .addFields(
          { name: '🆔 Token IDs', value: newMints.map(m => `#${m.tokenId}`).join(', '), inline: false },
          { name: `💰 Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
          { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🔢 Total Minted', value: `${newMints.length}`, inline: true }
        )
        .setThumbnail(newMints[0].imageUrl)
        .setColor(219139)
        .setFooter({ text: `Live on ${network.toUpperCase()} • Powered by PimpsDev` })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 View on OpenSea')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://opensea.io/assets/${network === 'base' ? 'base' : 'ethereum'}/${address}/${newMints[0].tokenId}`)
      );

      await sendToUniqueGuilds(channel_ids, embed, row, client);
    }

    for (const sale of newSales) {
      const imageUrl = await fetchTokenImage(contract, sale.tokenId);
      let tokenAmount = null, ethValue = null, methodUsed = null;
      let receipt, tx;

      try {
        receipt = await provider.getTransactionReceipt(sale.transactionHash);
        tx = await provider.getTransaction(sale.transactionHash);
        if (!receipt || !tx) continue;
      } catch { continue; }

      // ETH sale detection
      if (tx.value && tx.value > 0n) {
        tokenAmount = parseFloat(ethers.formatEther(tx.value));
        ethValue = tokenAmount;
        methodUsed = '🟦 ETH';
      }

      // Token sale detection
      if (!ethValue) {
        for (const log of receipt.logs) {
          if (log.address !== address && log.topics[0] === id('Transfer(address,address,uint256)')) {
            const seller = ethers.getAddress(sale.from);
            const to = ethers.getAddress('0x' + log.topics[2].slice(26));
            if (to.toLowerCase() === seller.toLowerCase()) {
              const tokenContract = log.address;
              tokenAmount = parseFloat(ethers.formatUnits(log.data, 18));
              ethValue = await getRealDexPriceForToken(tokenAmount, tokenContract)
                || (await getEthPriceFromToken(tokenContract)) * tokenAmount;
              methodUsed = `🟨 ${mint_token_symbol}`;
              break;
            }
          }
        }
      }

      // WETH Offer detection (finally fixed!)
      if (!ethValue) {
        for (const log of receipt.logs) {
          if (log.address.toLowerCase() === WETH_ADDRESS.toLowerCase() && log.topics[0] === id('Transfer(address,address,uint256)')) {
            const wethAmount = parseFloat(ethers.formatUnits(log.data, 18));
            const toAddr = '0x' + log.topics[2].slice(26);
            if (toAddr.toLowerCase() === sale.from.toLowerCase()) {
              tokenAmount = wethAmount;
              ethValue = wethAmount;
              methodUsed = '🟧 WETH Offer';
              break;
            }
          }
        }
      }

      if (!tokenAmount || !ethValue) continue;

      const embed = new EmbedBuilder()
        .setTitle(`💸 NFT SOLD – ${name} #${sale.tokenId}`)
        .setDescription(`Token \`#${sale.tokenId}\` just sold!`)
        .addFields(
          { name: '👤 Seller', value: shortWalletLink(sale.from), inline: true },
          { name: '🧑‍💻 Buyer', value: shortWalletLink(sale.to), inline: true },
          { name: `💰 Paid`, value: `${tokenAmount.toFixed(4)}`, inline: true },
          { name: `⇄ ETH Value`, value: `${ethValue.toFixed(4)} ETH`, inline: true },
          { name: `💳 Method`, value: methodUsed || 'Unknown', inline: true }
        )
        .setURL(`https://opensea.io/assets/${network === 'base' ? 'base' : 'ethereum'}/${address}/${sale.tokenId}`)
        .setThumbnail(imageUrl)
        .setColor(0x66cc66)
        .setFooter({ text: `Live on ${network.toUpperCase()} • Powered by PimpsDev` })
        .setTimestamp();

      await sendToUniqueGuilds(channel_ids, embed, null, client);
    }

    if (blockNumber % 10 === 0) {
      saveJson(seenPath(name), [...seenTokenIds]);
      saveJson(seenSalesPath(name), [...seenSales]);
    }
  });
}

module.exports = { trackAllContracts };



