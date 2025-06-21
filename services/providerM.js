const { JsonRpcProvider } = require('ethers');

// ✅ RPC lists per chain
const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base.meowrpc.com'
  ],
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
  ],
  ape: [
    'https://apechain.drpc.org',
    'https://rpc.ankr.com/http/ape',
    'https://1rpc.io/ape'
  ]
};

// ✅ Track current index per chain
const providerIndex = {};
const providers = {};

// ✅ Initialize first provider for each chain
for (const chain in RPCS) {
  providerIndex[chain] = 0;
  providers[chain] = new JsonRpcProvider(RPCS[chain][0]);
}

// ✅ Get current provider for a chain
function getProvider(chain = 'base') {
  const key = chain.toLowerCase();
  if (!providers[key]) {
    console.warn(`⚠️ Unknown chain "${key}" — defaulting to Base`);
    return providers['base'];
  }
  return providers[key];
}

// ✅ Rotate to next provider on error
function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();
  if (!RPCS[key]) return;

  providerIndex[key] = (providerIndex[key] + 1) % RPCS[key].length;
  providers[key] = new JsonRpcProvider(RPCS[key][providerIndex[key]]);
  console.warn(`🔁 Rotated RPC for ${key}: ${RPCS[key][providerIndex[key]]}`);
}

// ✅ Failover-safe RPC call for a chain
async function safeRpcCall(chain, callFn, retries = 3) {
  const key = chain.toLowerCase();
  for (let i = 0; i < retries; i++) {
    try {
      const provider = getProvider(key);
      return await callFn(provider);
    } catch (err) {
      const msg = err?.info?.responseBody || err?.message || '';
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      console.warn(`⚠️ [${key}] RPC Error: ${err.message || err.code}`);

      if (isApeBatchLimit) {
        console.warn('⛔ ApeChain DRPC free tier batch limit hit — reduce batch or rotate');
      }

      rotateProvider(key);
      await new Promise(res => setTimeout(res, 500)); // optional delay
    }
  }
  throw new Error(`❌ All RPCs failed for ${key}`);
}

// ✅ Batch size helper
function getMaxBatchSize(chain = 'base') {
  return chain.toLowerCase() === 'ape' ? 3 : 10;
}

module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize
};





