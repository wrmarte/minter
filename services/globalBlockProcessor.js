const { Interface, Contract, id, ZeroAddress, formatUnits, ethers } = require('ethers');
const fetch = require('node-fetch');
const { fetchLogs } = require('./logScanner');
const { getProvider } = require('./provider');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { shortWalletLink, loadJson, saveJson, seenPath, seenSalesPath } = require('../utils/helpers');

const ROUTERS = [
  '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86',
  '0x420dd381b31aef6683e2c581f93b119eee7e3f4d',
  '0xfbeef911dc5821886e1dda23b3e4f3eaffdd7930',
  '0x812e79c9c37eD676fdbdd1212D6a4e47EFfC6a42',
  '0xa5e0829CaCEd8fFDD4De3c43696c57F7D7A678ff',
  '0x95ebfcb1c6b345fda69cf56c51e30421e5a35aec'
];

const seenTx = new Set();

module.exports = async function processUnifiedBlock(client, fromBlock, toBlock) {
  const pg = client.pg;

  const contractRes = await pg.query('SELECT * FROM contract_watchlist');
  const contractRows = contractRes.rows;

  const tokenRes = await pg.query('SELECT * FROM tracked_tokens');
  const tokenRows = tokenRes.rows;

  const addresses = [...new Set([...contractRows.map(row => row.address.toLowerCase()), ...tokenRows.map(row => row.address.toLowerCase())])];
  if (addresses.length === 0) {
    console.log('✅ No contracts or tokens to scan.');
    return;
  }

  let logs;
  try {
    logs = await fetchLogs(addresses, fromBlock, toBlock);
  } catch (err) {
    console.warn(`⚠️ Unified fetchLogs failed: ${err.message}`);
    return;
  }

  for (const log of logs) {
    const contractRow = contractRows.find(row => row.address.toLowerCase() === log.address.toLowerCase());
    if (contractRow) {
      await handleContractLog(client, contractRow, log);
      continue;
    }

    const tokenRowGroup = tokenRows.filter(row => row.address.toLowerCase() === log.address.toLowerCase());
    if (tokenRowGroup.length > 0) {
      await handleTokenLog(client, tokenRowGroup, log);
    }
  }
}

async function handleContractLog(client, contractRow, log) {
  const { name, address, channel_ids } = contractRow;
  const abi = ['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)', 'function tokenURI(uint256 tokenId) view returns (string)'];
  const iface = new Interface(abi);
  const contract = new Contract(address, abi, getProvider());

  let parsed;
  try {
    parsed = iface.parseLog(log);
  } catch {
    return; // skip invalid log safely
  }

  const { from, to, tokenId } = parsed.args;
  const tokenIdStr = tokenId.toString();

  let seenTokenIds = new Set(loadJson(seenPath(name)) || []);
  if (from === ZeroAddress) {
    if (seenTokenIds.has(tokenIdStr)) return;
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

    const embed = {
      title: `✨ NEW ${name.toUpperCase()} MINT!`,
      description: `Minted by: ${shortWalletLink(to)}\nToken #${tokenId}`,
      color: 219139,
      thumbnail: { url: imageUrl },
      footer: { text: 'Powered by PimpsDev' },
      timestamp: new Date().toISOString()
    };

    for (const id of channel_ids) {
      const ch = await client.channels.fetch(id).catch(() => null);
      if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
    }

    saveJson(seenPath(name), [...seenTokenIds]);
  }
}

async function handleTokenLog(client, tokenRowGroup, log) {
  const iface = new Interface(['event Transfer(address indexed from, address indexed to, uint amount)']);
  const parsed = iface.parseLog(log);
  const { from, to, amount } = parsed.args;
  const fromAddr = from.toLowerCase();

  if (!ROUTERS.includes(fromAddr)) return;
  if (to.toLowerCase() === '0x0000000000000000000000000000000000000000') return;
  if (seenTx.has(log.transactionHash)) return;
  seenTx.add(log.transactionHash);

  const tokenAmountRaw = parseFloat(formatUnits(amount, 18));
  const tokenAmountFormatted = (tokenAmountRaw * 1000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const tokenAddress = log.address.toLowerCase();
  const tokenPrice = await getTokenPriceUSD(tokenAddress);
  const marketCap = await getMarketCapUSD(tokenAddress);

  let usdSpent = 0, ethSpent = 0;
  try {
    const tx = await getProvider().getTransaction(log.transactionHash);
    const ethPrice = await getETHPrice();
    if (tx?.value) {
      ethSpent = parseFloat(formatUnits(tx.value, 18));
      usdSpent = ethSpent * ethPrice;
    }
  } catch {}

  const rocketIntensity = Math.min(Math.floor(tokenAmountRaw / 100), 10);
  const rocketLine = '🟥🟦🚀'.repeat(Math.max(1, rocketIntensity));
  const getColorByUsdSpent = (usd) => usd < 10 ? 0xff0000 : usd < 20 ? 0x3498db : 0x00cc66;

  for (const token of tokenRowGroup) {
    const guild = client.guilds.cache.get(token.guild_id);
    if (!guild) continue;
    let channel = token.channel_id ? guild.channels.cache.get(token.channel_id) : null;
    if (!channel || !channel.isTextBased() || !channel.permissionsFor(guild.members.me).has('SendMessages')) {
      channel = guild.channels.cache.find(c => c.isTextBased() && c.permissionsFor(guild.members.me).has('SendMessages'));
    }
    if (channel) {
      const embed = {
        title: `${token.name.toUpperCase()} Buy!`,
        description: rocketLine,
        image: { url: 'https://iili.io/3tSecKP.gif' },
        fields: [
          { name: '💸 Spent', value: `$${usdSpent.toFixed(4)} / ${ethSpent.toFixed(4)} ETH`, inline: true },
          { name: '🎯 Got', value: `${tokenAmountFormatted} ${token.name.toUpperCase()}`, inline: true },
          { name: '💵 Price', value: `$${tokenPrice.toFixed(8)}`, inline: true },
          { name: '📊 MCap', value: marketCap ? `$${marketCap.toLocaleString()}` : 'Fetching...', inline: true }
        ],
        url: `https://www.geckoterminal.com/base/pools/${tokenAddress}`,
        color: getColorByUsdSpent(usdSpent),
        footer: { text: 'Live on Base • Powered by PimpsDev' },
        timestamp: new Date().toISOString()
      };
      await channel.send({ embeds: [embed] }).catch(() => {});
    }
  }
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


