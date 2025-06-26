const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('🛑 Stop tracking a mint/sale contract')
    .addStringOption(opt =>
      opt.setName('contract')
        .setDescription('Tracked contract (with chain)')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async autocomplete(interaction) {
    const pg = interaction.client.pg;
    const focused = interaction.options.getFocused();
    const guildId = interaction.guild?.id;

    try {
      const res = await pg.query(`SELECT name, address, chain, channel_ids FROM contract_watchlist`);

      const options = res.rows
        .filter(r => r.name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25)
        .map(r => {
          const emoji = r.chain === 'base' ? '🟦' : r.chain === 'eth' ? '🟧' : '🐵';
          const short = `${r.address.slice(0, 6)}...${r.address.slice(-4)}`;
          const channels = Array.isArray(r.channel_ids)
            ? r.channel_ids
            : (r.channel_ids || '').toString().split(',').filter(Boolean);

          const channelDisplay = channels.length === 1
            ? `#${interaction.client.channels.cache.get(channels[0])?.name || 'unknown'}`
            : `${channels.length} channels`;

          return {
            name: `${emoji} ${r.name} • ${short} • ${channelDisplay}`.slice(0, 100),
            value: `${r.name}|${r.chain}`
          };
        });

      await interaction.respond(options);
    } catch (err) {
      console.error('❌ Autocomplete error:', err);
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

