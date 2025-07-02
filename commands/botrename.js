const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const checkTierAccess = require('../utils/checkTierAccess');

const COOLDOWN_HOURS = 12;
const cooldownMap = new Map(); // serverId => timestamp

module.exports = {
  data: new SlashCommandBuilder()
    .setName('botrename')
    .setDescription('Rename the bot for this server (premiumplus only)')
    .addStringOption(opt =>
      opt.setName('name')
        .setDescription('New bot nickname')
        .setRequired(true)
    ),

  async execute(interaction) {
    const newName = interaction.options.getString('name');
    const userId = interaction.user.id;
    const guild = interaction.guild;
    const member = guild?.members?.me;
    const pg = interaction.client.pg;

    const isBotOwner = userId === process.env.BOT_OWNER_ID;
    const hasAccess = isBotOwner || await checkTierAccess(pg, 'premiumplus', userId, guild?.id);
    if (!hasAccess) {
      return interaction.reply({
        content: '🔒 This command requires **premiumplus** tier access.',
        ephemeral: true
      });
    }

    if (!guild || !member) {
      return interaction.reply({ content: '⚠️ Missing server context or bot member.', ephemeral: true });
    }

    // Cooldown check
    const lastUsed = cooldownMap.get(guild.id);
    const now = Date.now();
    if (lastUsed && now - lastUsed < COOLDOWN_HOURS * 60 * 60 * 1000 && !isBotOwner) {
      const remaining = Math.ceil((COOLDOWN_HOURS * 60 * 60 * 1000 - (now - lastUsed)) / (60 * 1000));
      return interaction.reply({
        content: `🕒 You can rename the bot again in **${remaining} minutes**.`,
        ephemeral: true
      });
    }

    try {
      await member.setNickname(newName);
      cooldownMap.set(guild.id, now);

      // Broadcast rename in system channel or fallback
      const broadcastMsg = `📢 MuscleMB has been renamed to **${newName}** by <@${userId}>`;
      const systemChannel = guild.systemChannel;
      if (systemChannel && systemChannel.viewable && systemChannel.permissionsFor(member).has(PermissionsBitField.Flags.SendMessages)) {
        await systemChannel.send(broadcastMsg);
      } else {
        console.log(`[Rename] ${guild.name}: ${broadcastMsg}`);
      }

      await interaction.reply({
        content: `✅ Bot nickname changed to **${newName}**.`,
        ephemeral: false
      });

    } catch (err) {
      console.error('❌ Bot rename failed:', err);
      await interaction.reply({
        content: '⚠️ Rename failed. Make sure I have the **Change Nickname** permission.',
        ephemeral: true
      });
    }
  }
};
