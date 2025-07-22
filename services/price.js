const fetch = require('node-fetch');

async function fetchEthUsd() {
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    const data = await res.json();
    const ethUSD = parseFloat(data?.ethereum?.usd || '0');

    if (!ethUSD || isNaN(ethUSD)) throw new Error('Invalid ETH price');
    return ethUSD;
  } catch (e) {
    console.warn(`⚠️ CoinGecko ETH price failed, using fallback: $3000`);
    return 3000; // 🛑 Fallback ETH price (update as needed)
  }
}

async function getRealDexPriceForToken(amount, tokenAddress) {
  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/networks/base/tokens/${tokenAddress}`);
    const data = await res.json();
    const priceData = data?.data?.attributes;

    const priceUSD = parseFloat(priceData?.price_usd || '0');
    if (!priceUSD || isNaN(priceUSD)) {
      console.warn(`⚠️ Invalid priceUSD for ${tokenAddress}:`, priceUSD);
      return null;
    }

    const ethUSD = await fetchEthUsd();
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
      console.warn(`⚠️ Invalid fallback FDV/supply for ${tokenAddress}`);
      return null;
    }

    const priceUSD = fdv / supply;
    const ethUSD = await fetchEthUsd();

    const fallbackETH = priceUSD / ethUSD;
    console.log(`📉 Fallback Token ${tokenAddress} → ${fallbackETH.toFixed(8)} ETH/unit`);
    return fallbackETH;
  } catch (err) {
    console.warn(`❌ Error in getEthPriceFromToken(${tokenAddress}):`, err);
    return null;
  }
}

module.exports = { getRealDexPriceForToken, getEthPriceFromToken };








