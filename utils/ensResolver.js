const { JsonRpcProvider } = require('ethers');

// ENS lives on Ethereum mainnet
const ETHEREUM_MAINNET_RPC = 'https://rpc.ankr.com/eth'; // or Alchemy, Infura, etc.
const provider = new JsonRpcProvider(ETHEREUM_MAINNET_RPC);

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
