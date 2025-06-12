// fetchMetadataExtras.js
const fetch = require('node-fetch');
const { format } = require('date-fns');

const BASESCAN_API = process.env.BASESCAN_API_KEY;
const RESERVOIR_API_KEY = process.env.RESERVOIR_API_KEY;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;

async function fetchMintDate(contractAddress, tokenId) {
  try {
    const url = `https://api.basescan.org/api?module=account&action=tokennfttx&contractaddress=${contractAddress}&sort=asc&apikey=${BASESCAN_API}`;
    const res = await fetch(url);
    const json = await res.json();

    if (!json.result || !Array.isArray(json.result)) {
      console.error('🛑 BaseScan result missing or invalid');
      return 'Unknown';
    }

    const mintTx = json.result.find(tx => {
      const isMint = tx.from?.toLowerCase() === '0x0000000000000000000000000000000000000000';
      const matchesToken = tx.tokenID?.toString() === tokenId.toString();
      return isMint && matchesToken;
    });

    if (mintTx && mintTx.timeStamp) {
      const timestamp = parseInt(mintTx.timeStamp) * 1000;
      return format(new Date(timestamp), 'yyyy-MM-dd HH:mm');
    }

    console.warn('🛑 Mint TX not found for tokenId', tokenId);
  } catch (err) {
    console.error('❌ Mint date fetch failed:', err);
  }
  return 'Unknown';
}

async function fetchRarityRankReservoir(contract, tokenId) {
  try {
    const url = `https://api.reservoir.tools/tokens/v5?tokens=${contract}:${tokenId}`;
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': RESERVOIR_API_KEY || ''
      }
    });
    const json = await res.json();
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
    const rank = json?.rarity?.rank || json?.nft?.rarity?.rank;
    return rank ? `#${rank}` : 'N/A';
  } catch (err) {
    console.error('❌ OpenSea rank fetch failed:', err);
    return 'N/A';
  }
}

async function fetchTotalSupply(contract, network) {
  try {
    const chain = network === 'eth' ? 'ethereum' : network;
    const url = `https://api.reservoir.tools/collections/v5?id=${chain}:${contract}`;
    const res = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'x-api-key': RESERVOIR_API_KEY || ''
      }
    });
    const json = await res.json();
    const collection = json?.collections?.[0];
    if (!collection) {
      console.warn('⚠️ No collection found in Reservoir');
      return 'Unknown';
    }

    const count = collection.tokenCount;
    const isMinting = collection.mintKind === 'public';
    return count ? `${count}${isMinting ? ' (Still Minting)' : ''}` : 'Unknown';
  } catch (err) {
    console.error('❌ Total supply fetch failed:', err);
    return 'Unknown';
  }
}

async function fetchMetadataExtras(contractAddress, tokenId, network) {
  const [minted, rankReservoir, rankOpenSea, totalSupply] = await Promise.all([
    fetchMintDate(contractAddress, tokenId),
    fetchRarityRankReservoir(contractAddress, tokenId),
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





