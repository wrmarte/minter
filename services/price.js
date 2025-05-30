const fetch = require('node-fetch');
const { Contract, ethers } = require('ethers');

const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

const FALLBACK_PRICES = {
  '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea': 0.0000000268056
};

const WETH_ADDRESS = '0x4200000000000000000000000000000000000006';
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org'); 
const routerAddress = '0x327Df1E6de05895d2ab08513aaDD9313Fe505d86';
const abi = ['function getAmountsOut(uint amountIn, address[] path) view returns (uint[] memory)'];
const router = new Contract(routerAddress, abi, provider);

// Fetch DEX price (tokenAmount is input amount in tokens)
async function getRealDexPriceForToken(tokenAmount, tokenAddress) {
  try {
    if (!tokenAddress) return null;

    const tokenAddr = tokenAddress.toLowerCase();

    // WETH special case: 1:1 ETH
    if (tokenAddr === WETH_ADDRESS.toLowerCase()) {
      return parseFloat(tokenAmount);
    }

    const path = [tokenAddr, WETH_ADDRESS];
    const parsedAmount = ethers.parseUnits(tokenAmount.toString(), 18);
    const result = await router.getAmountsOut(parsedAmount, path);
    const ethAmount = ethers.formatUnits(result[1], 18);
    return parseFloat(ethAmount);
  } catch (err) {
    console.warn(`⚠️ getAmountsOut failed: ${err.message}`);
    return null;
  }
}

// Fallback price via Gecko & GeckoTerminal
async function getEthPriceFromToken(tokenInput) {
  let addr = tokenInput.toLowerCase();

  if (TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()]) {
    addr = TOKEN_NAME_TO_ADDRESS[tokenInput.toUpperCase()].toLowerCase();
  }
  if (!addr || addr === 'eth') return 1;

  // WETH shortcut bypass
  if (addr === WETH_ADDRESS.toLowerCase()) {
    return 1;
  }

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

module.exports = {
  getEthPriceFromToken,
  getRealDexPriceForToken
};

