const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove this channel from a contract’s alerts')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Select contract name')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');
    const currentChannelId = interaction.channel.id;

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({
        content: '🚫 Admins only.',
        ephemeral: true
      });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

      if (!result.rows.length) {
        return interaction.editReply(`❌ Contract **${name}** not found.`);
      }

      const existingChannels = result.rows[0].channel_ids || [];
      const updatedChannels = existingChannels.filter(id => id !== currentChannelId);

      await pg.query(
        `UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`,
        [updatedChannels, name]
      );

      if (updatedChannels.length) {
        const mentions = updatedChannels.map(id => `<#${id}>`).join(', ');
        return interaction.editReply(
          `✅ Removed <#${currentChannelId}> from **${name}** alerts.\n📡 Still tracking in: ${mentions}`
        );
      } else {
        return interaction.editReply(
          `✅ Removed <#${currentChannelId}> from **${name}** alerts.\n⚠️ No channels are tracking this anymore.`
        );
      }
    } catch (err) {
      console.error('❌ Error in /untrackchannel:', err);
      return interaction.editReply('⚠️ Something went wrong.');
    }
  },

  async autocomplete(interaction) {
    try {
      const pg = interaction.client.pg;
      const focused = interaction.options.getFocused();

      const res = await pg.query(`SELECT name FROM contract_watchlist`);
      const contracts = res.rows.map(r => r.name);

      const filtered = contracts
        .filter(n => n.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      console.log('📊 Sending autocomplete choices:', filtered);

      await interaction.respond(
        filtered.map(name => ({ name, value: name }))
      );
    } catch (err) {
      console.error('❌ Autocomplete error in /untrackchannel:', err);
      await interaction.respond([]);
    }
  }
};
