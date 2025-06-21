const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');

function trackAllContracts(client) {
  trackBaseContracts(client);
  trackEthContracts(client);
}

module.exports = {
  trackAllContracts
};

