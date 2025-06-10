const { JsonRpcProvider } = require('ethers');
const { getProvider } = require('../core/provider');

// Fallback-safe log fetcher
async function getLogsSafe(provider, filter, name = 'Contract', chain = 'base') {
  try {
    // Try normal range first
    return await provider.send('eth_getLogs', [filter]);
  } catch (err) {
    const msg = err?.error?.message || err?.message || '';
    const isRangeErr = msg.includes('range') || msg.includes('block') || msg.includes('coalesce') || msg.includes('invalid');

    if (isRangeErr) {
      console.warn(`[${name}] Block range too large or invalid — fallback to single-block mode`);
      try {
        const singleBlock = filter.toBlock;
        return await provider.send('eth_getLogs', [{ ...filter, fromBlock: singleBlock, toBlock: singleBlock }]);
      } catch (err2) {
        console.warn(`[${name}] Single-block fallback failed: ${err2.message}`);
        return [];
      }
    } else {
      console.warn(`[${name}] Unexpected log fetch error: ${msg}`);
      return [];
    }
  }
}

module.exports = { getLogsSafe };
