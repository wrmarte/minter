const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { TOKEN_NAME_TO_ADDRESS } = require('../constants') || {}; // If you have this
const { trackAllContracts } = require('../services/trackContracts');



module.exports = {
  data: new SlashCommandBuilder()
    .setName('trackmint')
    .setDescription('Track a new minting contract')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Contract name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true))
    .addNumberOption(opt =>
      opt.setName('price').setDescription('Mint price per NFT').setRequired(true))
    .addStringOption(opt =>
      opt.setName('token').setDescription('Token symbol or address').setRequired(false)),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { options, channel, member } = interaction;

    const name = options.getString('name');
    const address = options.getString('address');
    const mint_price = options.getNumber('price');
    const tokenSymbol = options.getString('token') || 'ETH';
    const resolvedSymbol = tokenSymbol.toUpperCase();
    const tokenAddr = TOKEN_NAME_TO_ADDRESS?.[resolvedSymbol] || tokenSymbol;
    const currentChannel = channel.id;

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

      if (res.rows.length > 0) {
        const existing = res.rows[0].channel_ids || [];
        const channel_ids = [...new Set([...existing, currentChannel])];

        await pg.query(
          `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`,
          [channel_ids, name]
        );

        const updated = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
        await trackAllContracts(interaction.client, updated.rows[0]);

        return interaction.editReply(`✅ Updated tracking for **${name}** and added this channel.`);
      }

      const channel_ids = [currentChannel];

      await pg.query(
        `INSERT INTO contract_watchlist (name, address, mint_price, mint_token, mint_token_symbol, channel_ids)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [name, address, mint_price, tokenAddr, resolvedSymbol, channel_ids]
      );

      const newRow = {
        name,
        address,
        mint_price,
        mint_token: tokenAddr,
        mint_token_symbol: resolvedSymbol,
        channel_ids
      };

      await trackAllContracts(interaction.client, newRow);

      return interaction.editReply(`✅ Now tracking **${name}** using token \`${resolvedSymbol}\`.`);
    } catch (err) {
      console.error('❌ Error in /trackmint:', err);
      return interaction.editReply('⚠️ Something went wrong while executing `/trackmint`.');
    }
  }
};
