const { id } = require('ethers');
const { getProvider, getMaxBatchSize } = require('./providerM');

async function fetchLogs(addresses, fromBlock, toBlock, chain = 'base') {
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const logs = [];
  const provider = getProvider(chain);
  const maxBlockSpan = getMaxBatchSize(chain); // 3 for ape, 10 for base/eth

  for (const address of addresses) {
    for (const topic of topics) {
      let start = fromBlock;

      while (start <= toBlock) {
        const end = Math.min(start + maxBlockSpan - 1, toBlock);
        const filter = {
          address,
          topics: [topic],
          fromBlock: start,
          toBlock: end
        };

        try {
          const theseLogs = await provider.getLogs(filter);
          logs.push(...theseLogs);
        } catch (err) {
          const msg = err?.info?.responseBody || err?.message || '';
          const isApeBatchLimit =
            chain === 'ape' &&
            msg.includes('more than 3 requests');

          if (isApeBatchLimit) {
            console.warn(`🛑 DRPC batch limit hit — ${chain} logs skipped: ${start}–${end}`);
            return []; // Stop here instead of retrying
          }

          console.warn(`⚠️ [${chain}] Error fetching logs for ${address} ${start}–${end}: ${err.message}`);
        }

        start = end + 1;

        // Throttle delay to avoid rate limit
        await new Promise(res => setTimeout(res, chain === 'ape' ? 400 : 100));
      }
    }
  }

  return logs;
}

module.exports = { fetchLogs };




