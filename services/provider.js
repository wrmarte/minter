const { JsonRpcProvider, Network } = require('ethers');

// 🔗 RPC Endpoints per chain
const RPCS = {
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth'
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    // 'https://base.meowrpc.com' // ❌ unstable — skipped automatically if re-added
  ],
  ape: [
    'https://apechain.drpc.org',
    'https://rpc.apechain.com'
  ]
};

// 🆔 Chain IDs
const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  ape: 6969
};

const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0
};

// ✅ Smart rotating provider with failover
function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS[chain]) {
    console.warn(`⚠️ Unknown chain: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const maxTries = urls.length;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    const idx = rpcIndex[chain];
    const url = urls[idx];

    rpcIndex[chain] = (idx + 1) % urls.length;

    try {
      const network = new Network(chain, CHAIN_IDS[chain]);
      const provider = new JsonRpcProvider(url, network, { staticNetwork: true });

      console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);
      return provider;
    } catch (err) {
      console.warn(`⚠️ Failed provider ${url}: ${err.message}`);
    }
  }

  throw new Error(`🚨 All ${chain.toUpperCase()} RPCs failed. Check RPC endpoints.`);
}

module.exports = { getProvider };















