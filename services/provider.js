const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const RPCS = {
  eth: [
    `https://eth.llamarpc.com`,
    `https://1rpc.io/eth`,
    `https://rpc.ankr.com/eth`
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

// Initialize rotation index
const rpcIndex = { eth: 0, base: 0, ape: 0 };

function getProvider(chain) {
  // ✅ HARDEN: if undefined, fallback to 'base' by default
  chain = (chain || 'base').toLowerCase();

  const urls = RPCS[chain];
  if (!urls || urls.length === 0) {
    throw new Error(`Unsupported chain: ${chain}`);
  }

  const url = urls[rpcIndex[chain]];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  return new JsonRpcProvider(url);
}

module.exports = { getProvider };






