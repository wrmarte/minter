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

// Hybrid RPC rotator with error handling
function getProvider(chain) {
  chain = chain.toLowerCase();
  const urls = RPCS[chain];
  if (!urls || urls.length === 0) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  let attempts = 0;
  let lastError = null;

  while (attempts < urls.length) {
    const url = urls[rpcIndex[chain]];
    rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;
    try {
      const provider = new JsonRpcProvider(url);
      return provider;
    } catch (err) {
      console.warn(`⚠️ RPC failed for ${chain} at ${url}: ${err.message}`);
      lastError = err;
      attempts++;
    }
  }

  throw lastError || new Error(`All RPCs failed for chain: ${chain}`);
}

module.exports = { getProvider };

