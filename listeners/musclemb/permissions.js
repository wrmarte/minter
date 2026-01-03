// listeners/musclemb/permissions.js
const { PermissionsBitField } = require('discord.js');
const Config = require('./config');

function isOwnerOrAdmin(message) {
  try {
    const ownerId = String(Config.BOT_OWNER_ID || '').trim();
    const isOwner = ownerId && message.author?.id === ownerId;
    const isAdmin = Boolean(message.member?.permissions?.has(PermissionsBitField.Flags.Administrator));
    return isOwner || isAdmin;
  } catch {
    return false;
  }
}

module.exports = { isOwnerOrAdmin };
