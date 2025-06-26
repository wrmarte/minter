const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract')
    .addStringOption(opt =>
      opt.setName('contract')
        .setDescription('Tracked contract to stop')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();

    try {
      const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);

      const options = [];

      for (const row of res.rows) {
        if (!row.name.toLowerCase().includes(focused.toLowerCase())) continue;

        const channels = Array.isArray(row.channel_ids)
          ? row.channel_ids
          : (row.channel_ids || '').toString().split(',').filter(Boolean);

        for (const channelId of channels) {
          const channel = interaction.client.channels.cache.get(channelId);
          if (!channel || !channel.guild) continue;

          const guildName = channel.guild.name;
          const channelName = channel.name;
          const emoji = row.chain === 'base' ? '🟦' : row.chain === 'eth' ? '🟧' : '🐵';

          const label = `🛡️ ${guildName} • 📍 ${channelName} • ${row.name} • ${emoji} ${row.chain}`;
          const value = `${row.name}|${row.chain}`; // used for actual logic

          options.push({
            name: label.slice(0, 100),
            value
          });

          if (options.length >= 25) break;
        }

        if (options.length >= 25) break;
      }

      await interaction.respond(options);
    } catch (err) {
      console.error('❌ Autocomplete error in /untrackmintplus:', err);
      await interaction.respond([]);
    }
  },

  async execute(interaction) {
    const pg = interaction.client.pg;
    const { member, options } = interaction;

    const raw = options.getString('contract');
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



