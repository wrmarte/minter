const { JsonRpcProvider } = require('ethers');

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
  const urls = RPCS.base;
  const idx = rpcIndex.base;
  const url = urls[idx];
  rpcIndex.base = (idx + 1) % urls.length;

  if (process.env.DEBUG_PROVIDERS === 'true') {
    console.log(`🔌 Using provider for BASE: ${url}`);
  }

  return new JsonRpcProvider(url);
}

module.exports = { getProvider };




















