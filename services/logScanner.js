const { id } = require('ethers');
const { getProvider, getMaxBatchSize } = require('./providerM');

async function fetchLogs(addresses, fromBlock, toBlock, chain = 'base') {
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const logs = [];
  const provider = getProvider(chain);
  const maxBatch = getMaxBatchSize(chain);

  for (const address of addresses) {
    for (const topic of topics) {
      let start = fromBlock;
      while (start <= toBlock) {
        const end = Math.min(start + maxBatch - 1, toBlock);

        try {
          const filter = { address, topics: [topic], fromBlock: start, toBlock: end };
          const theseLogs = await provider.getLogs(filter);
          logs.push(...theseLogs);
        } catch (err) {
          console.warn(`⚠️ [${chain}] Error fetching logs for ${address} (${start}–${end}): ${err.message}`);
        }

        start = end + 1;
      }
    }
  }

  return logs;
}

module.exports = { fetchLogs };




