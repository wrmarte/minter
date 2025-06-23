const { Interface, Contract, id, ZeroAddress } = require('ethers');
const fetch = require('node-fetch');
const { safeRpcCall } = require('../services/providerM');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');
const delay = ms => new Promise(res => setTimeout(res, ms));

const ROUTERS = [
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d' // ✅ Magic Eden Router (ApeChain)
];

const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
const contractListeners = {};

async function trackApeContracts(client) {
  const pg = client.pg;
  const res = await pg.query("SELECT * FROM contract_watchlist WHERE chain = 'ape'");
  const contracts = res.rows;
  setupApeBlockListener(client, contracts);
}

function setupApeBlockListener(client, contractRows) {
  if (global._ape_block_listener) return;
  global._ape_block_listener = true;

  const iface = new Interface([
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ]);

  const globalSeenSales = new Set();

  setInterval(async () => {
    const block = await safeRpcCall('ape', p => p.getBlockNumber());
    const fromBlock = Math.max(block - 3, 0);
    const toBlock = block;

    for (const row of contractRows) {
      const name = row.name;
      const address = row.address.toLowerCase();

      const filter = {
        address,
        topics: [id('Transfer(address,address,uint256)')],
        fromBlock,
        toBlock
      };

      await delay(200);

      let logs = [];
      try {
        logs = await safeRpcCall('ape', p => p.getLogs(filter));
      } catch (err) {
        console.warn(`[${name}] Ape log fetch error: ${err.message}`);
        continue;
      }

      const provider = require('../services/providerM').getProvider('ape');
      const contract = new Contract(address, iface.fragments, provider);

      const seenTokenIds = new Set(loadJson(seenPath(name)) || []);
      const seenSales = new Set((loadJson(seenSalesPath(name)) || []).map(tx => tx.toLowerCase()));

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch {
          continue;
        }

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

        const isMint = from === ZeroAddress;
        const isDeadTransfer = from.toLowerCase() === DEAD_ADDRESS;

        if (isMint) {
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
        }

        if (!isMint || isDeadTransfer) {
          let tx;
          let tokenPayment = null;
          try {
            tx = await safeRpcCall('ape', p => p.getTransaction(txHash));
            const receipt = await safeRpcCall('ape', p => p.getTransactionReceipt(txHash));
            const toAddr = tx?.to?.toLowerCase?.();
            const isNativeSale = ROUTERS.includes(toAddr);
            let isTokenSale = false;

            for (const log of receipt.logs) {
              try {
                const parsedLog = new Interface([
                  'event Transfer(address indexed from, address indexed to, uint256 value)'
                ]).parseLog(log);

                const fromLog = parsedLog.args.from?.toLowerCase?.();
                const toLog = parsedLog.args.to?.toLowerCase?.();

                if (
                  ROUTERS.includes(toLog) ||
                  toLog === from.toLowerCase() ||
                  toLog === toAddr
                ) {
                  isTokenSale = true;

                  try {
                    const tokenContract = new Contract(log.address, [
                      'function symbol() view returns (string)',
                      'function decimals() view returns (uint8)'
                    ], provider);

                    const symbol = await tokenContract.symbol();
                    const decimals = await tokenContract.decimals();
                    const amount = parseFloat(parsedLog.args.value.toString()) / 10 ** decimals;
                    tokenPayment = `${amount.toFixed(4)} ${symbol}`;
                    console.log(`[${name}] ✅ Token sale detected: ${tokenPayment}`);
                  } catch {
                    const amount = parseFloat(parsedLog.args.value.toString()) / 1e18;
                    tokenPayment = `${amount.toFixed(4)} TOKEN`;
                    console.log(`[${name}] ✅ Token fallback sale detected: ${tokenPayment}`);
                  }

                  break;
                }
              } catch {}
            }

            if (!isNativeSale && !tokenPayment && tx.value > 0) {
              tokenPayment = `${(parseFloat(tx.value.toString()) / 1e18).toFixed(4)} APE`;
              console.log(`[${name}] ✅ Native APE transfer detected: ${tokenPayment}`);
            }

            if (!isNativeSale && !tokenPayment) {
              console.log(`[${name}] ❌ Skipped non-sale tx: ${txHash}`);
              continue;
            }
          } catch (err) {
            console.warn(`[${name}] Tx fetch failed for ${txHash}: ${err.message}`);
            continue;
          }

          let shouldSend = false;
          for (const gid of allGuildIds) {
            const dedupeKey = `${gid}-${txHash}`;
            if (globalSeenSales.has(dedupeKey)) continue;
            globalSeenSales.add(dedupeKey);
            shouldSend = true;
          }

          if (!shouldSend || seenSales.has(txHash)) {
            console.log(`[${name}] Skipped sale emit (seen or deduped): ${txHash}`);
            continue;
          }

          seenSales.add(txHash);
          await handleSale(client, row, contract, tokenId, from, to, txHash, allChannelIds, tokenPayment);
        }
      }

      saveJson(seenPath(name), [...seenTokenIds]);
      saveJson(seenSalesPath(name), [...seenSales]);
    }
  }, 12000);
}
async function handleMint(client, contractRow, contract, tokenId, to, channel_ids) {
  const { name, address } = contractRow;
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
  const magicEdenUrl = `https://magiceden.us/item-details/apechain/${address}/${tokenId}`;

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
    timestamp: new Date().toISOString(),
    url: magicEdenUrl
  };

  for (const id of [...new Set(channel_ids)]) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
  }
}

async function handleSale(client, contractRow, contract, tokenId, from, to, txHash, channel_ids, tokenPayment = null) {
  const { name, address } = contractRow;
  let imageUrl = 'https://via.placeholder.com/400x400.png?text=SOLD';
  const magicEdenUrl = `https://magiceden.us/item-details/apechain/${address}/${tokenId}`;

  try {
    let uri = await contract.tokenURI(tokenId);
    if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
    const meta = await fetch(uri).then(res => res.json());
    if (meta?.image) {
      imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
    }
  } catch {}

  let pricePaid = tokenPayment || 'N/A';
  if (!tokenPayment) {
    try {
      const tx = await safeRpcCall('ape', p => p.getTransaction(txHash));
      const paidEth = parseFloat(tx.value.toString()) / 1e18;
      if (paidEth > 0) {
        pricePaid = `${paidEth.toFixed(4)} APE`;
      }
    } catch (err) {
      console.warn(`⚠️ Could not fetch tx value for ${txHash}: ${err.message}`);
    }
  }

  const embed = {
    title: `💸 ${name} #${tokenId} SOLD`,
    description: `Token \`#${tokenId}\` just sold!`,
    url: magicEdenUrl,
    fields: [
      { name: '👤 Seller', value: shortWalletLink(from), inline: true },
      { name: '🧑‍💻 Buyer', value: shortWalletLink(to), inline: true },
      { name: `💰 Paid`, value: pricePaid, inline: true },
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


