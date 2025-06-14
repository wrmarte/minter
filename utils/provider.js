const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const RPCS = {
  eth: [
    `https://ethereum.rpc.moralis.io/${MORALIS_API_KEY}`,
    'https://eth.llamarpc.com',
    'https://1rpc.io/eth'
  ],
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com',
    'https://base.meowrpc.com'
  ],
  ape: [
    'https://rpc.apexchain.io'
  ]
};

// Rotation index tracker per chain
const rpcIndex = { eth: 0, base: 0, ape: 0 };

// Ethers v6 requires proper provider instantiation with URL
async function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  if (!RPCS.hasOwnProperty(chain)) {
    console.warn(`⚠️ Unknown chain '${chain}', defaulting to 'base'`);
    chain = 'base';
  }

  const urls = RPCS[chain];
  const count = urls.length;

  for (let i = 0; i < count; i++) {
    const idx = rpcIndex[chain];
    const url = urls[idx];
    rpcIndex[chain] = (idx + 1) % count;

    try {
      const provider = new JsonRpcProvider(url);
      await provider.getBlockNumber(); // simple test call
      return provider;
    } catch (err) {
      console.warn(`❌ RPC failed for ${chain}: ${url} — ${err.message}`);
    }
  }

  throw new Error(`🚨 All RPCs failed for '${chain}'`);
}

module.exports = { getProvider };



