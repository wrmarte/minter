const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('./provider');  // this is the provider.js we just built

const abi = [
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function ownerOf(uint256 tokenId) view returns (address)'
];

async function fetchMetadata(contractAddress, tokenId, chain) {
  try {
    const provider = getProvider(chain);
    const contract = new Contract(contractAddress, abi, provider);
    const tokenURI = await contract.tokenURI(tokenId);

    let metadataUrl = tokenURI;
    if (tokenURI.startsWith('ipfs://')) {
      metadataUrl = tokenURI.replace('ipfs://', 'https://ipfs.io/ipfs/');
    }

    const response = await fetch(metadataUrl);
    const metadata = await response.json();
    return metadata || {};
  } catch (err) {
    console.error(`❌ Failed to fetch metadata: ${err}`);
    return {};
  }
}

module.exports = { fetchMetadata };
