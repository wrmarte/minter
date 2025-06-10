// utils/getLogsSafe.js
const { JsonRpcProvider } = require('ethers');

/**
 * Safe wrapper around provider.getLogs() with fallback to single-block query.
 * Handles Base RPC quirks like invalid block range (-32000 error).
 */
async function getLogsSafe(provider, filter, name = 'Contract', chain = 'base') {
  try {
    return await provider.getLogs(filter);
  } catch (err) {
    const isInvalidRange =
      err.code === -32000 ||
      err.message?.includes('invalid block range') ||
      err.message?.includes('header not found');

    if (isInvalidRange) {
      console.warn(`[${filter.address}] Block range too large or invalid — fallback to single-block mode`);

      if (filter.fromBlock !== filter.toBlock) {
        // Retry with single-block mode (just the 'toBlock')
        const fallbackFilter = { ...filter, fromBlock: filter.toBlock };
        try {
          return await provider.getLogs(fallbackFilter);
        } catch (e2) {
          console.warn(
            `[${filter.address}] Failed even in single-block mode: could not coalesce error`,
            e2.message || e2
          );
          return [];
        }
      }

      console.warn(`[${filter.address}] Already single-block and still failed — giving up`);
      return [];
    }

    // Unknown error — log and return empty array
    console.warn(`[${filter.address}] Unexpected error while fetching logs:`, err.message || err);
    return [];
  }
}

module.exports = { getLogsSafe };



