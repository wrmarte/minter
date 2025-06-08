function extractValidAddress(input) {
  if (!input) return null;
  if (typeof input === 'string' && input.startsWith('0x') && input.length === 42) {
    return input.toLowerCase();
  }
  if (typeof input === 'object' && input.address) {
    return extractValidAddress(input.address);
  }
  return null;
}

function shortenAddress(address) {
  if (typeof address !== 'string' || address.length !== 42) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

module.exports = { extractValidAddress, shortenAddress };



