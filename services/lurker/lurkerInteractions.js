// services/lurker/lurkerInteractions.js
// ======================================================
// LURKER: Button handlers (Buy/Ignore)
// Step 1: Buy = acknowledge only (Step 2 will execute purchase)
// ======================================================

function isOwner(interaction) {
  const owner = (process.env.BOT_OWNER_ID || "").trim();
  return owner && interaction.user?.id === owner;
}

async function handleLurkerButton(interaction, client) {
  const id = String(interaction.customId || "");
  if (!id.startsWith("lurker_buy:") && !id.startsWith("lurker_ignore:")) return false;

  if (!isOwner(interaction)) {
    await interaction.reply({ content: "Owner-only for now.", ephemeral: true }).catch(() => null);
    return true;
  }

  const [type, ruleId, listingId] = id.split(":");
  if (type === "lurker_ignore") {
    await interaction.reply({ content: `Ignored listing.\nrule=${ruleId}\nlisting=${listingId}`, ephemeral: true }).catch(() => null);
    return true;
  }

  // BUY (Step 1): placeholder
  await interaction.reply({
    content:
      `🟢 Buy request received.\n` +
      `rule=${ruleId}\nlisting=${listingId}\n\n` +
      `Step 2 will wire: confirmation + max price + balance check + execute transaction.`,
    ephemeral: true
  }).catch(() => null);

  return true;
}

module.exports = { handleLurkerButton };
