const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('dummy')
    .setDescription('Display a saved dummy info embed')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('The name of the dummy info to fetch')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(opt =>
      opt.setName('target')
        .setDescription('Optionally tag a user in the dummy response')
        .setRequired(false)
    ),

  async execute(interaction) {
    const name = interaction.options.getString('name');
    const target = interaction.options.getUser('target'); // optional user mention
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

      await interaction.reply({
        content: target ? `📣 ${target}` : null,
        embeds: [embed]
      });
    } catch (err) {
      console.error('❌ Dummy fetch error:', err);
      await interaction.reply({ content: '❌ Failed to fetch dummy info.', ephemeral: true });
    }
  },

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused();
    const pg = interaction.client.pg;
    const guildId = interaction.guild.id;

    try {
      const res = await pg.query(
        'SELECT name FROM dummy_info WHERE guild_id = $1',
        [guildId]
      );

      const choices = res.rows
        .map(r => r.name)
        .filter(name => name.toLowerCase().includes(focused.toLowerCase()))
        .slice(0, 25);

      await interaction.respond(
        choices.map(name => ({ name, value: name }))
      );
    } catch (err) {
      console.error('❌ Dummy autocomplete error:', err);
      await interaction.respond([]);
    }
  }
};

