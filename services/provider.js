const { JsonRpcProvider } = require('ethers/providers'); // 👈 Correct module for Ethers v6+
const networks = {
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
  ],
  ape: [
    'https://apechain.drpc.org',
    'https://rpc.apechain.com',
  ],
};

const chainIds = {
  eth: 1,
  base: 8453,
  ape: 6969,
};

const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0,
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!networks[chain]) {
    console.warn(`⚠️ Unknown chain: ${chain}, defaulting to base`);
    chain = 'base';
  }

  const urls = networks[chain];
  const index = rpcIndex[chain];
  const url = urls[index];
  rpcIndex[chain] = (index + 1) % urls.length;

  console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);
  return new JsonRpcProvider(url); // ✅ No chainId, let it auto-detect
}

module.exports = { getProvider };























