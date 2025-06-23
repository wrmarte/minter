const { id } = require('ethers');
const { getProvider, getMaxBatchSize } = require('./providerM');

async function fetchLogs(addresses, fromBlock, toBlock, chain = 'base') {
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const logs = [];
  const provider = getProvider(chain);
  const maxBlockSpan = getMaxBatchSize(chain);

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
          const theseLogs = await provider.getLogs(filter); // SERIAL only
          logs.push(...theseLogs);
        } catch (err) {
          const msg = err?.info?.responseBody || err?.message || '';
          const isApeBatchLimit = chain === 'ape' && msg.includes('more than 3 requests');

          if (isApeBatchLimit) {
            console.warn(`🚫 Ape batch limit hit (serial enforced): ${start}–${end}`);
            return []; // hard fail to avoid spamming free tier
          }

          console.warn(`⚠️ [${chain}] Error fetching logs for ${address} (${start}–${end}): ${err.message}`);
        }

        start = end + 1;
        await new Promise(res => setTimeout(res, 350)); // ⏳ throttle to stay under DRPC rate limit
      }
    }
  }

  return logs;
}

module.exports = { fetchLogs };




