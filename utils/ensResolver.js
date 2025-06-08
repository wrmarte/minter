const { JsonRpcProvider } = require('ethers');

// You can also rotate multiple RPCs here if needed
const BASE_RPC = 'https://mainnet.base.org';  // you can swap for any working BASE or ETH mainnet RPC
const provider = new JsonRpcProvider(BASE_RPC);

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
