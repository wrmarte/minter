const { JsonRpcProvider } = require('ethers');

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
    'https://apechain.drpc.org',
    'https://rpc.apechain.com'
  ]
};

const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS[chain]) {
    console.warn(`⚠️ Unknown chain: ${chain}, defaulting to base`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const idx = rpcIndex[chain];
  const url = urls[idx];

  rpcIndex[chain] = (idx + 1) % urls.length;

  console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);

  // ✅ DO NOT set network or staticNetwork — let Ethers detect everything
  return new JsonRpcProvider(url); // ← This is the real fix
}

module.exports = { getProvider };


















