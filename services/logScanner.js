const { id } = require('ethers');
const { getProvider } = require('./provider');

const MAX_BLOCK_SPAN = 1000;

function toHex(num) {
  return '0x' + num.toString(16);
}

async function safeFetchLogs(provider, { address, topic, fromBlock, toBlock }) {
  try {
    let from = parseInt(fromBlock, 16);
    let to = parseInt(toBlock, 16);

    if (to < from) {
      throw new Error('❌ Invalid block range (to < from)');
    }

    // Clamp block range if too large
    const span = to - from;
    if (span > MAX_BLOCK_SPAN) {
      to = from + MAX_BLOCK_SPAN;
    }

    const logs = await provider.getLogs({
      address,
      topics: [topic],
      fromBlock: toHex(from),
      toBlock: toHex(to),
    });

    return logs;
  } catch (err) {
    if (err.message.includes('invalid block range')) {
      console.warn(`[${address}] Block range too large or invalid — fallback to single-block mode`);
      try {
        const logs = await provider.getLogs({
          address,
          topics: [topic],
          fromBlock,
          toBlock,
        });
        return logs;
      } catch (innerErr) {
        console.error(`[${address}] Failed even in single-block mode:`, innerErr.message);
        return [];
      }
    }
    console.error(`[${address}] Uncaught log fetch error:`, err.message);
    return [];
  }
}

async function fetchLogs(addresses, fromBlock, toBlock) {
  const provider = getProvider('base'); // Adjust if dynamic chain is needed
  const topics = [
    id('Transfer(address,address,uint256)'),
    id('Transfer(address,address,uint amount)')
  ];

  const allLogs = [];

  for (const address of addresses) {
    for (const topic of topics) {
      const logs = await safeFetchLogs(provider, { address, topic, fromBlock, toBlock });
      allLogs.push(...logs);
    }
  }

  return allLogs;
}

module.exports = { fetchLogs };


