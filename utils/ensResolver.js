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

  // ✅ 1️⃣ Reverse lookup
  for (const url of ethRpcs) {
    try {
      const provider = new JsonRpcProvider(url);
      const name = await provider.lookupAddress(address);
      if (name) return name;
    } catch (err) {
      console.warn(`RPC failed (${url}): ${err.message}`);
    }
  }

  // ✅ 2️⃣ Legacy ENS Subgraph
  const legacyENS = await queryLegacyENS(address);
  if (legacyENS) return legacyENS;

  // ✅ 3️⃣ ENSv2 Subgraph
  const ensV2 = await queryENSv2(address);
  if (ensV2) return ensV2;

  // ✅ 4️⃣ Final fallback
  return shortenAddress(address);
}

// 🔧 Legacy ENS Subgraph query (classic ownership)
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

// 🔧 ENSv2 Subgraph query (namewrapper & registrar v2)
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







