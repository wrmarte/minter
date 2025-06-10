const { JsonRpcProvider } = require('ethers');

// Known RPC endpoints
const RPCS = {
  eth: [ 'https://eth.llamarpc.com' ],
  base: [ 'https://mainnet.base.org' ],
  ape: [ 'https://apechain.drpc.org' ]
};

// Chain IDs
const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  ape: 6969
};

const rpcIndex = { eth: 0, base: 0, ape: 0 };

// ✅ Safe, guaranteed runner
function getProvider(chain = 'base') {
  chain = chain.toLowerCase();
  const urls = RPCS[chain];
  const id = CHAIN_IDS[chain];

  if (!urls || !id) {
    console.warn(`⚠️ Unknown chain: ${chain}, defaulting to base`);
    chain = 'base';
  }

  const idx = rpcIndex[chain];
  const url = urls[idx];
  rpcIndex[chain] = (idx + 1) % urls.length;

  console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);

  // ✅ Critical: this creates a working runner with .call() support
  const provider = new JsonRpcProvider(url);
  provider._network = { chainId: id, name: chain }; // 🧠 manual override: fixes ethers v6 detection issue

  return provider;
}

module.exports = { getProvider };


























