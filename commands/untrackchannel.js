const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackchannel')
    .setDescription('Remove current channel from a contract’s alerts')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');
    const currentChannelId = interaction.channel.id;

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(`SELECT * FROM contract_watchlist WHERE name = $1`, [name]);

      if (!result.rows.length) {
        return interaction.editReply(`❌ Contract **${name}** not found.`);
      }

      const existingChannels = result.rows[0].channel_ids || [];
      const updatedChannels = existingChannels.filter(id => id !== currentChannelId);

      await pg.query(`UPDATE contract_watchlist SET channel_ids = $1 WHERE name = $2`, [updatedChannels, name]);

      return interaction.editReply(`✅ Removed this channel from **${name}** alerts.`);
    } catch (err) {
      console.error('❌ Error in /untrackchannel:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackchannel`.');
    }
  }
};
