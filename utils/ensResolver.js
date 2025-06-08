const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');

// ETH RPCs (for reverse record, fast)
const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com',
  'https://ethereum.publicnode.com'
];

// ENS V6 — hybrid resolver
async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // Step 1 — Reverse lookup via RPCs
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Step 2 — ENSv2 Subgraph: search registrations for wrapped domains
  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  // Step 3 — Fallback to short wallet display
  return shortenAddress(address);
}

// ENSv2 subgraph query (wrapped domains supported)
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

// Utility to shorten wallet string
function shortenAddress(address) {
  if (typeof address !== 'string' || address.length !== 42) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

module.exports = { resolveENS };





