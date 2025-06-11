const { JsonRpcProvider } = require('ethers');

const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ]
};

let currentIndex = 0;

async function getProvider() {
  const url = RPCS.base[currentIndex];
  currentIndex = (currentIndex + 1) % RPCS.base.length;

  const provider = new JsonRpcProvider(url);
  await provider._detectNetwork(); // ✅ force resolve the runner

  return provider;
}

module.exports = { getProvider };





















