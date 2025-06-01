const fetch = require('node-fetch');

async function getRealDexPriceForToken(amount, tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const priceData = data?.data?.attributes;

    // Extract raw USD price per token unit
    const priceUSD = parseFloat(priceData?.price_usd || '0');
    const decimals = parseInt(priceData?.decimals || 18);
    
    // Adjust for decimals to get true token unit price
    const adjustedUSD = priceUSD * (10 ** decimals);

    const ethRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const ethData = await ethRes.json();
    const ethUSD = parseFloat(ethData?.ethereum?.usd || '0');
    const priceETH = ethUSD > 0 ? adjustedUSD / ethUSD : null;

    return priceETH ? (amount * priceETH) : null;
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
    const ethUSD = parseFloat(ethData?.ethereum?.usd || '0');
    return ethUSD > 0 ? price / ethUSD : null;
  } catch {
    return null;
  }
}

module.exports = { getRealDexPriceForToken, getEthPriceFromToken };





