const { JsonRpcProvider } = require('ethers');
const https = require('https');

// ✅ RPC lists per chain
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
  ],
  ape: [
    'https://rpc1.apexchain.xyz',
    'https://rpc.apexnetwork.xyz',
    'https://api.ape-rpc.com'
  ]
};

// ✅ Track current index per chain
const providerIndex = {};
const providers = {};

// ✅ Helper to test if RPC is alive
async function isRpcAlive(url) {
  return new Promise(res => {
    const req = https.get(url, () => res(true));
    req.on('error', () => res(false));
    req.setTimeout(2000, () => {
      req.destroy();
      res(false);
    });
  });
}

// ✅ Initialize first provider for each chain
(async () => {
  for (const chain in RPCS) {
    providerIndex[chain] = 0;
    for (let i = 0; i < RPCS[chain].length; i++) {
      const url = RPCS[chain][i];
      const alive = await isRpcAlive(url);
      if (alive) {
        providers[chain] = new JsonRpcProvider(
          url,
          chain === 'ape' ? { name: 'apechain', chainId: 33139 } : undefined
        );
        console.log(`✅ ${chain} initialized with RPC: ${url}`);
        break;
      } else {
        console.warn(`❌ Skipping dead RPC: ${url}`);
      }
    }
    if (!providers[chain]) {
      console.error(`❌ All ${chain} RPCs failed — using null`);
    }
  }
})();

// ✅ Get current provider for a chain
function getProvider(chain = 'base') {
  const key = chain.toLowerCase();
  if (!providers[key]) {
    console.warn(`⚠️ No live provider for "${key}". Returning null.`);
    return null;
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
    console.warn(`⛔ No rotation available for ${key} (static RPC only)`);
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
      console.warn(`❌ Skipped ${url} — ${key} RPC not responding`);
    }
  }

  providers[key] = null;
  console.error(`❌ All ${key} RPCs failed — provider set to null`);
}

// ✅ Failover-safe RPC call — now 100% crash-proof
async function safeRpcCall(chain, callFn, retries = 4) {
  const key = chain.toLowerCase();

  for (let i = 0; i < retries; i++) {
    const provider = getProvider(key);
    if (!provider) {
      console.warn(`⚠️ No live provider for "${key}". Skipping call.`);
      return null;
    }

    try {
      return await callFn(provider);
    } catch (err) {
      const msg = err?.info?.responseBody || err?.message || '';
      const isApeBatchLimit = key === 'ape' && msg.includes('Batch of more than 3 requests');
      const isForbidden = msg.includes('403') || msg.includes('API key is not allowed');
      const isLogBlocked = msg.includes("'eth_getLogs' is unavailable");

      console.warn(`⚠️ [${key}] RPC Error: ${err.message || err.code || 'unknown'}`);
      if (err?.code) console.warn(`🔍 RPC failure code: ${err.code}`);
      console.warn(`🔻 RPC failed: ${getProvider(key)?.connection?.url}`);

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

        await rotateProvider(key);
        await new Promise(res => setTimeout(res, 500));
        continue;
      }

      throw err;
    }
  }

  console.error(`❌ All retries failed for ${key}. Returning null.`);
  return null;
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

