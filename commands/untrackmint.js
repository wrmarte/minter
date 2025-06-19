const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('untrackmintplus')
    .setDescription('Stop tracking a mint/sale contract on a specific chain')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('Contract name to stop tracking')
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName('chain')
        .setDescription('Which chain to stop tracking?')
        .setRequired(true)
        .addChoices(
          { name: 'Base', value: 'base' },
          { name: 'Ethereum', value: 'eth' },
          { name: 'ApeChain', value: 'ape' }
        )),

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
        return interaction.editReply(`❌ No contract found named **${name}** on \`${chain}\`.`);
      }

      return interaction.editReply(`🛑 Stopped tracking **${name}** on \`${chain}\`.`);
    } catch (err) {
      console.error('❌ Error in /untrackmintplus:', err);
      return interaction.editReply('⚠️ Failed to execute `/untrackmintplus`.');
    }
  }
};
