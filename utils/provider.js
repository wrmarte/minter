const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

const RPCS = {
  eth: [
    `https://ethereum.rpc.moralis.io/${MORALIS_API_KEY}`,
    `https://eth.llamarpc.com`,
    `https://1rpc.io/eth`
    // Ankr is fully removed
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

function getProvider(chain) {
  chain = chain.toLowerCase();
  const urls = RPCS[chain];
  if (!urls || !urls.length) throw new Error(`No RPCs defined for ${chain}`);
  const url = urls[rpcIndex[chain]];
  rpcIndex[chain] = (rpcIndex[chain] + 1) % urls.length;

  const provider = new JsonRpcProvider(url);
  provider._networkPromise?.catch(() => {}); // Suppress getNetwork warning
  return provider;
}

module.exports = { getProvider };

