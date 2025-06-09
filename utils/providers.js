const { JsonRpcProvider } = require('ethers');

const MORALIS_API_KEY = 'YOUR_MORALIS_API_KEY';  // <-- your actual key

const RPCS = {
  eth: `https://ethereum.rpc.moralis.io/${MORALIS_API_KEY}`,
  base: `https://base.rpc.moralis.io/${MORALIS_API_KEY}`,
  ape: 'https://rpc.apexchain.io'
};

function getProvider(chain) {
  const url = RPCS[chain.toLowerCase()];
  if (!url) throw new Error(`Unsupported chain: ${chain}`);
  return new JsonRpcProvider(url);
}

module.exports = { getProvider };
