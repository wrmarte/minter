const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract on a specific chain')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Tracked contract to stop (name|chain)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();
    const guildId = interaction.guild?.id;

    try {
      const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);

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
            value: `${row.name}|${row.chain}` // must be unique
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

    const raw = options.getString('name'); // contains name|chain
    const [name, chain] = raw.split('|');

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

