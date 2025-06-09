const { JsonRpcProvider, getNetwork } = require('ethers');

const RPCS = {
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  ape: [
    'https://apechain.drpc.org',
    'https://rpc.apechain.com',
    'https://node.histori.xyz/apechain-mainnet/8ry9f6t9dct1se2hlagxnd9n2a'
  ]
};

const CHAIN_IDS = {
  eth: 1,
  base: 8453,
  ape: 6969 // You can update this if ApeChain changes it
};

const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS[chain]) {
    console.warn(`⚠️ Unknown chain requested: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const idx = rpcIndex[chain];
  const url = urls[idx];

  // Rotate index
  rpcIndex[chain] = (idx + 1) % urls.length;

  return new JsonRpcProvider(url, CHAIN_IDS[chain]);
}

module.exports = { getProvider };











