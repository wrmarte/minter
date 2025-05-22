const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addflex')
    .setDescription('Register a new NFT project to flex from')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Project name').setRequired(true))
    .addStringOption(opt =>
      opt.setName('address').setDescription('Contract address').setRequired(true))
    .addStringOption(opt =>
      opt.setName('network')
        .setDescription('Network: eth or base')
        .addChoices({ name: 'Base', value: 'base' }, { name: 'Ethereum', value: 'eth' })
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return interaction.reply({ content: '🚫 Admin only.', ephemeral: true });
    }

    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const address = interaction.options.getString('address');
    const network = interaction.options.getString('network');

    try {
      await pg.query(`
        INSERT INTO flex_projects (name, address, network)
        VALUES ($1, $2, $3)
        ON CONFLICT (name) DO UPDATE SET address = $2, network = $3
      `, [name, address, network]);

      return interaction.reply(`✅ Project **${name}** added for flexing on **${network}**.`);
    } catch (err) {
      console.error('❌ Error in /addflex:', err);
      return interaction.reply({ content: '⚠️ Could not add project.', ephemeral: true });
    }
  }
};
