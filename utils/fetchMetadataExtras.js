const { JsonRpcProvider, Contract } = require('ethers');
const fetch = require('node-fetch');

const abi = [
  'function totalSupply() view returns (uint256)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
];

async function fetchMetadataExtras(contractAddress, tokenId, network = 'base') {
  const provider = new JsonRpcProvider(
    network === 'base'
      ? 'https://mainnet.base.org'
      : network === 'eth'
      ? 'https://eth.llamarpc.com'
      : 'https://rpc.ankr.com/eth'
  );

  const contract = new Contract(contractAddress, abi, provider);

  let rank = 'N/A';
  let mintedDate = 'Unknown';
  let totalSupply = 'N/A';

  try {
    // Get totalSupply
    totalSupply = (await contract.totalSupply()).toString();
  } catch {}

  try {
    // Use Reservoir to get rarity rank
    const res = await fetch(`https://api.reservoir.tools/tokens/v6?tokens=${contractAddress}:${tokenId}`, {
      headers: { 'x-api-key': process.env.RESERVOIR_API_KEY }
    });
    const json = await res.json();
    rank = json?.tokens?.[0]?.rarity?.rank ? `#${json.tokens[0].rarity.rank}` : 'N/A';
  } catch {}

  try {
    // Get mint date from first Transfer event (mint)
    const logs = await provider.getLogs({
      address: contractAddress,
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', // Transfer
        '0x0000000000000000000000000000000000000000000000000000000000000000', // from zero
        null,
        '0x' + tokenId.toString(16).padStart(64, '0') // indexed tokenId
      ],
      fromBlock: 0,
      toBlock: 'latest'
    });

    if (logs.length > 0) {
      const block = await provider.getBlock(logs[0].blockNumber);
      mintedDate = new Date(block.timestamp * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    }
  } catch {}

  return {
    rank,
    mintedDate,
    network: network.charAt(0).toUpperCase() + network.slice(1),
    totalSupply
  };
}

module.exports = { fetchMetadataExtras };
