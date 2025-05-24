const { PermissionsBitField } = require('discord.js');

function isAuthorized(interaction) {
  const isAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
  const isOwner = interaction.user.id === process.env.BOT_OWNER_ID;
  return isAdmin || isOwner;
}

module.exports = { isAuthorized };
