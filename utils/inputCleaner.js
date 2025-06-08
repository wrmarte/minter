function extractValidAddress(input) {
  if (!input) return null;

  // Case 1: Already full 0x address
  if (typeof input === 'string' && input.startsWith('0x') && input.length === 42) {
    return input.toLowerCase();
  }

  // Case 2: Shortened address like "0x4943...81c6"
  if (typeof input === 'string' && input.startsWith('0x') && input.includes('...')) {
    // Try to rebuild if you trust your upstream shortening logic
    // But safest option: reject shortened input
    return null;
  }

  // Case 3: Nested object with address field (common in APIs)
  if (typeof input === 'object' && input.address) {
    return extractValidAddress(input.address);
  }

  // Case 4: Completely invalid
  return null;
}

module.exports = { extractValidAddress };
