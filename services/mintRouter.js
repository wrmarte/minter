const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');
const { trackEthContracts } = require('./mintProcessorApe');
// Add more networks here later

function trackAllContracts(client) {
  trackBaseContracts(client);
  trackEthContracts(client);
}

module.exports = {
  trackAllContracts
};
