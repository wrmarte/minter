const { SlashCommandBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { getProvider } = require('../services/providerM');

const MORALIS_API_KEY = process.env.MORALIS_API_KEY;

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

    // Moralis Wallet NFT Fetch
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
      console.warn('⚠️ Moralis fetch failed:', err.message);
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


