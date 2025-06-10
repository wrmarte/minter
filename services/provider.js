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
    'https://base.meowrpc.com'
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

// ✅ Rotating provider per chain
function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS[chain]) {
    console.warn(`⚠️ Unknown chain requested: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const idx = rpcIndex[chain];
  const url = urls[idx];

  // 🔁 Rotate index for next call
  rpcIndex[chain] = (idx + 1) % urls.length;

  // 🔧 Return resilient provider
  const network = new Network(chain, CHAIN_IDS[chain]);
  return new JsonRpcProvider(url, network, { staticNetwork: true });
}

module.exports = { getProvider };













