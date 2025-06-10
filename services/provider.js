// utils/provider.js
const { JsonRpcProvider } = require('ethers');

const BASE_RPC_URLS = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
  'https://base.llamarpc.com'
];

let currentIndex = 0;

function getProvider() {
  const url = BASE_RPC_URLS[currentIndex];
  currentIndex = (currentIndex + 1) % BASE_RPC_URLS.length;

  if (process.env.DEBUG_PROVIDERS === 'true') {
    console.log(`🔌 Using provider for BASE: ${url}`);
  }

  // JsonRpcProvider will auto-detect the network, no need to pass chain ID
  return new JsonRpcProvider(url);
}

module.exports = { getProvider };




























