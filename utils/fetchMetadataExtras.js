// ✅ fetchMetadataExtras.js (ETH + BASE PATCHED FULL)
const fetch = require('node-fetch');
const { format } = require('date-fns');
const { JsonRpcProvider, Contract } = require('ethers');

const BASESCAN_API = process.env.BASESCAN_API_KEY;
const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const RESERVOIR_API_KEY = process.env.RESERVOIR_API_KEY;
const OPENSEA_API_KEY = process.env.OPENSEA_API_KEY;

const RPCS = {
  base: 'https://mainnet.base.org',
  ethereum: 'https://eth.llamarpc.com'
};

const erc721Abi = ['function totalSupply() view returns (uint256)'];

function getProvider(network) {
  const url = RPCS[network] || RPCS.base;
  return new JsonRpcProvider(url);
}

async function fetchMintDate(contract, tokenId, network) {
  try {
    if (network === 'base') {
      const url = `https://api.basescan.org/api?module=account&action=tokennfttx&contractaddress=${contract}&sort=asc&apikey=${BASESCAN_API}`;
      const res = await fetch(url);
      const json = await res.json();
      if (!Array.isArray(json.result)) return null;
      const mintTx = json.result.find(tx => `${tx.tokenID}` === `${tokenId}` && tx.from?.toLowerCase() === '0x0000000000000000000000000000000000000000');
      if (mintTx?.timeStamp) {
        const dateObj = new Date(parseInt(mintTx.timeStamp) * 1000);
        return format(dateObj, 'yyyy-MM-dd HH:mm');
      }
    } else if (network === 'ethereum') {
      const url = `https://deep-index.moralis.io/api/v2.2/nft/${contract}/${tokenId}/transfers?chain=eth&format=decimal`;
      const res = await fetch(url, { headers: { 'X-API-Key': MORALIS_API_KEY } });
      const json = await res.json();
      if (!Array.isArray(json.result)) {
        console.warn(`⚠️ Unexpected Moralis response for ${tokenId}:`, JSON.stringify(json, null, 2));
        return null;
      }
      const mintTx = json.result.find(tx => tx.from_address?.toLowerCase() === '0x0000000000000000000000000000000000000000');
      if (mintTx?.block_timestamp) {
        const dateObj = new Date(mintTx.block_timestamp);
        return format(dateObj, 'yyyy-MM-dd HH:mm');
      } else {
        console.warn(`⚠️ No ETH mint transfer found for ${contract} Token ${tokenId}`);
      }
    }
  } catch (err) {
    console.error('❌ Mint date fetch failed:', err.message);
  }
  return null;
}

async function fetchRarityRankReservoir(contract, tokenId) {
  try {
    const url = `https://api.reservoir.tools/tokens/v5?tokens=${contract}:${tokenId}`;
    const res = await fetch(url, { headers: { 'accept': 'application/json', 'x-api-key': RESERVOIR_API_KEY || '' } });
    const json = await res.json();
    const rank = json?.tokens?.[0]?.token?.rarity?.rank;
    console.log(`📊 Reservoir rank raw: ${rank}`);
    if (rank) return `#${rank}`;
    console.warn(`⚠️ Reservoir returned no rank for ${contract} Token ${tokenId}`);
  } catch (err) {
    console.warn('❌ Reservoir rank fetch failed:', err.message);
  }
  return null;
}

async function fetchRarityRankOpenSea(contract, tokenId, network) {
  try {
    const url = `https://api.opensea.io/api/v2/chain/${network}/contract/${contract}/nfts/${tokenId}`;
    const res = await fetch(url, { headers: { 'accept': 'application/json', 'x-api-key': OPENSEA_API_KEY || '' } });
    const json = await res.json();
    const rarity = json?.rarity || json?.nft?.rarity || json?.nft?.stats?.rarity;
    const rank = rarity?.rank ?? json?.nft?.rarity_rank;
    const score = rarity?.score ?? json?.nft?.rarity_score;
    console.log(`📊 OpenSea rank raw: ${rank}, score: ${score}`);
    if (!rank) console.warn(`⚠️ OpenSea returned no rank for ${contract} Token ${tokenId}`);
    return { rank: rank ? `${rank}` : null, score: score && !isNaN(score) ? parseFloat(score).toFixed(2) : null };
  } catch (err) {
    console.error('❌ OpenSea rank fetch failed:', err.message);
    return { rank: null, score: null };
  }
}

async function fetchTotalSupply(contract, tokenId, network) {
  try {
    const provider = getProvider(network);
    const nft = new Contract(contract, erc721Abi, provider);
    const total = await nft.totalSupply();
    const totalParsed = parseInt(total.toString());
    const current = parseInt(tokenId);
    return `${totalParsed} (On-Chain${current < totalParsed ? ' — Still Minting' : ''})`;
  } catch (err) {
    console.error('❌ Total supply fetch failed:', err.message);
    return 'Unknown';
  }
}

async function fetchMetadataExtras(contractAddress, tokenId, network = 'base') {
  const [mintedRaw, resRank, openseaData, totalSupply] = await Promise.all([
    fetchMintDate(contractAddress, tokenId, network),
    fetchRarityRankReservoir(contractAddress, tokenId),
    fetchRarityRankOpenSea(contractAddress, tokenId, network),
    fetchTotalSupply(contractAddress, tokenId, network)
  ]);

  console.log(`✅ Debug: contract=${contractAddress} tokenId=${tokenId} resRank=${resRank} openSeaRank=${openseaData.rank}`);

  const finalRank = resRank || openseaData.rank || 'NA';
  const finalScore = openseaData.score || '—';
  const minted = (typeof mintedRaw === 'string' && mintedRaw.length >= 10) ? mintedRaw : '❌ Not Found';

  return { mintedDate: minted, rank: finalRank, score: finalScore, network: network.toUpperCase(), totalSupply };
}

module.exports = { fetchMetadataExtras };








