const fetch = require('node-fetch');
const { Contract, ethers } = require('ethers');

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

const FALLBACK_PRICES = {
  '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea': 0.0000000268056
};

async function getEthPriceFromToken(tokenInput) {
  let addr = tokenInput.toLowerCase();
  if (TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()]) {
    addr = TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()].toLowerCase();
  }
  if (!addr || addr === 'eth') return 1;

  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${addr}&vs_currencies=eth`);
    const data = await res.json();
    const price = data?.[addr]?.eth;
    if (!isNaN(price) && price > 0) return price;
  } catch {}

  try {
    const res = await fetch(`https://api.geckoterminal.com/api/v2/simple/networks/base/token_price/${addr}`);
    const data = await res.json();
    const priceStr = data?.data?.attributes?.token_prices?.eth;
    const price = priceStr ? parseFloat(priceStr) : null;
    if (!isNaN(price) && price > 0) return price;
  } catch {}

  return FALLBACK_PRICES[addr] || null;
}

async function getRealDexPriceForToken(tokenAmount, tokenAddress) {
  const routerAddress = '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86'; // Uniswap v2 on Base
  const abi = ['function getAmountsIn(uint amountOut, address[] path) view returns (uint[] memory)'];
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org'); // Use fallback RPC for price fetch

  const router = new Contract(routerAddress, abi, provider);
  const WETH = '0x4200000000000000000000000000000000000006';

  try {
    const path = [WETH, tokenAddress.toLowerCase()];
    const parsedOut = ethers.parseUnits(tokenAmount.toString(), 18);
    const result = await router.getAmountsIn(parsedOut, path);
    const ethNeeded = ethers.formatUnits(result[0], 18);
    return parseFloat(ethNeeded);
  } catch (err) {
    console.warn(`⚠️ getAmountsIn failed: ${err.message}`);
    return null;
  }
}

module.exports = {
  getEthPriceFromToken,
  getRealDexPriceForToken
};
