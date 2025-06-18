const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
const { generateFlexCard } = require('../utils/canvas/flexcardRenderer');

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function totalSupply() view returns (uint256)'
];

const provider = new JsonRpcProvider('https://eth.llamarpc.com');

function shortenAddress(address) {
  if (!address || address.length < 10) return address || 'Unknown';
  return `${address.substring(0, 6)}...${address.substring(address.length - 4)}`;
}

function fixIpfs(url) {
  return url?.startsWith('ipfs://') ? url.replace('ipfs://', 'https://ipfs.io/ipfs/') : url;
}

async function fetchMetadata(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);
    const metadataUrl = fixIpfs(tokenURI);

    const res = await fetch(metadataUrl);
    if (!res.ok) throw new Error(`Metadata fetch failed: ${res.statusText}`);
    const data = await res.json();
    return data || {};
  } catch (err) {
    console.error('❌ Metadata fetch failed (ETH):', err);
    return {};
  }
}

async function fetchOwner(contractAddress, tokenId) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    return await contract.ownerOf(tokenId);
  } catch (err) {
    console.error('❌ Owner fetch failed (ETH):', err);
    return '0x0000000000000000000000000000000000000000';
  }
}

async function fetchRarity(contractAddress, tokenId) {
  const lowerAddr = contractAddress.toLowerCase();

  // Try TraitSniper first
  try {
    const tsUrl = `https://api.traitsniper.com/v1/collections/${lowerAddr}/tokens/${tokenId}`;
    const tsRes = await fetch(tsUrl);
    if (tsRes.ok) {
      const json = await tsRes.json();
      return {
        rank: json?.rank || 'N/A',
        score: json?.score || 'N/A'
      };
    }
  } catch (e) {
    console.warn('⚠️ TraitSniper error:', e.message);
  }

  // Fallback to Reservoir
  try {
    const resUrl = `https://api.reservoir.tools/tokens/v6?tokens=ethereum:${lowerAddr}:${tokenId}`;
    const resRes = await fetch(resUrl, {
      headers: {
        'Accept': '*/*',
        'x-api-key': process.env.RESERVOIR_API_KEY || '' // optional
      }
    });

    if (!resRes.ok) throw new Error('Reservoir error');
    const json = await resRes.json();

    const token = json?.tokens?.[0]?.token;
    return {
      rank: token?.rarityRank?.toString() || 'N/A',
      score: token?.rarityScore?.toFixed(2) || 'N/A'
    };
  } catch (e) {
    console.warn('⚠️ Reservoir rarity fallback failed:', e.message);
    return { rank: 'N/A', score: 'N/A' };
  }
}

async function fetchMintedDate(contractAddress, tokenId) {
  try {
    const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'; // Transfer
    const zeroAddress = '0x0000000000000000000000000000000000000000';
    const tokenHex = '0x' + BigInt(tokenId).toString(16).padStart(64, '0');

    const logs = await provider.getLogs({
      address: contractAddress,
      fromBlock: 0,
      toBlock: 'latest',
      topics: [topic, `0x${zeroAddress.slice(2).padStart(64, '0')}`, null, tokenHex]
    });

    if (logs.length > 0) {
      const block = await provider.getBlock(logs[0].blockNumber);
      return new Date(block.timestamp * 1000).toISOString().split('T')[0]; // YYYY-MM-DD
    }

    return null;
  } catch (err) {
    console.warn('⚠️ Minted date fetch failed:', err.message);
    return null;
  }
}

async function buildFlexCard(contractAddress, tokenId, collectionName) {
  const metadata = await fetchMetadata(contractAddress, tokenId);
  const owner = await fetchOwner(contractAddress, tokenId);
  const ownerDisplay = shortenAddress(owner);

  let nftImageUrl = fixIpfs(metadata?.image) || 'https://i.imgur.com/EVQFHhA.png';

  let rawTraits = metadata?.attributes || metadata?.traits || [];
  const traits = Array.isArray(rawTraits) && rawTraits.length > 0
    ? rawTraits.map(attr => `${attr.trait_type || attr.trait} / ${attr.value}`)
    : ['No traits found'];

  const { rank, score } = await fetchRarity(contractAddress, tokenId);
  const totalSupply = await fetchTotalSupply(contractAddress);
  const mintedDate = await fetchMintedDate(contractAddress, tokenId);

  const safeCollectionName = collectionName || metadata?.name || 'NFT';
  const openseaUrl = `https://opensea.io/assets/ethereum/${contractAddress}/${tokenId}`;

  return await generateFlexCard({
    nftImageUrl,
    collectionName: safeCollectionName,
    tokenId,
    traits,
    owner: ownerDisplay,
    openseaUrl,
    rank,
    score,
    mintedDate,
    network: 'Ethereum',
    totalSupply
  });
}

async function fetchTotalSupply(contractAddress) {
  try {
    const contract = new Contract(contractAddress, abi, provider);
    return (await contract.totalSupply())?.toString();
  } catch (err) {
    console.warn('⚠️ Total supply fetch failed:', err.message);
    return 'N/A';
  }
}

module.exports = { buildFlexCard };


