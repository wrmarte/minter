// fetchMetadataExtras.js
const fetch = require('node-fetch');
const { format } = require('date-fns');
const { JsonRpcProvider, Contract } = require('ethers');

const BASESCAN_API = process.env.BASESCAN_API_KEY;
const RESERVOIR_API_KEY = process.env.RESERVOIR_API_KEY;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;

const provider = new JsonRpcProvider('https://mainnet.base.org');
const erc721Abi = ['function totalSupply() view returns (uint256)'];

async function fetchMintDate(contractAddress, tokenId) {
  try {
    const url = `https://api.basescan.org/api?module=account&action=tokennfttx&contractaddress=${contractAddress}&sort=asc&apikey=${BASESCAN_API}`;
    const res = await fetch(url);
    const json = await res.json();

    if (!Array.isArray(json.result)) {
      console.warn('⚠️ Unexpected result format:', json.result);
      return 'Unknown';
    }

    const tokenIdStr = tokenId.toString();
    const mintTx = json.result.find(tx =>
      `${tx.tokenID}` === `${tokenId}` &&
      tx.from?.toLowerCase() === '0x0000000000000000000000000000000000000000'
    );

    if (mintTx?.timeStamp) {
      const timestampMs = parseInt(mintTx.timeStamp) * 1000;
      const dateObj = new Date(timestampMs);

      if (isNaN(dateObj.getTime())) {
        console.error(`❌ Invalid date parsed from timestamp: ${mintTx.timeStamp}`);
        return 'Unknown';
      }

      const formatted = format(dateObj, 'yyyy-MM-dd HH:mm');
      console.log(`📅 Final Minted Date for Token ${tokenIdStr}: ${formatted}`);
      return formatted;
    } else {
      console.warn(`⚠️ No matching mint transaction found for Token ${tokenIdStr}`);
    }
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
    const rarity = json?.rarity || json?.nft?.rarity;
    const rank = rarity?.rank;
    const score = rarity?.score;

    if (rank) {
      return {
        rank: `#${rank}`,
        score: score ? parseFloat(score).toFixed(2) : 'N/A'
      };
    }
  } catch (err) {
    console.error('❌ OpenSea rank fetch failed:', err);
  }

  return { rank: 'N/A', score: 'N/A' };
}

async function fetchTotalSupply(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, erc721Abi, provider);
    const supply = await contract.totalSupply();
    const current = parseInt(tokenId);
    const total = parseInt(supply.toString());

    const stillMinting = current < total;
    return `${total} (On-Chain${stillMinting ? ' — Still Minting' : ''})`;
  } catch (err) {
    console.error('❌ On-chain total supply fetch failed:', err);
    return 'Unknown';
  }
}

async function fetchMetadataExtras(contractAddress, tokenId, network) {
  const [minted, resRank, openseaData, totalSupply] = await Promise.all([
    fetchMintDate(contractAddress, tokenId),
    fetchRarityRankReservoir(contractAddress, tokenId),
    fetchRarityRankOpenSea(contractAddress, tokenId, network),
    fetchTotalSupply(contractAddress, tokenId)
  ]);

  const finalRank = resRank !== 'N/A' ? resRank : openseaData.rank;
  const finalScore = openseaData?.score || 'N/A';

  return {
    minted,
    rank: finalRank,
    score: finalScore,
    network: network.toUpperCase(),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };

