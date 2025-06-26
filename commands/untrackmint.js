const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract on a specific chain')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name to stop tracking')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(opt =>
      opt.setName('chain')
        .setDescription('Which chain to stop tracking?')
        .setRequired(true)
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        )
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();
    const chain = interaction.options.getString('chain');

    try {
      const query = chain
        ? `SELECT name, address, chain, channel_ids FROM contract_watchlist WHERE chain = $1`
        : `SELECT name, address, chain, channel_ids FROM contract_watchlist`;
      const values = chain ? [chain] : [];

      const res = await pg.query(query, values);
      const filtered = res.rows
        .filter(row => row.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25)
        .map(row => {
          const emoji = row.chain === 'base' ? '🟦' : row.chain === 'eth' ? '🟧' : '🐵';
          const shortAddr = `${row.address.slice(0, 6)}...${row.address.slice(-4)}`;
          const channels = Array.isArray(row.channel_ids)
            ? row.channel_ids
            : (row.channel_ids || '').toString().split(',').filter(Boolean);
          const channelText = channels.length === 1
            ? `<#${channels[0]}>`
            : `${channels.length} channels`;

          return {
            name: `${emoji} ${row.name} • ${shortAddr} • ${channelText}`,
            value: row.name
          };
        });

      await interaction.respond(filtered);
    } catch (err) {
      console.warn('❌ Autocomplete error in /untrackmintplus:', err);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { member, options } = interaction;

    const name = options.getString('name');
    const chain = options.getString('chain');

    if (!member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(
        `DELETE FROM contract_watchlist WHERE name = $1 AND chain = $2 RETURNING *`,
        [name, chain]
      );

      if (!result.rowCount) {
        return interaction.editReply(`❌ No tracked contract named **${name}** on \`${chain}\`.`);
      }

      return interaction.editReply(`🛑 Successfully untracked **${name}** on \`${chain}\`.`);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmintplus`.');
    }
  }
};
