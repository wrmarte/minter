const { formatUnits } = require('ethers');
const fetch = require('node-fetch');
const { getProvider } = require('./provider');

async function getRealDexPriceForToken(amount, tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${tokenAddress}`);
    const data = await res.json();
    const prices = data?.data?.attributes?.token_prices || {};
    const tokenPrice = parseFloat(prices[tokenAddress.toLowerCase()] || '0');
    return tokenPrice ? amount * tokenPrice : null;
  } catch {
    return null;
  }
}

async function getEthPriceFromToken(tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const fdv = parseFloat(data?.data?.attributes?.fdv_usd || '0');
    const supply = parseFloat(data?.data?.attributes?.total_supply || '0');
    const price = fdv && supply ? fdv / supply : 0;
    const ethRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const ethData = await ethRes.json();
    const ethUsd = parseFloat(ethData?.ethereum?.usd || '0');
    return ethUsd > 0 ? price / ethUsd : null;
  } catch {
    return null;
  }
}

module.exports = { getRealDexPriceForToken, getEthPriceFromToken };


