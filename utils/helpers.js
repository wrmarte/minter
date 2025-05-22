const fs = require('fs');
const path = require('path');

// Shortens a wallet address and returns a clickable OpenSea link
function shortWalletLink(address) {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return `[${short}](https://opensea.io/${address})`;
}

// Safely load JSON from a file path
function loadJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath));
  } catch {
    return null;
  }
}

// Save data as JSON to a file
function saveJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data));
}

// Generate path to block tracker file
function blockPath(name) {
  return path.join(__dirname, `../storage/lastBlock_${name}.json`);
}

// Generate path to seen mint IDs
function seenPath(name) {
  return path.join(__dirname, `../storage/seen_${name}.json`);
}

// Generate path to seen sale IDs
function seenSalesPath(name) {
  return path.join(__dirname, `../storage/sales_${name}.json`);
}

module.exports = {
  shortWalletLink,
  loadJson,
  saveJson,
  blockPath,
  seenPath,
  seenSalesPath
};
