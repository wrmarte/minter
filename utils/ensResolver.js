const { JsonRpcProvider, Contract, namehash } = require('ethers');

// ETH Mainnet RPC with full ENS support — this one works:
const provider = new JsonRpcProvider('https://rpc.ankr.com/eth');

// ENS Reverse Registrar contract address:
const ENS_REVERSE_REGISTRAR = '0x084b1c3C81545d370f3634392De611CaaBFf8148';
const reverseRegistrarAbi = [
  'function node(address addr) view returns (bytes32)',
  'function name(bytes32 node) view returns (string)'
];

// Fully bulletproof ENS lookup:
async function resolveENS(address) {
  try {
    const reverseRegistrar = new Contract(ENS_REVERSE_REGISTRAR, reverseRegistrarAbi, provider);
    const node = await reverseRegistrar.node(address);
    const ensName = await provider.resolveName(address);
    return ensName || address;
  } catch (err) {
    console.error('ENS Lookup failed:', err);
    return address;
  }
}

module.exports = { resolveENS };

