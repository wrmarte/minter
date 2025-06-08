const { JsonRpcProvider } = require('ethers');
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

  return shortenAddress(address);
}

module.exports = { resolveENS };


