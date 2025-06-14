const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const RPCS = {
  eth: [
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
    'https://apechain.drpc.org'
  ]
};

// Rotation index tracker per chain
const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS.hasOwnProperty(chain)) {
    console.warn(`⚠️ Unknown chain requested: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  if (!urls || urls.length === 0) {
    throw new Error(`🚫 No RPC URLs defined for chain: ${chain}`);
  }

  const url = urls[rpcIndex[chain]];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  // ✅ Required for Ethers v6 compatibility
  return new JsonRpcProvider(url, chain === 'ape'
    ? { name: 'apechain', chainId: 33139 }
    : undefined
  );
}

module.exports = { getProvider };










