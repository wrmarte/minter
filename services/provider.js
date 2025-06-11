const { JsonRpcProvider } = require('ethers');

const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth'
  ],
  ape: [
    'https://rpc.apecoin.com',
    'https://apechain.drpc.org'
  ]
};

const rpcIndex = {
  base: 0,
  eth: 0,
  ape: 0
};

// ✅ Async getProvider — always returns a detected JsonRpcProvider
async function getProvider(chain = 'base') {
  chain = chain.toLowerCase();
  if (!RPCS[chain]) chain = 'base';

  const urls = RPCS[chain];
  const idx = rpcIndex[chain];
  const url = urls[idx];
  rpcIndex[chain] = (idx + 1) % urls.length;

  if (process.env.DEBUG_PROVIDERS === 'true') {
    console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);
  }

  const provider = new JsonRpcProvider(url);

  // 🧠 Ensure the network is set before any .call() or .getBlockNumber()
  try {
    await provider._detectNetwork(); // Required for Ethers v6
  } catch (err) {
    console.warn(`⚠️ Network detection failed for ${chain}: ${err.message}`);
  }

  return provider;
}

module.exports = { getProvider };
