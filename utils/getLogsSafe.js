const { JsonRpcProvider } = require('ethers');
const { RPCS } = require('./rpcList'); // See below for this helper

const usedRpcIndices = {}; // Keeps track per chain

function rotateProvider(chain) {
  if (!RPCS[chain]) throw new Error(`Unknown chain: ${chain}`);
  if (!usedRpcIndices[chain]) usedRpcIndices[chain] = 0;

  const rpcs = RPCS[chain];
  usedRpcIndices[chain] = (usedRpcIndices[chain] + 1) % rpcs.length;

  const url = rpcs[usedRpcIndices[chain]];
  return new JsonRpcProvider(url);
}

async function getLogsSafe(provider, filter, name = 'Unknown', chain = 'base') {
  let logs = [];
  const maxTries = RPCS[chain]?.length || 1;

  for (let attempt = 0; attempt < maxTries; attempt++) {
    try {
      logs = await provider.send('eth_getLogs', [filter]);
      return logs;
    } catch (err) {
      const msg = err?.error?.message || err?.message || '';
      const isRangeError = msg.includes('range') || msg.includes('block') || msg.includes('coalesce') || msg.includes('invalid');

      if (isRangeError) {
        console.warn(`[${name}] RPC failed. Trying next RPC for ${chain}...`);
        provider = rotateProvider(chain);
      } else {
        console.warn(`[${name}] Unexpected log error: ${msg}`);
        break;
      }
    }
  }

  // Last resort: try single block fallback
  try {
    const singleBlock = filter.toBlock;
    const fallbackFilter = { ...filter, fromBlock: singleBlock, toBlock: singleBlock };
    logs = await provider.send('eth_getLogs', [fallbackFilter]);
    return logs;
  } catch (finalErr) {
    console.warn(`[${name}] Failed even in single-block mode: ${finalErr.message}`);
    return [];
  }
}

module.exports = { getLogsSafe };

