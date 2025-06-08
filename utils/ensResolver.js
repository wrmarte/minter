const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');
const { shortenAddress } = require('./inputCleaner');

// ✅ Fully keyless public RPCs
const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://1rpc.io/eth',
  'https://ethereum.publicnode.com',
  'https://rpc.flashbots.net'
];

async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  // First attempt: Reverse lookup (fast)
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // Fallback: Forward ownership via ENSv2 subgraph
  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  // Final fallback: Short address
  return shortenAddress(address);
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
    const data = await request(endpoint, query, { registrant: wallet.toLowerCase() });
    return data?.registrations?.[0]?.domain?.name || null;
  } catch (err) {
    console.warn(`ENSv2 query failed: ${err.message}`);
    return null;
  }
}

module.exports = { resolveENS };





