const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');
const { shortenAddress } = require('./inputCleaner');

// ETH RPCs for reverse record
const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com',
  'https://ethereum.publicnode.com'
];

// Ultra ENS Resolver
async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // Step 1 — reverse record via RPC
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Step 2 — ENSv2 query via TheGraph
  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  // Step 3 — fallback to short wallet
  return shortenAddress(address);
}

// ENSv2 wrapped domains query
async function queryENSv2(wallet) {
  const endpoint = 'https://api.thegraph.com/subgraphs/name/ensdomains/ensv2';
  const query = gql`
    query($registrant: String!) {
      registrations(first: 1, where: { registrant: $registrant }) {
        domain {
          name
        }
      }
    }
  `;
  try {
    const data = await request(endpoint, query, { registrant: wallet.toLowerCase() });
    return data?.registrations?.[0]?.domain?.name || null;
  } catch (err) {
    console.warn(`ENSv2 query failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveENS };






