// Central router for multi-network mint/sale processors

const { trackBaseContracts } = require('./mintProcessorBase');
// const { trackEthContracts } = require('./mintProcessorETH');
// const { trackApeContracts } = require('./mintProcessorApe');

module.exports = {
  trackBaseContracts,
  // trackEthContracts,
  // trackApeContracts
};
