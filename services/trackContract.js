const { Contract, ZeroAddress, id, Interface, ethers } = require('ethers');
const fetch = require('node-fetch');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { TOKEN_NAME_TO_ADDRESS, FALLBACK_PRICES } = require('../utils/constants');
const { shortWalletLink } = require('../utils/helpers');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('../utils/pricing');

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p)); } catch { return null; }
}
function saveJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data));
}
function seenPath(name) {
  return path.join(__dirname, `../../seen_${name}.json`);
}
function salesPath(name) {
  return path.join(__dirname, `../../sales_${name}.json`);
}

module.exports = async function trackContract({ name, address, mint_price, mint_token, mint_token_symbol, channel_ids }) {
  const abi = [
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ];
  const iface = new Interface(abi);
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contract = new Contract(address, abi, provider);

  let seenMints = new Set(loadJson(seenPath(name)) || []);
  let seenSales = new Set(loadJson(salesPath(name)) || []);

  provider.on('block', async (blockNumber) => {
    let logs;
    try {
      logs = await provider.getLogs({
        fromBlock: blockNumber - 1,
        toBlock: blockNumber,
        address,
        topics: [id('Transfer(address,address,uint256)')]
      });
    } catch {
      return;
    }

    const mints = [], sales = [];

    for (const log of logs) {
      let parsed;
      try { parsed = iface.parseLog(log); } catch { continue; }

      const { from, to, tokenId } = parsed.args;
      const idStr = tokenId.toString();

      if (from === ZeroAddress) {
        if (seenMints.has(idStr)) continue;
        seenMints.add(idStr);

        let image = 'https://via.placeholder.com/400x400?text=MINT';
        try {
          let uri = await contract.tokenURI(tokenId);
          if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
          const meta = await fetch(uri).then(r => r.json());
          if (meta?.image) {
            image = meta.image.startsWith('ipfs://')
              ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
              : meta.image;
          }
        } catch {}

        mints.push({ tokenId, to, image });
      } else {
        if (seenSales.has(idStr)) continue;
        seenSales.add(idStr);
        sales.push({ tokenId, from, to, txHash: log.transactionHash });
      }
    }

    if (mints.length) {
      const total = mint_price * mints.length;
      const tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()] || mint_token;

      let ethValue = await getRealDexPriceForToken(total, tokenAddr);
      if (!ethValue) {
        const fallback = await getEthPriceFromToken(tokenAddr);
        ethValue = fallback ? fallback * total : null;
      }

      const embed = new EmbedBuilder()
        .setTitle(`✨ NEW ${name.toUpperCase()} MINTS!`)
        .setDescription(`Minted by: ${shortWalletLink(mints[0].to)}`)
        .addFields(
          { name: '🆔 Token IDs', value: mints.map(m => `#${m.tokenId}`).join(', ') },
          { name: `💰 Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
          { name: '⇄ ETH Value', value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true },
          { name: '🔢 Total Minted', value: `${mints.length}`, inline: true }
        )
        .setThumbnail(mints[0].image)
        .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
        .setTimestamp()
        .setColor(0x33ccff);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setLabel('🔗 View on OpenSea')
          .setStyle(ButtonStyle.Link)
          .setURL(`https://opensea.io/assets/base/${address}/${mints[0].tokenId}`)
      );

      for (const id of channel_ids) {
        try {
          const ch = await provider._client.channels.fetch(id);
          await ch.send({ embeds: [embed], components: [row] });
        } catch (e) {
          console.warn(`❌ Failed to send to ${id}: ${e.message}`);
        }
      }
    }

    // === SALE EMBEDS ===
    for (const sale of sales) {
      let image = 'https://via.placeholder.com/400x400?text=SOLD';
      let tokenAmount = null;
      let ethValue = null;
      let methodUsed = null;

      try {
        let uri = await contract.tokenURI(sale.tokenId);
        if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        const meta = await fetch(uri).then(r => r.json());
        if (meta?.image) {
          image = meta.image.startsWith('ipfs://')
            ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
            : meta.image;
        }
      } catch {}

      let tx, receipt;
      try {
        tx = await provider.getTransaction(sale.txHash);
        receipt = await provider.getTransactionReceipt(sale.txHash);
      } catch {}

      if (tx?.value && tx.value > 0n) {
        tokenAmount = parseFloat(ethers.formatEther(tx.value));
        ethValue = tokenAmount;
        methodUsed = '🟦 ETH';
      }

      if (!ethValue && receipt) {
        const transferTopic = id('Transfer(address,address,uint256)');
        for (const log of receipt.logs) {
          if (log.topics[0] === transferTopic && log.address !== address) {
            try {
              const to = ethers.getAddress('0x' + log.topics[2].slice(26));
              if (to.toLowerCase() === sale.from.toLowerCase()) {
                const tokenContract = log.address;
                tokenAmount = parseFloat(ethers.formatUnits(log.data, 18));
                ethValue = await getRealDexPriceForToken(tokenAmount, tokenContract);
                if (!ethValue) {
                  const fallback = await getEthPriceFromToken(tokenContract);
                  ethValue = fallback ? tokenAmount * fallback : null;
                }
                methodUsed = '🟨 Token';
                break;
              }
            } catch {}
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
        .setThumbnail(image)
        .setURL(`https://opensea.io/assets/base/${address}/${sale.tokenId}`)
        .setFooter({ text: 'Powered by PimpsDev' })
        .setColor(0x66cc66)
        .setTimestamp();

      for (const id of channel_ids) {
        try {
          const ch = await provider._client.channels.fetch(id);
          await ch.send({ embeds: [embed] });
        } catch (e) {
          console.warn(`❌ Failed to send sale alert to ${id}: ${e.message}`);
        }
      }
    }

    saveJson(seenPath(name), [...seenMints]);
    saveJson(salesPath(name), [...seenSales]);
  });
};

