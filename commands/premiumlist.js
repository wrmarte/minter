const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('premiumlist')
    .setDescription('View all premium servers and users (owner only)'),

  async execute(interaction) {
    const ownerId = process.env.BOT_OWNER_ID;
    if (interaction.user.id !== ownerId) {
      return interaction.reply({
        content: '❌ Only the bot owner can use this.',
        ephemeral: true
      });
    }

    try {
      const pg = interaction.client.pg;

      const serverRes = await pg.query(`SELECT * FROM premium_servers ORDER BY tier DESC`);
      const userRes = await pg.query(`SELECT * FROM premium_users ORDER BY tier DESC`);

      const servers = serverRes.rows.map(row => `• \`${row.server_id}\` → **${row.tier}**`).join('\n') || 'No upgraded servers.';
      const users = userRes.rows.map(row => `• <@${row.user_id}> → **${row.tier}**`).join('\n') || 'No upgraded users.';

      const reply = `📡 **Premium Servers:**\n${servers}\n\n🧑‍🚀 **Premium Users:**\n${users}`;

      await interaction.reply({ content: reply, ephemeral: true });

    } catch (err) {
      console.error('❌ Error in /premiumlist:', err);
      await interaction.reply({ content: '⚠️ Could not load premium list.', ephemeral: true });
    }
  }
};
