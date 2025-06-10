const { id } = require('ethers');

async function getLogsSafe(provider, filter, name = 'Unknown', chain = 'base') {
  let logs = [];
  try {
    logs = await provider.send('eth_getLogs', [filter]);
  } catch (err) {
    const msg = err?.error?.message || err?.message || '';
    const isRangeError = msg.includes('range') || msg.includes('block') || msg.includes('coalesce') || msg.includes('invalid');

    if (isRangeError) {
      console.warn(`[${name}] Block range too large or invalid — fallback to single-block mode`);
      try {
        const singleBlockHex = filter.toBlock;
        const fallbackFilter = {
          ...filter,
          fromBlock: singleBlockHex,
          toBlock: singleBlockHex
        };
        logs = await provider.send('eth_getLogs', [fallbackFilter]);
      } catch (err2) {
        console.warn(`[${name}] Failed even in single-block mode: ${err2.message}`);
      }
    } else {
      console.warn(`[${name}] Unexpected error while fetching logs: ${msg}`);
    }
  }

  return logs;
}

module.exports = { getLogsSafe };
