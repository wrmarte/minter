const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dummy')
    .setDescription('Display a saved dummy info embed')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('The name of the dummy info to fetch')
        .setRequired(true)
    ),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const guildId = interaction.guild.id;
    const pg = interaction.client.pg;

    try {
      const res = await pg.query(
        'SELECT content FROM dummy_info WHERE name = $1 AND guild_id = $2',
        [name, guildId]
      );

      if (res.rowCount === 0) {
        return await interaction.reply({ content: `❌ No dummy info found with name "${name}"`, ephemeral: true });
      }

      const content = res.rows[0].content;

      const embed = new EmbedBuilder()
        .setTitle(`📘 ${name.charAt(0).toUpperCase() + name.slice(1)}`)
        .setDescription(content)
        .setColor('#5865F2')
        .setFooter({ text: `Requested by ${interaction.user.username}` })
        .setTimestamp();

      await interaction.reply({ embeds: [embed] });
    } catch (err) {
      console.error('❌ Dummy fetch error:', err);
      await interaction.reply({ content: '❌ Failed to fetch dummy info.', ephemeral: true });
    }
  }
};
