const { JsonRpcProvider } = require('ethers');
const { request, gql } = require('graphql-request');
const { shortenAddress } = require('./inputCleaner');

const ethRpcs = [
  'https://rpc.ankr.com/eth',
  'https://mainnet.infura.io/v3/YOUR_INFURA_KEY',
  'https://eth-mainnet.g.alchemy.com/v2/YOUR_ALCHEMY_KEY',
  'https://cloudflare-eth.com'
];

async function resolveENS(address) {
  if (!address?.startsWith('0x') || address.length !== 42) return shortenAddress(address);

  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  return shortenAddress(address);
}

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



