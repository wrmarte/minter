const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

// Define multiple RPCs for failover
const RPCS = {
  eth: [
    `https://ethereum.rpc.moralis.io/${MORALIS_API_KEY}`,
    `https://eth.llamarpc.com`,
    `https://1rpc.io/eth`
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  ape: [
    'https://rpc.apexchain.io'
  ]
};

// Store current index for each chain
const rpcIndex = { eth: 0, base: 0, ape: 0 };

// Hybrid RPC rotator
function getProvider(chain) {
  chain = chain.toLowerCase();
  const urls = RPCS[chain];
  if (!urls || urls.length === 0) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  // Pick current RPC URL
  const url = urls[rpcIndex[chain]];

  // Advance index for next request (simple round-robin)
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  return new JsonRpcProvider(url);
}

module.exports = { getProvider };

