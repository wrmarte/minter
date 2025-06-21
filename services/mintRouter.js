const { trackBaseContracts } = require('./mintProcessorBase');
const { trackEthContracts } = require('./mintProcessorEth');
const { trackEthContracts } = require('./mintProcessorApe');
// (In future, add more networks like Ape here)

function trackAllContracts(client) {
  trackBaseContracts(client);
  trackEthContracts(client);
  // future: trackApeContracts(client);
}

module.exports = {
  trackAllContracts
};
