const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');

// ETH RPC rotation (we keep this for reverse if possible)
const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com',
  'https://ethereum.publicnode.com'
];

// Main resolver function
async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return address;

  // First attempt: reverse record via RPCs
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Second attempt: full domain ownership via The Graph ENS subgraph
  const graphName = await queryGraphENS(address);
  if (graphName) return graphName;

  return address;
}

// Advanced The Graph query — use registrant field
async function queryGraphENS(wallet) {
  const endpoint = 'https://api.thegraph.com/subgraphs/name/ensdomains/ens';
  const query = gql`
    query($registrant: String!) {
      domains(first: 1, where: { registrant: $registrant }, orderBy: createdAt, orderDirection: desc) {
        name
      }
    }
  `;
  try {
    const data = await request(endpoint, query, { registrant: wallet.toLowerCase() });
    return data.domains[0]?.name || null;
  } catch (err) {
    console.warn(`ENS subgraph query failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveENS };




