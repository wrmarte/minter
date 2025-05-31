const { getProvider } = require('./provider');
const processUnifiedBlock = require('./globalBlockProcessor');

module.exports = async function startGlobalBlockListener(client) {
  const provider = getProvider();

  provider.on('block', async (blockNumber) => {
    console.log(`📡 New Block: ${blockNumber}`);

    const fromBlock = Math.max(blockNumber - 5, 0);
    const toBlock = blockNumber;

    try {
      await processUnifiedBlock(client, fromBlock, toBlock);
    } catch (err) {
      console.warn(`⚠️ Global Processor Error: ${err.message}`);
    }
  });
};

