// listeners/musclemb/permissions.js
// ======================================================
// Permissions helpers
// ======================================================

const { PermissionsBitField } = require('discord.js');
const Config = require('./config');

function isOwnerOrAdmin(message) {
  try {
    if (!message) return false;

    const isOwner = Boolean(Config.BOT_OWNER_ID) && message.author?.id === Config.BOT_OWNER_ID;
    if (isOwner) return true;

    const member = message.member;
    if (!member) return false;

    return member.permissions?.has?.(PermissionsBitField.Flags.Administrator) || false;
  } catch {
    return false;
  }
}

module.exports = { isOwnerOrAdmin };
