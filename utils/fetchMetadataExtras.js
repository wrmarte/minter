// ✅ fetchMetadataExtras.js (patched)
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
      return null;
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
        return null;
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

  return null;
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
    if (rank) return `#${rank}`;
  } catch (err) {
    console.warn('❌ Reservoir rank fetch failed:', err.message);
  }
  return null;
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

    const rarity =
      json?.rarity ||
      json?.nft?.rarity ||
      json?.nft?.traits?.rarity ||
      json?.nft?.stats?.rarity ||
      json?.nft?.collection?.rarity ||
      null;

    const rank =
      rarity?.rank ??
      json?.nft?.rarity_rank ??
      json?.nft?.stats?.rank ??
      null;

    const score =
      rarity?.score ??
      json?.nft?.rarity_score ??
      json?.nft?.stats?.score ??
      null;

    if (rank || score) {
      return {
        rank: rank ? `#${rank}` : null,
        score: score && !isNaN(score) ? parseFloat(score).toFixed(2) : null
      };
    } else {
      console.warn(`⚠️ No rank/score found in OpenSea response for ${tokenId}`);
      console.log('🧪 OpenSea JSON:', JSON.stringify(json, null, 2));
    }
  } catch (err) {
    console.error('❌ OpenSea rank fetch failed:', err.message);
  }

  return { rank: null, score: null };
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
  const [mintedRaw, resRank, openseaData, totalSupply] = await Promise.all([
    fetchMintDate(contractAddress, tokenId),
    fetchRarityRankReservoir(contractAddress, tokenId),
    fetchRarityRankOpenSea(contractAddress, tokenId, network),
    fetchTotalSupply(contractAddress, tokenId)
  ]);

  const finalRank = resRank || openseaData.rank || 'Unavailable';
  const finalScore = openseaData.score || '—';
  const minted = (typeof mintedRaw === 'string' && mintedRaw.length >= 10) ? mintedRaw : '❌ Not Found';

  return {
    mintedDate: minted,
    rank: finalRank,
    score: finalScore,
    network: network.toUpperCase(),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };





