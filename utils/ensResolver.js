const { JsonRpcProvider } = require('ethers');
const { shortenAddress } = require('./inputCleaner');
const fetch = require('node-fetch');

const ethRpcs = [
  'https://1rpc.io/eth',
  'https://ethereum.publicnode.com',
  'https://rpc.flashbots.net'
];

const PROXY_URL = 'https://ultraflex-proxy.vercel.app/ens/';

async function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // 1️⃣ RPC Reverse Lookup (fast)
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await withTimeout(provider.lookupAddress(address), 5000);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // 2️⃣ Vercel Proxy (super reliable)
  const visionENS = await queryEnsProxy(address);
  if (visionENS) return visionENS;

  return shortenAddress(address);
}

async function queryEnsProxy(wallet) {
  try {
    const url = `${PROXY_URL}${wallet.toLowerCase()}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      console.warn(`ENS Proxy HTTP error: ${response.status}`);
      return null;
    }

    const json = await response.json();
    return json?.ens || null;
  } catch (err) {
    console.warn(`ENS Proxy query failed: ${err}`);
    return null;
  }
}

module.exports = { resolveENS };













