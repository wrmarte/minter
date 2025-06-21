// Modular import for future network support
const { trackAllContracts } = require('../services/mintRouter');

module.exports = async (client, pg) => {
  console.log('✅ Bot is fully ready!');

  // Kickstart live NFT mint/sale tracking per network
  trackAllContracts(client);
};
