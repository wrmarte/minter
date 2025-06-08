function extractValidAddress(input) {
  if (!input) return null;

  // Case 1: Already full 0x address
  if (typeof input === 'string' && input.startsWith('0x') && input.length === 42) {
    return input.toLowerCase();
  }

  // Case 2: Nested object with address field (from API objects)
  if (typeof input === 'object' && input.address) {
    return extractValidAddress(input.address);
  }

  // Case 3: Everything else invalid
  return null;
}

module.exports = { extractValidAddress };

