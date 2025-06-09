const { JsonRpcProvider, Network } = require('ethers');

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

const rpcIndex = {
  eth: 0,
  base: 0,
  ape: 0
};

// Optional: Custom chain IDs
const CUSTOM_NETWORKS = {
  ape: {
    name: 'apechain',
    chainId: 6969  // or the correct chain ID for ApeChain mainnet
  }
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS.hasOwnProperty(chain)) {
    console.warn(`⚠️ Unknown chain requested: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const currentUrl = urls[rpcIndex[chain]];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  const customNetwork = CUSTOM_NETWORKS[chain];
  return customNetwork
    ? new JsonRpcProvider(currentUrl, customNetwork)
    : new JsonRpcProvider(currentUrl); // auto-detect for eth/base
}

module.exports = { getProvider };










