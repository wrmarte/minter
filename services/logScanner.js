const { id } = require('ethers');
const { getProvider } = require('./providerM');

const MAX_BLOCK_SPAN = 1000;

function toHex(n) {
  return '0x' + n.toString(16);
}

async function safeFetchLogs(address, topic, fromBlock, toBlock, provider) {
  const from = parseInt(fromBlock, 16);
  const to = parseInt(toBlock, 16);

  try {
    // Limit block span
    const safeTo = Math.min(to, from + MAX_BLOCK_SPAN);

    const logs = await provider.getLogs({
      address,
      topics: [topic],
      fromBlock: toHex(from),
      toBlock: toHex(safeTo),
    });

    return logs;

  } catch (err) {
    if (err.message.toLowerCase().includes('invalid block range')) {
      console.warn(`[${address}] Block range too large or invalid — fallback to single-block mode`);

      try {
        const logs = await provider.getLogs({
          address,
          topics: [topic],
          fromBlock: toHex(from),
          toBlock: toHex(from), // single-block fallback
        });

        return logs;
      } catch (fallbackErr) {
        console.error(`[${address}] Failed even in single-block mode:`, fallbackErr.message);
        return [];
      }
    }

    console.error(`[${address}] Unexpected log error:`, err.message);
    return [];
  }
}

async function fetchLogs(addresses, fromBlock, toBlock) {
  const provider = getProvider('base'); // Use 'eth', 'ape', or dynamic if needed
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const allLogs = [];

  for (const address of addresses) {
    for (const topic of topics) {
      const logs = await safeFetchLogs(address, topic, fromBlock, toBlock, provider);
      allLogs.push(...logs);
    }
  }

  return allLogs;
}

module.exports = { fetchLogs };



