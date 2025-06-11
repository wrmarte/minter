// fetchMetadataExtras.js
require('dotenv').config();
const fetch = require('node-fetch');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const BASESCAN_API_KEY = process.env.BASESCAN_API_KEY;

async function fetchMetadataExtras(contractAddress, tokenId, network = 'base') {
  let mintedDate = 'Unknown';
  let rank = 'N/A';
  let totalSupply = 'Unknown';
  const upperNetwork = network.toUpperCase();

  try {
    // 1. Get mint date via BaseScan API (only if Base)
    if (network === 'base' && BASESCAN_API_KEY) {
      const scanRes = await fetch(`https://api.basescan.org/api?module=account&action=tokennfttx&contractaddress=${contractAddress}&apikey=${BASESCAN_API_KEY}`);
      const scanData = await scanRes.json();
      const tx = scanData.result.find(tx => tx.tokenID === String(tokenId) && tx.from === '0x0000000000000000000000000000000000000000');

      if (tx && tx.timeStamp) {
        mintedDate = new Date(parseInt(tx.timeStamp) * 1000).toLocaleDateString('en-US', {
          year: 'numeric', month: 'short', day: 'numeric'
        });
      }
    }

    // 2. Get total supply + rank via Moralis
    if (MORALIS_API_KEY) {
      const url = `https://deep-index.moralis.io/api/v2.2/nft/${contractAddress}/${tokenId}?chain=${network}&normalizeMetadata=true`;
      const res = await fetch(url, {
        headers: {
          'X-API-Key': MORALIS_API_KEY
        }
      });

      if (res.ok) {
        const json = await res.json();
        totalSupply = json.total_supply || 'Unknown';
        rank = json?.rarity?.rank ? `#${json.rarity.rank}` : 'N/A';
      }
    }
  } catch (e) {
    console.error('⚠️ Metadata extras fetch failed:', e.message);
  }

  return {
    mintedDate,
    rank,
    network: upperNetwork,
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };



