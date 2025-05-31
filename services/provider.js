const { JsonRpcProvider } = require('ethers');

// ✅ Multi-RPC rotation for stability
const baseRpcs = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
  'https://base.llamarpc.com',
  'https://base.meowrpc.com'
];

let currentRpcIndex = 0;
let provider = new JsonRpcProvider(baseRpcs[currentRpcIndex]);

function rotateProvider() {
  currentRpcIndex = (currentRpcIndex + 1) % baseRpcs.length;
  provider = new JsonRpcProvider(baseRpcs[currentRpcIndex]);
}

function getProvider() {
  return provider;
}

module.exports = { getProvider, rotateProvider };

