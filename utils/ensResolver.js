const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');

// Multiple ETH RPCs to rotate
const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com',
  'https://ethereum.publicnode.com'
];

// ENS lookup via RPCs + TheGraph hybrid engine
async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return address;

  // Step 1: Attempt RPC-based reverse resolution
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Step 2: Query The Graph for any ENS domain owned
  const graphName = await forceENSName(address);
  if (graphName) return graphName;

  // Step 3: Fallback to raw address
  return address;
}

// The Graph ENS domain ownership query
async function forceENSName(wallet) {
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
    return data.domains[0]?.name || null;
  } catch (err) {
    console.warn(`ENS Graph query failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveENS };


