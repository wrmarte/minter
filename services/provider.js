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

// Persistent providers per chain
let providers = {
  eth: new JsonRpcProvider(RPCS.eth[0]),
  base: new JsonRpcProvider(RPCS.base[0]),
  ape: new JsonRpcProvider(RPCS.ape[0], { name: 'apechain', chainId: 33139 })
};

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS.hasOwnProperty(chain)) {
    console.warn(`⚠️ Unknown chain requested: ${chain} — defaulting to 'base'`);
    chain = 'base';
  }

  return providers[chain];
}

function rotateProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS.hasOwnProperty(chain)) return;

  const urls = RPCS[chain];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;
  const nextUrl = urls[rpcIndex[chain]];

  providers[chain] = new JsonRpcProvider(
    nextUrl,
    chain === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined
  );

  console.warn(`🔁 Rotated ${chain.toUpperCase()} RPC → ${nextUrl}`);
}

module.exports = {
  getProvider,
  rotateProvider
};











