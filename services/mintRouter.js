// Import trackers from each processor
const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');
const { trackApeContracts } = require('./mintProcessorApe');

// ✅ Launch all chain listeners
function trackAllContracts(client) {
  try {
    trackBaseContracts(client);
  } catch (err) {
    console.error('❌ Failed to start Base contract tracker:', err);
  }

  try {
    trackEthContracts(client);
  } catch (err) {
    console.error('❌ Failed to start Ethereum contract tracker:', err);
  }

  try {
    trackApeContracts(client);
  } catch (err) {
    console.error('❌ Failed to start ApeChain contract tracker:', err);
  }
}

module.exports = {
  trackAllContracts
};
