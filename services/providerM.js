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

// ✅ Network readiness check (mainly for Ape)
async function isNetworkReady(provider) {
  try {
    const net = await provider.getNetwork();
    return !!net.chainId;
  } catch {
    return false;
  }
}

// ✅ Rotate to next provider (Ape patch included)
async function rotateProvider(chain = 'base') {
  const key = chain.toLowerCase();

  if (!RPCS[key] || RPCS[key].length <= 1) {
    console.warn(`⛔ No rotation available for ${key} (using static RPC)`);
    return;
  }

  for (let attempts = 0; attempts < RPCS[key].length; attempts++) {
    providerIndex[key] = (providerIndex[key] + 1) % RPCS[key].length;
    const url = RPCS[key][providerIndex[key]];
    const tempProvider = new JsonRpcProvider(
      url,
      key === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined
    );

    if (key !== 'ape' || await isNetworkReady(tempProvider)) {
      providers[key] = tempProvider;
      console.warn(`🔁 Rotated RPC for ${key}: ${url}`);
      return;
    } else {
      console.warn(`❌ Skipped ${url} — ApeChain RPC not responding`);
    }
  }

  console.error(`❌ All ${key} RPCs failed network check`);
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
      const code = err?.code || '';

      const isCallException = code === 'CALL_EXCEPTION' || msg.includes('execution reverted');
      const isBadRequest = msg.includes('400 Bad Request');
      const isForbidden = msg.includes('403') || msg.includes('API key is not allowed');
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      const isLogBlocked = msg.includes("'eth_getLogs' is unavailable");

      const isRotatable = (
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
        isBadRequest ||
        isForbidden ||
        isLogBlocked
      );

      // 🧹 Suppress logs for known ignorable errors
      const suppressLog = isCallException || isBadRequest;

      if (!suppressLog) {
        console.warn(`⚠️ [${key}] RPC Error: ${err.message || code}`);
        if (code) console.warn(`🔍 RPC failure code: ${code}`);
        console.warn(`🔻 RPC failed: ${getProvider(key).connection?.url}`);
      }

      if (isRotatable) {
        if (key === 'ape' && isApeBatchLimit) {
          console.warn('⛔ ApeChain batch limit hit — skip batch, no retry');
          return null;
        }

        await rotateProvider(key);
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







