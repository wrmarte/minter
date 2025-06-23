const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');
const { trackApeContracts } = require('./mintProcessorApe');

function trackAllContracts(client) {
  trackBaseContracts(client);
  trackEthContracts(client);
  trackApeContracts(client); // ✅ Make sure this is active
}

module.exports = {
  trackAllContracts
};
