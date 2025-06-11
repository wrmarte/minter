const { JsonRpcProvider } = require('ethers');

const RPCS = {
  base: [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base',
    'https://base.llamarpc.com'
  ]
};

let rpcIndex = 0;

function getProvider(chain = 'base') {
  const urls = RPCS[chain];
  const url = urls[rpcIndex];
  rpcIndex = (rpcIndex + 1) % urls.length;
  return new JsonRpcProvider(url);
}

module.exports = { getProvider };





















