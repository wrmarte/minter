// fetchMetadataExtras.js
const fetch = require('node-fetch');
const { format } = require('date-fns');

const BASESCAN_API = process.env.BASESCAN_API_KEY;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;
const RESERVOIR_API_KEY = process.env.RESERVOIR_API_KEY;

async function fetchMintDate(contractAddress, tokenId, network) {
  if (network !== 'base') return 'Unknown';
  try {
    const url = `https://api.basescan.org/api?module=account&action=tokennfttx&contractaddress=${contractAddress}&sort=asc&apikey=${BASESCAN_API}`;
    const res = await fetch(url);
    const json = await res.json();

    console.log('📦 BaseScan TX Result:', json.result);

    const mintTx = json.result.find(tx =>
      tx.tokenID === tokenId.toString() &&
      tx.from.toLowerCase() === '0x0000000000000000000000000000000000000000'
    );

    if (mintTx?.timeStamp) {
      const timestamp = parseInt(mintTx.timeStamp) * 1000;
      return format(new Date(timestamp), 'yyyy-MM-dd HH:mm');
    } else {
      console.log(`⛔ No matching mint tx for tokenId ${tokenId}`);
    }
  } catch (err) {
    console.error('❌ Mint date fetch failed:', err);
  }
  return 'Unknown';
}

async function fetchRarityRankReservoir(contract, tokenId, network) {
  try {
    const chain = network === 'eth' ? 'ethereum' : network;
    const url = `https://api.reservoir.tools/tokens/v5?tokens=${chain}:${contract}:${tokenId}`;
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': RESERVOIR_API_KEY || ''
      }
    });
    const json = await res.json();

    console.log('🔎 Reservoir Rank Response:', JSON.stringify(json, null, 2));

    const rank = json?.tokens?.[0]?.token?.rarity?.rank;
    return rank ? `#${rank}` : 'N/A';
  } catch (err) {
    console.error('❌ Reservoir rank fetch failed:', err);
    return 'N/A';
  }
}

async function fetchRarityRankOpenSea(contract, tokenId, network) {
  try {
    const url = `https://api.opensea.io/api/v2/chain/${network}/contract/${contract}/nfts/${tokenId}`;
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': OPENSEA_API_KEY || ''
      }
    });
    const json = await res.json();

    console.log('🔍 OpenSea Rank Response:', JSON.stringify(json, null, 2));

    const rank = json?.rarity?.rank;
    return rank ? `#${rank}` : 'N/A';
  } catch (err) {
    console.error('❌ OpenSea rank fetch failed:', err);
    return 'N/A';
  }
}

async function fetchTotalSupply(contract, network) {
  try {
    const url = `https://api.reservoir.tools/collections/v5?id=${network === 'eth' ? 'ethereum' : network}:${contract}`;
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': RESERVOIR_API_KEY || ''
      }
    });
    const json = await res.json();

    const count = json?.collections?.[0]?.tokenCount;
    const isMinting = json?.collections?.[0]?.mintKind === 'public';

    return count ? `${count}${isMinting ? ' (Still Minting)' : ''}` : 'Unknown';
  } catch (err) {
    console.error('❌ Total supply fetch failed:', err);
    return 'Unknown';
  }
}

async function fetchMetadataExtras(contractAddress, tokenId, network) {
  tokenId = tokenId.toString(); // ✅ enforce string format

  const [minted, rankReservoir, rankOpenSea, totalSupply] = await Promise.all([
    fetchMintDate(contractAddress, tokenId, network),
    fetchRarityRankReservoir(contractAddress, tokenId, network),
    fetchRarityRankOpenSea(contractAddress, tokenId, network),
    fetchTotalSupply(contractAddress, network)
  ]);

  const rank = rankReservoir !== 'N/A' ? rankReservoir : rankOpenSea;

  return {
    minted,
    rank,
    network: network.toUpperCase(),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };




