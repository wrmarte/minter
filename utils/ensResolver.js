const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');
const { shortenAddress } = require('./inputCleaner');

const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://1rpc.io/eth',
  'https://ethereum.publicnode.com',
  'https://rpc.flashbots.net'
];

async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // First attempt: Reverse lookup
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Fallback: Legacy ENS Subgraph (full forward ownership)
  const legacyENS = await queryLegacyENS(address);
  if (legacyENS) return legacyENS;

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
    const data = await request(endpoint, query, { owner: wallet.toLowerCase() });
    return data?.domains?.[0]?.name || null;
  } catch (err) {
    console.warn(`ENS legacy query failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveENS };






