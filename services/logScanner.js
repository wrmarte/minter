const { id } = require('ethers');
const { getProvider } = require('./providerM');

async function fetchLogs(addresses, fromBlock, toBlock) {
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const logs = [];

  for (const address of addresses) {
    for (const topic of topics) {
      try {
        const filter = { address, topics: [topic], fromBlock, toBlock };
        const theseLogs = await getProvider().getLogs(filter);
        logs.push(...theseLogs);
      } catch (err) {
        console.warn(`⚠️ Error fetching logs for ${address}: ${err.message}`);
      }
    }
  }
  return logs;
}

module.exports = { fetchLogs };




