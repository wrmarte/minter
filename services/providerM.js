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
    'https://rpc.apeiron.io'
  ]
};

// ✅ Track current index per chain
const providerIndex = {};
const providers = {};

// ✅ Initialize first provider for each chain
for (const chain in RPCS) {
  providerIndex[chain] = 0;
  providers[chain] = new JsonRpcProvider(
    RPCS[chain][0],
    chain === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined
  );
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

// ✅ Rotate to next provider (only if multiple exist)
function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();

  if (!RPCS[key] || RPCS[key].length <= 1) {
    console.warn(`⛔ No rotation available for ${key} (using static RPC)`);
    return;
  }

  providerIndex[key] = (providerIndex[key] + 1) % RPCS[key].length;
  providers[key] = new JsonRpcProvider(
    RPCS[key][providerIndex[key]],
    key === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined
  );

  console.warn(`🔁 Rotated RPC for ${key}: ${RPCS[key][providerIndex[key]]}`);
}

// ✅ Failover-safe RPC call
async function safeRpcCall(chain, callFn, retries = 4) {
  const key = chain.toLowerCase();

  for (let i = 0; i < retries; i++) {
    try {
      const provider = getProvider(key);
      return await callFn(provider);
    } catch (err) {
      const msg = err?.info?.responseBody || err?.message || '';
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      const isForbidden = msg.includes('403') || msg.includes('API key is not allowed');
      const isLogBlocked = msg.includes("'eth_getLogs' is unavailable");

      console.warn(`⚠️ [${key}] RPC Error: ${err.message || err.code || 'unknown'}`);
      if (err?.code) console.warn(`🔍 RPC failure code: ${err.code}`);
      console.warn(`🔻 RPC failed: ${getProvider(key).connection?.url}`);

      const shouldRotate = (
        msg.includes('no response') ||
        msg.includes('429') ||
        msg.includes('timeout') ||
        msg.includes('ENOTFOUND') ||
        msg.includes('EHOSTUNREACH') ||
        msg.includes('ECONNREFUSED') ||
        msg.includes('ECONNRESET') ||
        msg.includes('network error') ||
        msg.includes('could not coalesce') ||
        msg.includes('invalid block range') ||
        msg.includes('failed to fetch') ||
        msg.includes('504') ||
        msg.includes('503') ||
        msg.includes('Bad Gateway') ||
        msg.includes('Gateway Time-out') ||
        isForbidden ||
        isLogBlocked
      );

      if (shouldRotate) {
        if (key === 'ape' && isApeBatchLimit) {
          console.warn('⛔ ApeChain batch limit hit — skip batch, no retry');
          return null;
        }

        rotateProvider(key);
        await new Promise(res => setTimeout(res, 500));
        continue;
      }

      throw err;
    }
  }

  throw new Error(`❌ All RPCs failed for ${key}`);
}

// ✅ Max batch size per chain
function getMaxBatchSize(chain = 'base') {
  return chain.toLowerCase() === 'ape' ? 3 : 10;
}

module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize
};





