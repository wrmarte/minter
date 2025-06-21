const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');
// Add more networks here later

function trackAllContracts(client) {
  trackBaseContracts(client);
  trackEthContracts(client);
}

module.exports = {
  trackAllContracts
};
