const { getProvider } = require('./provider');
const { processContracts, processTokenBuys } = require('./trackProcessors');

module.exports = async function startGlobalBlockListener(client) {
  const provider = getProvider();

  provider.on('block', async (blockNumber) => {
    console.log(`📡 New Block: ${blockNumber}`);

    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;

    try {
      await processContracts(client, fromBlock, toBlock);
      await processTokenBuys(client, fromBlock, toBlock);
    } catch (err) {
      console.warn(`⚠️ Global Block Processor Error: ${err.message}`);
    }
  });
}
