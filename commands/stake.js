const { SlashCommandBuilder } = require('discord.js');
const { Contract } = require('ethers');
const fetch = require('node-fetch');
const { getProvider, safeRpcCall } = require('../services/providerM');

const erc721Abi = [
  'function ownerOf(uint256 tokenId) view returns (address)'
];

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;
const BASESCAN_API = process.env.BASESCAN_API_KEY;

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stake')
    .setDescription('Stake all NFTs from this server’s project using your wallet')
    .addStringOption(option =>
      option.setName('wallet')
        .setDescription('Your wallet address')
        .setRequired(true)
    ),

  async execute(interaction) {
    const wallet = interaction.options.getString('wallet').toLowerCase();
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    await interaction.deferReply({ ephemeral: true });

    const res = await pg.query(`SELECT * FROM staking_projects WHERE guild_id = $1`, [guildId]);
    if (res.rowCount === 0) {
      return interaction.editReply('❌ No staking contract is set for this server. Ask an admin to use `/addstaking`.');
    }

    const project = res.rows[0];
    const contract = project.contract_address.toLowerCase();
    const network = project.network || 'base';

    let tokenIds = [];

    try {
      const moralisUrl = `https://deep-index.moralis.io/api/v2/${wallet}/nft?chain=${network}&format=decimal&limit=500`;
      const moralisRes = await fetch(moralisUrl, {
        headers: { 'X-API-Key': MORALIS_API_KEY }
      });
      const moralisData = await moralisRes.json();
      if (moralisData.result) {
        tokenIds = moralisData.result
          .filter(nft => nft.token_address.toLowerCase() === contract)
          .map(nft => nft.token_id);
      }
    } catch (err) {
      console.warn('⚠️ Moralis fetch failed, trying BaseScan fallback.', err.message);
    }

    if (tokenIds.length === 0) {
      try {
        const basescanUrl = `https://api.basescan.org/api?module=account&action=tokennfttx&address=${wallet}&contractaddress=${contract}&sort=asc&apikey=${BASESCAN_API}`;
        const basescanRes = await fetch(basescanUrl);
        const basescanData = await basescanRes.json();
        if (basescanData.result) {
          tokenIds = [...new Set(
            basescanData.result
              .filter(tx => tx.to.toLowerCase() === wallet && tx.contractAddress.toLowerCase() === contract)
              .map(tx => tx.tokenID)
          )];
        }
      } catch (err) {
        console.warn('⚠️ BaseScan fetch failed, fallback to ownerOf scan.', err.message);
      }
    }

    if (tokenIds.length === 0) {
      const provider = getProvider(network);
      const nftContract = new Contract(contract, erc721Abi, provider);

      const BATCH_SIZE = 10;
      const scanned = new Set();
      let tokenId = 0;
      let consecutiveErrors = 0;
      const maxConsecutiveErrors = 20;

      await interaction.editReply(`Scanning NFTs... Fallback ownerOf() starting.`);

      while (consecutiveErrors < maxConsecutiveErrors) {
        let batch = [];
        for (let i = 0; i < BATCH_SIZE; i++) {
          batch.push(tokenId);
          tokenId++;
        }

        const results = await Promise.all(
          batch.map(async (id) => {
            try {
              const owner = await safeRpcCall(network, async (prov) => {
                const tempContract = new Contract(contract, erc721Abi, prov);
                return await tempContract.ownerOf(id);
              });
              return { id, owner };
            } catch (error) {
              if (error.code === 'CALL_EXCEPTION') {
                consecutiveErrors++;
              }
              return null;
            }
          })
        );

        for (const res of results) {
          if (!res || !res.owner) continue;
          consecutiveErrors = 0;
          if (res.owner.toLowerCase() === wallet) {
            const idStr = res.id.toString();
            if (!scanned.has(idStr)) {
              tokenIds.push(idStr);
              scanned.add(idStr);
            }
          }
        }

        await interaction.editReply(`Scanning NFTs... Last checked tokenId: ${tokenId}. Found: ${tokenIds.length}. Consecutive errors: ${consecutiveErrors}/${maxConsecutiveErrors}`);
        await new Promise((res) => setTimeout(res, 100));
      }
    }

    if (tokenIds.length === 0) {
      return interaction.editReply(`❌ No NFTs detected in wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\` for this project.`);
    }

    await pg.query(`
      INSERT INTO staked_wallets (wallet_address, contract_address, network, token_ids, staked_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (wallet_address, contract_address)
      DO UPDATE SET token_ids = $4, staked_at = NOW()
    `, [wallet, contract, network, tokenIds]);

    return interaction.editReply(`✅ ${tokenIds.length} NFT(s) now actively staked for wallet \`${wallet.slice(0, 6)}...${wallet.slice(-4)}\`.`);
  }
};


