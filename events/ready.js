const { trackAllContracts } = require('../services/mintProcessor');

module.exports = async (client, pg) => {
  console.log('✅ Bot is fully ready!');

  // Kickstart the live NFT mint/sale tracking when bot is fully ready
  trackAllContracts(client);
};




