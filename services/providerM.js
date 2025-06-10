const { ethers } = require('ethers');

const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ]
};


const rpcIndex = { base: 0 };

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

  // ✅ Correctly use Ethers v6 runtime class
  return new ethers.JsonRpcProvider(url);
}

module.exports = { getProvider };


module.exports = { getProvider };



