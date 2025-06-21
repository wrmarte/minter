// Modular import for future network support
const { trackBaseContracts } = require('../services/mintRouter');

// const { trackEthContracts } = require('../mintProcessorETH');
// const { trackApeContracts } = require('../mintProcessorApe');

module.exports = async (client, pg) => {
  console.log('✅ Bot is fully ready!');

  // Kickstart live NFT mint/sale tracking per network
  trackBaseContracts(client);
  // trackEthContracts(client);
  // trackApeContracts(client);
};
