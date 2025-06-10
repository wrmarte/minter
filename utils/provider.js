const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

// Define multiple RPCs for failover
const RPCS = {
  eth: [
    `https://ethereum.rpc.moralis.io/${MORALIS_API_KEY}`,
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth'
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
    console.warn(`⚠️ Unsupported chain requested: ${chain}, defaulting to base`);
    chain = 'base';
  }

  const url = urls[rpcIndex[chain]];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  const provider = new JsonRpcProvider(url);

  // Patch: auto-skip network mismatch errors
  provider._networkPromise.catch(err => {
    console.warn(`⚠️ Network detection failed for ${chain}: ${err.message}`);
  });

  return provider;
}

module.exports = { getProvider };

