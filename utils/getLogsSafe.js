const { id } = require('ethers');

/**
 * Attempts to fetch logs using `eth_getLogs`. If that fails due to RPC block errors,
 * it falls back to `eth_getBlockReceipts` and manually filters the logs by topic and address.
 */
async function getLogsSafe(provider, filter, name = 'Unknown', chain = 'base') {
  try {
    // 🔍 First attempt: standard getLogs call
    return await provider.send('eth_getLogs', [filter]);
  } catch (err) {
    const msg = err?.error?.message || err?.message || '';
    console.warn(`[${name}] eth_getLogs failed: ${msg}`);

    const singleBlock = filter.toBlock;
    if (typeof singleBlock !== 'string' || !singleBlock.startsWith('0x')) {
      console.warn(`[${name}] Invalid block hex: ${singleBlock}`);
      return [];
    }

    // 🛑 Only fallback for single-block queries
    const fromBlock = filter.fromBlock;
    if (fromBlock !== singleBlock) {
      console.warn(`[${name}] Block range too large — skipping fallback.`);
      return [];
    }

    try {
      const receipts = await provider.send('eth_getBlockReceipts', [singleBlock]);
      const topic0 = filter.topics?.[0]?.toLowerCase();
      const targetAddr = filter.address?.toLowerCase();
      const results = [];

      for (const receipt of receipts) {
        for (const log of receipt.logs) {
          const logTopic0 = log.topics?.[0]?.toLowerCase();
          const logAddr = log.address?.toLowerCase();

          if (
            logTopic0 === topic0 &&
            (!targetAddr || logAddr === targetAddr)
          ) {
            results.push(log);
          }
        }
      }

      console.log(`[${name}] Fallback via eth_getBlockReceipts successful: ${results.length} logs`);
      return results;
    } catch (fallbackErr) {
      console.warn(`[${name}] Fallback failed: ${fallbackErr.message}`);
      return [];
    }
  }
}

module.exports = { getLogsSafe };

