const { Interface, Contract, id, ZeroAddress, ethers } = require('ethers');
const fetch = require('node-fetch');
const { shortWalletLink, loadJson, saveJson, seenPath } = require('../utils/helpers');
const { getRealDexPriceForToken, getEthPriceFromToken } = require('./price');
const { getProvider } = require('./provider');

// Map of known token names to override token contract addresses
const TOKEN_NAME_TO_ADDRESS = {
  'ADRIAN': '0x7e99075ce287f1cf8cbcaaa6a1c7894e404fd7ea'
};

async function trackAllContracts(client) {
  const pg = client.pg;
  const res = await pg.query('SELECT * FROM contract_watchlist');
  const contracts = res.rows;

  for (const contractRow of contracts) {
    launchContractListener(client, contractRow);
  }
}

function launchContractListener(client, contractRow) {
  const { name, address, mint_price, mint_token, mint_token_symbol, channel_ids } = contractRow;
  const abi = [
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
    'function tokenURI(uint256 tokenId) view returns (string)'
  ];
  const iface = new Interface(abi);
  const contract = new Contract(address, abi, getProvider());

  let seenTokenIds = new Set(loadJson(seenPath(name)) || []);

  getProvider().on('block', async (blockNumber) => {
    try {
      const fromBlock = Math.max(blockNumber - 5, 0);
      const toBlock = blockNumber;

      const filter = {
        address,
        topics: [id('Transfer(address,address,uint256)')],
        fromBlock,
        toBlock
      };

      const logs = await getProvider().getLogs(filter);

      for (const log of logs) {
        let parsed;
        try {
          parsed = iface.parseLog(log);
        } catch { continue; }
        const { from, to, tokenId } = parsed.args;
        const tokenIdStr = tokenId.toString();

        if (from === ZeroAddress) {
          if (seenTokenIds.has(tokenIdStr)) continue;
          seenTokenIds.add(tokenIdStr);

          let imageUrl = 'https://via.placeholder.com/400x400.png?text=NFT';
          try {
            let uri = await contract.tokenURI(tokenId);
            if (uri.startsWith('ipfs://')) uri = uri.replace('ipfs://', 'https://ipfs.io/ipfs/');
            const meta = await fetch(uri).then(res => res.json());
            if (meta?.image) {
              imageUrl = meta.image.startsWith('ipfs://')
                ? meta.image.replace('ipfs://', 'https://ipfs.io/ipfs/')
                : meta.image;
            }
          } catch {}

          const total = Number(mint_price);
          let tokenAddr = mint_token.toLowerCase();
          if (TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()]) {
            tokenAddr = TOKEN_NAME_TO_ADDRESS[mint_token_symbol.toUpperCase()].toLowerCase();
          }

          let ethValue = await getRealDexPriceForToken(total, tokenAddr);
          if (!ethValue) {
            const fallback = await getEthPriceFromToken(tokenAddr);
            ethValue = fallback ? total * fallback : null;
          }

          const embed = {
            title: `✨ NEW ${name.toUpperCase()} MINT!`,
            description: `Minted by: ${shortWalletLink(to)}\nToken #${tokenId}`,
            fields: [
              { name: `💰 Spent (${mint_token_symbol})`, value: total.toFixed(4), inline: true },
              { name: `⇄ ETH Value`, value: ethValue ? `${ethValue.toFixed(4)} ETH` : 'N/A', inline: true }
            ],
            thumbnail: { url: imageUrl },
            color: 219139,
            footer: { text: 'Live on Base • Powered by PimpsDev' },
            timestamp: new Date().toISOString()
          };

          for (const id of channel_ids) {
            const ch = await client.channels.fetch(id).catch(() => null);
            if (ch) await ch.send({ embeds: [embed] }).catch(() => {});
          }

          saveJson(seenPath(name), [...seenTokenIds]);
        }
      }
    } catch (err) {
      console.warn(`[${name}] Mint listener error: ${err.message}`);
    }
  });
}

module.exports = {
  trackAllContracts
};
