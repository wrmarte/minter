const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');

const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://cloudflare-eth.com',
  'https://ethereum.publicnode.com'
];

// ENS lookup via RPCs
async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return address;

  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Fallback to TheGraph:
  return await forceENSName(address);
}

// ENS backup via The Graph
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
    return data.domains[0]?.name || wallet;
  } catch (err) {
    console.warn(`ENS graph query failed: ${err.message}`);
    return wallet;
  }
}

module.exports = { resolveENS };
