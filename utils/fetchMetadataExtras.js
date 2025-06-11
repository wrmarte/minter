require('dotenv').config();
const fetch = require('node-fetch');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;


async function fetchMetadataExtras(contractAddress, tokenId, network = 'base') {
  let rank = 'N/A';
  let minted = 'Unknown';
  let totalSupply = 'Unknown';

  const normalizedTokenId = BigInt(tokenId).toString();

  const networkMap = {
    base: {
      chainId: '0x2105',
      api: 'https://api.basescan.org/api',
      scanKey: process.env.BASESCAN_API_KEY
    },
    eth: {
      chainId: '0x1',
      api: 'https://api.etherscan.io/api',
      scanKey: process.env.ETHERSCAN_API_KEY
    },
    ape: {
      chainId: '0x1252',
      api: 'https://api.apescan.dev/api',
      scanKey: process.env.APESCAN_API_KEY
    }
  };

  const net = networkMap[network.toLowerCase()] || networkMap.base;

  try {
    const scanUrl = `${net.api}?module=account&action=tokennfttx&contractaddress=${contractAddress}&tokenid=${normalizedTokenId}&page=1&offset=1&sort=asc&apikey=${net.scanKey}`;
    const res = await fetch(scanUrl);
    const json = await res.json();
    console.log('📦 BaseScan token tx:', json);
    if (json?.result?.[0]?.timeStamp) {
      const timestamp = parseInt(json.result[0].timeStamp) * 1000;
      minted = new Date(timestamp).toLocaleDateString('en-US');
    }
  } catch (e) {
    console.warn('⚠️ Scan fetch failed, trying Moralis...');
  }

  if (minted === 'Unknown') {
    try {
      const url = `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${normalizedTokenId}/transfers?chain=${network}`;
      const res = await fetch(url, {
        headers: { 'X-API-Key': MORALIS_API_KEY }
      });
      const json = await res.json();
      console.log('📦 Moralis token transfer response:', json);
      if (json?.result?.length > 0) {
        const timestamp = new Date(json.result[json.result.length - 1].block_timestamp);
        minted = timestamp.toLocaleDateString('en-US');
      }
    } catch (err) {
      console.error('❌ Moralis mint fetch failed:', err);
    }
  }

  return {
    rank,
    minted,
    network: network.toUpperCase(),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };


