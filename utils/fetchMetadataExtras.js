// utils/fetchMetadataExtras.js
const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');
require('dotenv').config();

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const RPCS = {
  base: 'https://mainnet.base.org',
  eth: 'https://eth.llamarpc.com',
  ape: 'https://rpc.apecoin.com'
};

async function fetchMetadataExtras(contractAddress, tokenId, network = 'base') {
  let rank = 'N/A';
  let mintedDate = 'Unknown';
  let totalSupply = '???';

  const rpc = RPCS[network.toLowerCase()] || RPCS.base;
  const provider = new JsonRpcProvider(rpc);

  try {
    // Use Moralis API for token transfer data
    const chainMap = { base: 'base', eth: 'eth', ape: 'apecoin' };
    const moralisChain = chainMap[network.toLowerCase()] || 'base';
    const url = `https://deep-index.moralis.io/api/v2/nft/${contractAddress}/${tokenId}/transfers?chain=${moralisChain}&format=decimal`;

    const res = await fetch(url, {
      headers: { 'X-API-Key': MORALIS_API_KEY }
    });

    const data = await res.json();
    if (data?.result?.length > 0) {
      const firstTx = data.result[data.result.length - 1];
      mintedDate = new Date(firstTx.block_timestamp).toLocaleDateString('en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    }
  } catch (err) {
    console.warn('⚠️ Failed to fetch minted date from Moralis:', err);
  }

  try {
    const abi = ['function totalSupply() view returns (uint256)'];
    const contract = new Contract(contractAddress, abi, provider);
    const total = await contract.totalSupply();
    totalSupply = total.toString();
  } catch (err) {
    console.warn('⚠️ Failed to fetch total supply:', err);
  }

  return {
    rank,
    mintedDate,
    network: network.charAt(0).toUpperCase() + network.slice(1),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };

