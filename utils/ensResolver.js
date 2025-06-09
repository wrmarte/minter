const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');
const { shortenAddress } = require('./inputCleaner');
const fetch = require('node-fetch'); // node-fetch@2

// ENS-compatible public RPCs
const ethRpcs = [
  'https://1rpc.io/eth',
  'https://ethereum.publicnode.com',
  'https://rpc.flashbots.net'
];

// Vercel Proxy URL
const PROXY_URL = 'https://ultraflex-proxy.vercel.app/ens/';

// Global timeout helper
async function withTimeout(promise, ms = 5000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), ms))
  ]);
}

async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // 1️⃣ Reverse Lookup via multiple RPCs (with timeout)
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await withTimeout(provider.lookupAddress(address), 5000);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // 2️⃣ Legacy ENS Subgraph (timeout protected)
  const legacyENS = await queryLegacyENS(address);
  if (legacyENS) return legacyENS;

  // 3️⃣ ENSv2 Subgraph (timeout protected)
  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  // 4️⃣ ENS Proxy via Vercel (timeout protected)
  const visionENS = await queryEnsProxy(address);
  if (visionENS) return visionENS;

  // Final fallback: shorten wallet address
  return shortenAddress(address);
}

async function queryLegacyENS(wallet) {
  const endpoint = 'https://api.thegraph.com/subgraphs/name/ensdomains/ens';
  const query = gql`
    query($owner: String!) {
      domains(first: 1, where: { owner: $owner }, orderBy: createdAt, orderDirection: desc) {
        name
      }
    }
  `;
  try {
    const data = await withTimeout(
      request(endpoint, query, { owner: wallet.toLowerCase() }),
      5000
    );
    return data?.domains?.[0]?.name || null;
  } catch (err) {
    console.warn(`ENS legacy query failed: ${err.message}`);
    return null;
  }
}

async function queryENSv2(wallet) {
  const endpoint = 'https://api.thegraph.com/subgraphs/name/ensdomains/ensv2';
  const query = gql`
    query($registrant: String!) {
      registrations(first: 1, where: { registrant: $registrant }, orderBy: registrationDate, orderDirection: desc) {
        domain {
          name
        }
      }
    }
  `;
  try {
    const data = await withTimeout(
      request(endpoint, query, { registrant: wallet.toLowerCase() }),
      5000
    );
    return data?.registrations?.[0]?.domain?.name || null;
  } catch (err) {
    console.warn(`ENSv2 query failed: ${err.message}`);
    return null;
  }
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












