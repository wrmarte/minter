// commands/lurker.js
// ======================================================
// /lurker set -> modal to create rule
// /lurker stop -> disable a rule (or all)
// /lurker list -> show rules
// ======================================================

const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder
} = require("discord.js");

const { ensureLurkerSchema } = require("../services/lurker/schema");

const EMERALD = 0x00c853;

function isOwner(interaction) {
  const owner = (process.env.BOT_OWNER_ID || "").trim();
  return owner && interaction.user?.id === owner;
}

async function requireSchema(client) {
  const ok = await ensureLurkerSchema(client);
  if (!ok) throw new Error("DB not ready (client.pg missing?)");
}

function cleanLower(s) {
  return String(s || "").trim().toLowerCase();
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("lurker")
    .setDescription("Lurker — watch NFT listings for rarity/traits")
    .addSubcommand(sc =>
      sc.setName("set")
        .setDescription("Create a Lurker rule (emerald popup)")
    )
    .addSubcommand(sc =>
      sc.setName("stop")
        .setDescription("Disable a rule (or all)")
        .addStringOption(o =>
          o.setName("rule_id")
            .setDescription("Rule ID to disable (leave blank to disable all)")
            .setRequired(false)
        )
    )
    .addSubcommand(sc =>
      sc.setName("list")
        .setDescription("List your Lurker rules")
    ),

  async execute(interaction, client) {
    // For now: owner-only (recommended). Later we can allow admins.
    if (!isOwner(interaction)) {
      return interaction.reply({ content: "Owner-only for now.", ephemeral: true }).catch(() => null);
    }

    const sub = interaction.options.getSubcommand();
    await requireSchema(client);

    if (sub === "set") {
      const modal = new ModalBuilder()
        .setCustomId("lurker_modal_set")
        .setTitle("🟢 Lurker Rule (Emerald)");

      const chain = new TextInputBuilder()
        .setCustomId("chain")
        .setLabel("Chain (eth/base/ape)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("eth");

      const contract = new TextInputBuilder()
        .setCustomId("contract")
        .setLabel("Contract Address (0x...)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const rarityMax = new TextInputBuilder()
        .setCustomId("rarity_max")
        .setLabel("Rarity Max (e.g. 100) — optional")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      const traitsJson = new TextInputBuilder()
        .setCustomId("traits_json")
        .setLabel('Traits JSON (optional) e.g. {"Hat":["Crown"]}')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      const maxPrice = new TextInputBuilder()
        .setCustomId("max_price_native")
        .setLabel("Max Price (native) optional (e.g. 0.05)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder().addComponents(chain),
        new ActionRowBuilder().addComponents(contract),
        new ActionRowBuilder().addComponents(rarityMax),
        new ActionRowBuilder().addComponents(traitsJson),
        new ActionRowBuilder().addComponents(maxPrice)
      );

      return interaction.showModal(modal);
    }

    if (sub === "stop") {
      const ruleId = interaction.options.getString("rule_id");
      const pg = client.pg;

      if (!ruleId) {
        await pg.query(`UPDATE lurker_rules SET enabled=FALSE WHERE guild_id=$1`, [interaction.guildId]);
        return interaction.reply({ content: "🟢 Lurker stopped: all rules disabled for this server.", ephemeral: true }).catch(() => null);
      }

      await pg.query(
        `UPDATE lurker_rules SET enabled=FALSE WHERE guild_id=$1 AND id=$2`,
        [interaction.guildId, Number(ruleId)]
      );
      return interaction.reply({ content: `🟢 Lurker stopped: rule #${ruleId} disabled.`, ephemeral: true }).catch(() => null);
    }

    if (sub === "list") {
      const pg = client.pg;
      const res = await pg.query(
        `SELECT id, chain, contract, enabled, rarity_max, max_price_native, auto_buy, channel_id
         FROM lurker_rules
         WHERE guild_id=$1
         ORDER BY id DESC
         LIMIT 25`,
        [interaction.guildId]
      );

      const rows = res.rows || [];
      const embed = new EmbedBuilder()
        .setColor(EMERALD)
        .setTitle("🟢 Lurker Rules")
        .setDescription(rows.length ? "Your current Lurker rules:" : "No rules yet. Use `/lurker set`.")
        .setTimestamp(new Date());

      for (const r of rows) {
        embed.addFields({
          name: `Rule #${r.id} — ${r.chain.toUpperCase()} — ${String(r.contract).slice(0, 8)}…`,
          value: [
            `Enabled: **${r.enabled ? "YES" : "NO"}**`,
            r.rarity_max != null ? `Rarity Max: **${r.rarity_max}**` : `Rarity Max: _none_`,
            r.max_price_native ? `Max Price: **${r.max_price_native}**` : `Max Price: _none_`,
            `AutoBuy: **${r.auto_buy ? "YES" : "NO"}**`,
            r.channel_id ? `Channel: <#${r.channel_id}>` : `Channel: _(uses LURKER_DEFAULT_CHANNEL_ID)_`,
          ].join("\n")
        });
      }

      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => null);
    }
  },

  // Modal submit handler (call this from your interactionCreate router)
  async handleModal(interaction, client) {
    if (interaction.customId !== "lurker_modal_set") return false;

    if (!isOwner(interaction)) {
      await interaction.reply({ content: "Owner-only for now.", ephemeral: true }).catch(() => null);
      return true;
    }

    await requireSchema(client);

    const chain = cleanLower(interaction.fields.getTextInputValue("chain"));
    const contract = cleanLower(interaction.fields.getTextInputValue("contract"));
    const rarityMax = (interaction.fields.getTextInputValue("rarity_max") || "").trim();
    const traitsJson = (interaction.fields.getTextInputValue("traits_json") || "").trim();
    const maxPrice = (interaction.fields.getTextInputValue("max_price_native") || "").trim();

    if (!["eth", "base", "ape"].includes(chain)) {
      await interaction.reply({ content: "Chain must be eth/base/ape", ephemeral: true }).catch(() => null);
      return true;
    }
    if (!contract.startsWith("0x") || contract.length < 42) {
      await interaction.reply({ content: "Contract address looks invalid.", ephemeral: true }).catch(() => null);
      return true;
    }
    if (traitsJson) {
      try { JSON.parse(traitsJson); } catch {
        await interaction.reply({ content: "Traits JSON is invalid JSON.", ephemeral: true }).catch(() => null);
        return true;
      }
    }

    const pg = client.pg;

    const ins = await pg.query(
      `
      INSERT INTO lurker_rules(guild_id, chain, contract, channel_id, rarity_max, traits_json, max_price_native, auto_buy, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,FALSE,$8)
      RETURNING id
      `,
      [
        interaction.guildId,
        chain,
        contract,
        process.env.LURKER_DEFAULT_CHANNEL_ID || null,
        rarityMax ? Number(rarityMax) : null,
        traitsJson || null,
        maxPrice || null,
        interaction.user?.id || null
      ]
    );

    const id = ins.rows?.[0]?.id;

    await interaction.reply({
      content: `🟢 Lurker rule created: **#${id}**\nChain: **${chain}**\nContract: \`${contract}\``,
      ephemeral: true
    }).catch(() => null);

    return true;
  }
};
