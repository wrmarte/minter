const { Interface, Contract, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('./providerM');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const delay = ms => new Promise(res => setTimeout(res, ms));

const contractListeners = {};

async function trackApeContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'ape'");
  const contracts = res.rows;
  setupApeBlockListener(client, contracts);
}

function setupApeBlockListener(client, contractRows) {
  const provider = getProvider('ape');
  if (provider._global_block_listener_ape) return;
  provider._global_block_listener_ape = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const globalSeenSales = new Set();

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

        await delay(200);

        let logs;
        try {
          logs = await provider.getLogs(filter);
        } catch (err) {
          if (err.message.includes('batch') || err.message.includes('429')) return;
          console.warn(`[${name}] Ape log fetch error: ${err.message}`);
          return;
        }

        const contract = new Contract(address, iface.fragments, provider);
        let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
        let seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => tx.toLowerCase()));

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
              if (ch?.guildId) allGuildIds.push(ch.guildId);
            } catch {}
          }

          if (from === ZeroAddress) {
            if (seenTokenIds.has(tokenIdStr)) continue;
            seenTokenIds.add(tokenIdStr);

            const dedupeMints = new Set();
            for (const gid of allGuildIds) {
              const mintKey = `${gid}-${tokenIdStr}`;
              if (dedupeMints.has(mintKey)) continue;
              dedupeMints.add(mintKey);
              await handleMint(client, row, contract, tokenId, to, allChannelIds);
              break;
            }
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

        saveJson(seenPath(name), [...seenTokenIds]);
        saveJson(seenSalesPath(name), [...seenSales]);
      } catch (err) {
        console.warn(`[${row.name}] Ape block error: ${err.message}`);
      }
    }
  });
}

async function handleMint(client, contractRow, contract, tokenId, to, channel_ids) {
  const { name } = contractRow;

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  const embed = {
    title: `🦍 New ${name.toUpperCase()} Mint!`,
    description: `Minted by: ${shortWalletLink(to)}\nToken #${tokenId}`,
    thumbnail: { url: imageUrl },
    color: 0x9966ff,
    footer: { text: 'Live on ApeChain • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const id of [...new Set(channel_ids)]) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids) {
  const { name, address } = contractRow;

  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  const magicEdenUrl = `https://magiceden.io/item-details/apechain:${address}:${tokenId}`;

  const embed = {
    title: `💸 ${name} #${tokenId} SOLD`,
    url: magicEdenUrl,
    description: `Token \`#${tokenId}\` just sold!`,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: `N/A`, inline: true },
      { name: `💳 Method`, value: 'ApeChain', inline: true }
    ],
    thumbnail: { url: imageUrl },
    color: 0x33ff99,
    footer: { text: 'Live on ApeChain • Powered by PimpsDev' },
    timestamp: new Date().toISOString()
  };

  for (const id of channel_ids) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

module.exports = {
  trackApeContracts,
  contractListeners
};
