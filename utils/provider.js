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
    'https://base.llamarpc.com'
  ],
  ape: [
    'https://rpc.apexchain.io'
  ]
};

const rpcIndex = { eth: 0, base: 0, ape: 0 };

// Async-safe rotating provider with validation
async function getProvider(chain = 'base') {
  chain = chain.toLowerCase();

  const urls = RPCS[chain];
  if (!urls || urls.length === 0) {
    console.warn(`⚠️ Unknown chain '${chain}', defaulting to 'base'`);
    chain = 'base';
  }

  const count = urls.length;

  for (let i = 0; i < count; i++) {
    const idx = rpcIndex[chain];
    const url = urls[idx];
    rpcIndex[chain] = (idx + 1) % count;

    try {
      const provider = new JsonRpcProvider(url);
      await provider.getBlockNumber(); // confirm working
      return provider;
    } catch (err) {
      console.warn(`❌ RPC failed for ${chain}: ${url} — ${err.message}`);
    }
  }

  throw new Error(`🚨 All RPCs failed for ${chain}`);
}

module.exports = { getProvider };


