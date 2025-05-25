const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('addflexduo')
    .setDescription('Add a flex duo (2 NFT contracts)')
    .addStringOption(opt =>
      opt.setName('name').setDescription('Name for the duo').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('contract1').setDescription('First contract address').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('contract2').setDescription('Second contract address').setRequired(true)
    ),

  async execute(interaction) {
    const pg = interaction.client.pg;
    const name = interaction.options.getString('name').toLowerCase();
    const contract1 = interaction.options.getString('contract1');
    const contract2 = interaction.options.getString('contract2');
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    try {
      await pg.query(`
        CREATE TABLE IF NOT EXISTS flex_duo (
          guild_id TEXT,
          name TEXT,
          contract1 TEXT,
          contract2 TEXT,
          PRIMARY KEY (guild_id, name)
        )
      `);

      await pg.query(
        `INSERT INTO flex_duo (guild_id, name, contract1, contract2)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (guild_id, name) DO UPDATE SET
         contract1 = EXCLUDED.contract1,
         contract2 = EXCLUDED.contract2`,
        [guildId, name, contract1, contract2]
      );

      await interaction.editReply(`✅ Duo \`${name}\` saved with contracts:\n• 1️⃣ \`${contract1}\`\n• 2️⃣ \`${contract2}\``);
    } catch (err) {
      console.error(err);
      await interaction.editReply('❌ Error saving duo.');
    }
  }
};
