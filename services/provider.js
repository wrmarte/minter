const { JsonRpcProvider } = require('ethers');

// ✅ Full list of Base RPC endpoints for rotation
const rpcList = [
  'https://mainnet.base.org',
  'https://base.publicnode.com',
  'https://1rpc.io/base',
  'https://base.llamarpc.com',
  'https://base.meowrpc.com'
];

// ✅ Provider state
let currentIndex = 0;
let provider = new JsonRpcProvider(rpcList[currentIndex]);

// ✅ Expose active provider
function getProvider() {
  return provider;
}

// ✅ Rotate RPC if failure happens
function rotateProvider() {
  currentIndex = (currentIndex + 1) % rpcList.length;
  provider = new JsonRpcProvider(rpcList[currentIndex]);
  console.warn(`⚠️ RPC rotated → Now using: ${rpcList[currentIndex]}`);
}

// ✅ Automatic failover wrapper
async function safeRpcCall(callFn, retries = rpcList.length) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await callFn(provider);
    } catch (err) {
      console.warn(`⚠️ RPC error: ${err.code || err.message}`);
      rotateProvider();
    }
  }
  throw new Error('❌ All RPC endpoints failed.');
}

module.exports = { getProvider, rotateProvider, safeRpcCall };



