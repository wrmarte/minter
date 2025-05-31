const { getProvider, rotateProvider } = require('./provider');

async function fetchLogs(contractAddress, fromBlock, toBlock, topic) {
  const blockBatchSize = 500;
  let currentBlock = fromBlock;
  const allLogs = [];

  while (currentBlock <= toBlock) {
    const batchFrom = currentBlock;
    const batchTo = Math.min(currentBlock + blockBatchSize - 1, toBlock);

    let success = false;
    let attempts = 0;

    while (!success && attempts < 5) {
      try {
        const provider = getProvider();
        const logs = await provider.getLogs({
          address: contractAddress,
          fromBlock: batchFrom,
          toBlock: batchTo,
          topics: [topic]
        });

        console.log(`✅ Logs: ${logs.length} from ${batchFrom} to ${batchTo}`);
        allLogs.push(...logs);
        success = true;
      } catch (err) {
        console.warn(`⚠️ Failed log fetch: ${err.message}`);
        rotateProvider();
      }
      attempts++;
    }

    if (!success) {
      console.error(`❌ Skipped blocks ${batchFrom}-${batchTo}`);
    }

    currentBlock = batchTo + 1;
  }

  return allLogs;
}

module.exports = { fetchLogs };

