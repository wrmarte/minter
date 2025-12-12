const { Interface, Contract, ZeroAddress, id, formatUnits, ethers } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./provider');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');

// Routers for token buys
const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

const ROUTERS_SET = new Set(ROUTERS.map(a => a.toLowerCase()));
const SWAP_TOPIC_V2 = id('Swap(address,uint256,uint256,uint256,uint256,address)');
const SWAP_TOPIC_V3 = id('Swap(address,address,int256,int256,uint160,uint128,int24)');

const seenTx = new Set();  // shared between token sales

// Process NFT contracts
async function processContracts(client, fromBlock, toBlock) {
  const pg = client.pg;
  const res = await pg.query('SELECT * FROM contract_watchlist');
  for (const contractRow of res.rows) {
    await processContract(client, contractRow, fromBlock, toBlock);
  }
}

async function processContract(client, contractRow, fromBlock, toBlock) {
  const { name, address, mint_price, mint_token, mint_token_symbol, channel_ids } = contractRow;

  const abi = [
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ];
  const iface = new Interface(abi);
  const contract = new Contract(address, abi, getProvider());

  let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
  let seenSales = new Set(loadJson(seenSalesPath(name)) || []);

  let logs = [];
  try {
    logs = await fetchLogs(address, fromBlock, toBlock, id('Transfer(address,address,uint256)'));
  } catch (err) {
    console.warn(`⚠️ fetchLogs contract failed: ${err.message}`);
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

      let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
      try {
        let uri = await contract.tokenURI(tokenId);
        if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
        const meta = await fetch(uri).then(res => res.json());
        if (meta?.image) {
          imageUrl = meta.image.startsWith('ipfs://') ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/') : meta.image;
        }
      } catch {}

      newMints.push({ tokenId, imageUrl, to, tokenAmount: mint_price });
    } else {
      if (seenSales.has(tokenIdStr)) continue;
      seenSales.add(tokenIdStr);
      newSales.push({ tokenId, from, to, transactionHash: log.transactionHash });
    }
  }

  // You can drop your embed logic here exactly as we had before for mints + sales

  // Persist seen every 10 blocks
  if (toBlock % 10 === 0) {
    saveJson(seenPath(name), [...seenTokenIds]);
    saveJson(seenSalesPath(name), [...seenSales]);
  }
}

// Process token sales
async function processTokenBuys(client, fromBlock, toBlock) {
  const pg = client.pg;
  const res = await pg.query('SELECT * FROM tracked_tokens');
  const tracked = res.rows;
  const addressMap = new Map();

  for (const token of tracked) {
    const addr = token.address.toLowerCase();
    if (!addressMap.has(addr)) {
      addressMap.set(addr, []);
    }
    addressMap.get(addr).push(token);
  }

  for (const [address, tokenGroup] of addressMap.entries()) {
    const transferTopic = id('Transfer(address,address,uint256)');

    let logs = [];
    try {
      logs = await fetchLogs(address, fromBlock, toBlock, transferTopic);
    } catch (err) {
      console.warn(`⚠️ fetchLogs token failed: ${err.message}`);
      return;
    }

    for (const log of logs) {
      if (seenTx.has(log.transactionHash)) continue;
      seenTx.add(log.transactionHash);

      let parsed;
      try { 
        parsed = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']).parseLog(log); 
      } catch { continue; }

      const { from, to, amount } = parsed.args;
      const fromAddr = from.toLowerCase();
      if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') continue;

      let isBuy = ROUTERS_SET.has(fromAddr);
      if (!isBuy) {
        try {
          // inspect receipt
          const receipt = await getProvider().getTransactionReceipt(log.transactionHash);
          if (receipt && receipt.logs) {
            for (const lg of receipt.logs) {
              const lgAddr = (lg.address || '').toLowerCase();
              if (ROUTERS_SET.has(lgAddr)) {
                isBuy = true;
                break;
              }
              if (lg.topics && lg.topics.length > 0) {
                const t0 = lg.topics[0];
                if (t0 === SWAP_TOPIC_V2 || t0 === SWAP_TOPIC_V3) {
                  isBuy = true;
                  break;
                }
              }
            }
          }
        } catch {}
      }

      if (!isBuy) continue;

      const tokenAmountRaw = parseFloat(formatUnits(amount, 18));

      const tokenPrice = await getTokenPriceUSD(address);
      const marketCap = await getMarketCapUSD(address);

      let usdSpent = 0, ethSpent = 0;
      try {
        const tx = await getProvider().getTransaction(log.transactionHash);
        const ethPrice = await getETHPrice();
        if (tx?.value && tx.value > 0n) {
          ethSpent = parseFloat(formatUnits(tx.value, 18));
          usdSpent = ethSpent * ethPrice;
        } else {
          // fallback: approx USD as tokenAmount * tokenPrice
          usdSpent = tokenAmountRaw * tokenPrice;
          ethSpent = 0;
        }
      } catch {}

      for (const token of tokenGroup) {
        const guild = client.guilds.cache.get(token.guild_id);
        if (!guild) continue;

        let channel = null;
        if (token.channel_id) {
          channel = guild.channels.cache.get(token.channel_id);
        }
        if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
          channel = guild.channels.cache.find(c =>
            c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages')
          );
        }

        if (channel) {
          const embed = generateTokenEmbed(token.name, usdSpent, ethSpent, tokenAmountRaw, tokenPrice, marketCap, address);
          await channel.send({ embeds: [embed] });
        }
      }
    }
  }
}

// Build token sale embed (can polish further)
function generateTokenEmbed(name, usd, eth, amount, price, mcap, address) {
  const { EmbedBuilder } = require('discord.js');

  return new EmbedBuilder()
    .setTitle(`${name.toUpperCase()} Buy!`)
    .addFields(
      { name: '💸 Spent', value: `$${usd.toFixed(4)} / ${eth.toFixed(4)} ETH`, inline: true },
      { name: '🎯 Got', value: `${amount.toFixed(2)} ${name.toUpperCase()}`, inline: true },
      { name: '💵 Price', value: `$${price.toFixed(8)}`, inline: true },
      { name: '📊 MCap', value: mcap ? `$${mcap.toLocaleString()}` : 'Fetching...', inline: true }
    )
    .setURL(`https://www.geckoterminal.com/base/pools/${address}`)
    .setColor(0x00cc66)
    .setFooter({ text: 'Live on Base • Powered by PimpsDev' })
    .setTimestamp();
}

async function getETHPrice() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    return parseFloat(data?.ethereum?.usd || '0');
  } catch { return 0; }
}

async function getTokenPriceUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${address}`);
    const data = await res.json();
    const prices = data?.data?.attributes?.token_prices || {};
    return parseFloat(prices[address.toLowerCase()] || '0');
  } catch { return 0; }
}

async function getMarketCapUSD(address) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${address}`);
    const data = await res.json();
    return parseFloat(data?.data?.attributes?.fdv_usd || data?.data?.attributes?.market_cap_usd || '0');
  } catch { return 0; }
}

module.exports = { processContracts, processTokenBuys };

