const { JsonRpcProvider } = require('ethers');

// ✅ RPC lists per chain (Ape disabled and handled safely)
const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ],
  eth: [
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth',
    'https://rpc.ankr.com/eth'
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
    console.warn(`⚠️ Unknown or disabled chain "${key}" — defaulting to Base`);
    return providers['base'];
  }
  return providers[key];
}

// ✅ Network readiness check
async function isNetworkReady(provider) {
  try {
    const net = await provider.getNetwork();
    return !!net.chainId;
  } catch {
    return false;
  }
}

// ✅ Rotate to next provider
async function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();
  if (!RPCS[key] || RPCS[key].length <= 1) {
    console.warn(`⛔ No rotation available for ${key} (using static RPC)`);
    return;
  }

  for (let attempts = 0; attempts < RPCS[key].length; attempts++) {
    providerIndex[key] = (providerIndex[key] + 1) % RPCS[key].length;
    const url = RPCS[key][providerIndex[key]];
    const tempProvider = new JsonRpcProvider(url);

    if (await isNetworkReady(tempProvider)) {
      providers[key] = tempProvider;
      console.warn(`🔁 Rotated RPC for ${key}: ${url}`);
      return;
    }
  }
  console.error(`❌ All ${key} RPCs failed network check`);
}

// ✅ Failover-safe RPC call
async function safeRpcCall(chain, callFn, retries = 4) {
  const key = chain.toLowerCase();
  if (!RPCS[key]) {
    console.warn(`⛔ No RPC configured for ${key}. Skipping request.`);
    return null;
  }

  for (let i = 0; i < retries; i++) {
    try {
      const provider = getProvider(key);
      return await callFn(provider);
    } catch (err) {
      const msg = err?.info?.responseBody || err?.message || '';
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
        msg.includes('400 Bad Request') ||
        isForbidden ||
        isLogBlocked
      );

      if (shouldRotate) {
        await rotateProvider(key);
        await new Promise(res => setTimeout(res, 500));
        continue;
      }
      throw err;
    }
  }
  throw new Error(`❌ All RPCs failed for ${key}`);
}

function getMaxBatchSize(chain = 'base') {
  return chain.toLowerCase() === 'ape' ? 3 : 10;
}

module.exports = {
  getProvider,
  rotateProvider,
  safeRpcCall,
  getMaxBatchSize
};







