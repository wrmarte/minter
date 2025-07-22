const fetch = require('node-fetch');

async function getRealDexPriceForToken(amount, tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();

    const priceData = data?.data?.attributes;
    if (!priceData) {
      console.warn(`⚠️ GeckoTerminal returned empty attributes for ${tokenAddress}`);
      return null;
    }

    const priceUSD = parseFloat(priceData?.price_usd || '0');
    if (!priceUSD || isNaN(priceUSD)) {
      console.warn(`⚠️ Invalid priceUSD from GeckoTerminal for ${tokenAddress}:`, priceUSD);
      return null;
    }

    const ethRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const ethData = await ethRes.json();
    const ethUSD = parseFloat(ethData?.ethereum?.usd || '0');

    if (!ethUSD || isNaN(ethUSD)) {
      console.warn(`⚠️ Invalid ethUSD from CoinGecko:`, ethUSD);
      return null;
    }

    const priceETH = priceUSD / ethUSD;
    const totalETH = amount * priceETH;

    console.log(`📊 Token ${tokenAddress} amount ${amount} → ${totalETH.toFixed(6)} ETH @ ${priceETH.toFixed(8)} ETH/unit`);
    return totalETH;
  } catch (err) {
    console.warn(`❌ Error in getRealDexPriceForToken(${tokenAddress}):`, err);
    return null;
  }
}

async function getEthPriceFromToken(tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const attr = data?.data?.attributes;

    const fdv = parseFloat(attr?.fdv_usd || '0');
    const supply = parseFloat(attr?.total_supply || '0');

    if (!fdv || !supply || isNaN(fdv) || isNaN(supply)) {
      console.warn(`⚠️ Fallback data invalid for ${tokenAddress} — FDV: ${fdv}, supply: ${supply}`);
      return null;
    }

    const priceUSD = fdv / supply;

    const ethRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const ethData = await ethRes.json();
    const ethUSD = parseFloat(ethData?.ethereum?.usd || '0');

    if (!ethUSD || isNaN(ethUSD)) {
      console.warn(`⚠️ Fallback ethUSD invalid:`, ethUSD);
      return null;
    }

    const fallbackETH = priceUSD / ethUSD;
    console.log(`📉 Fallback Token ${tokenAddress} → ${fallbackETH.toFixed(8)} ETH/unit`);
    return fallbackETH;
  } catch (err) {
    console.warn(`❌ Error in getEthPriceFromToken(${tokenAddress}):`, err);
    return null;
  }
}

module.exports = { getRealDexPriceForToken, getEthPriceFromToken };







