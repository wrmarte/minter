const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('trackmint')
    .setDescription('Track a new minting contract')
    .addStringOption(opt => opt.setName('name').setDescription('Contract name').setRequired(true))
    .addStringOption(opt => opt.setName('address').setDescription('Contract address').setRequired(true))
    .addNumberOption(opt => opt.setName('price').setDescription('Mint price per NFT').setRequired(true))
    .addStringOption(opt => opt.setName('token').setDescription('Token symbol or address').setRequired(false)),

  async execute(interaction, { pg, trackContract, TOKEN_NAME_TO_ADDRESS }) {
    const { member, channel, options } = interaction;

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
    }

    const name = options.getString('name');
    const address = options.getString('address');
    const mint_price = options.getNumber('price');
    const tokenSymbol = options.getString('token') || 'ETH';
    const resolvedSymbol = tokenSymbol.toUpperCase();
    const tokenAddr = TOKEN_NAME_TO_ADDRESS[resolvedSymbol] || tokenSymbol;
    const currentChannel = channel.id;

    const res = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

    if (res.rows.length > 0) {
      const existing = res.rows[0].channel_ids || [];
      const channel_ids = [...new Set([...existing, currentChannel])];

      await pg.query(
        `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`,
        [channel_ids, name]
      );

      const updated = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);
      await trackContract(updated.rows[0]);

      return interaction.reply(`✅ Updated tracking for **${name}** and added this channel.`);
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

    await trackContract(newRow);

    return interaction.reply(`✅ Now tracking **${name}** using token \`${resolvedSymbol}\`.`);
  }
};

