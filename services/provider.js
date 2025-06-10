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
    'https://apechain.drpc.org'
    
  ]
};

const rpcIndex = { base: 0, eth: 0, ape: 0 };

function getProvider(chain = 'base') {
  chain = chain.toLowerCase();
  if (!RPCS[chain]) chain = 'base';

  const urls = RPCS[chain];
  const idx = rpcIndex[chain];
  const url = urls[idx];
  rpcIndex[chain] = (idx + 1) % urls.length;

 if (process.env.DEBUG_PROVIDERS === 'true') {
  console.log(`🔌 Using provider for ${chain.toUpperCase()}: ${url}`);
}


  // Pass URL directly (Ethers v6 will auto-detect the network)
  return new JsonRpcProvider(url);
}

module.exports = { getProvider };



























