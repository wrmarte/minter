const { JsonRpcProvider } = require('ethers');

// 100% Free ENS resolution working endpoint:
const provider = new JsonRpcProvider('https://cloudflare-eth.com');

async function resolveENS(address) {
  try {
    const ensName = await provider.lookupAddress(address);
    return ensName || address;
  } catch (err) {
    console.error('ENS Lookup failed:', err);
    return address;
  }
}

module.exports = { resolveENS };


