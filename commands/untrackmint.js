const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmint')
    .setDescription('Stop tracking a contract')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name to stop tracking')
        .setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name');

    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '❌ Admins only.', ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await pg.query(`DELETE FROM contract_watchlist WHERE name = $1 RETURNING *`, [name]);

      if (!result.rowCount) {
        return interaction.editReply(`❌ No contract found named **${name}**.`);
      }

      return interaction.editReply(`🛑 Stopped tracking **${name}**.`);
    } catch (err) {
      console.error('❌ Error in /untrackmint:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmint`.');
    }
  }
};
