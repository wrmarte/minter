function shortWalletLink(address) {
  const short = `${address.slice(0, 6)}...${address.slice(-4)}`;
  return `[${short}](https://opensea.io/${address})`;
}

module.exports = {
  shortWalletLink
};

