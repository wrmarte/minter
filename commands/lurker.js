// commands/lurker.js
// ======================================================
// /lurker set     -> modal to create rule
// /lurker quick   -> create rule quickly (no modal)
// /lurker stop    -> disable a rule (or all)
// /lurker list    -> show rules
// /lurker status  -> show config/health + rarity build status
// ======================================================

const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
} = require("discord.js");

const { ensureLurkerSchema } = require("../services/lurker/schema");

// Optional (status shows build info if available)
let getBuildStatus = null;
try {
  ({ getBuildStatus } = require("../services/lurker/rarity/rarityEngine"));
} catch {
  getBuildStatus = null;
}

const EMERALD = 0x00c853;

function isOwner(interaction) {
  const owner = (process.env.BOT_OWNER_ID || "").trim();
  return owner && interaction.user?.id === owner;
}

function resolveClient(ctx, interaction) {
  // ctx may be client OR {pg} depending on your router
  if (ctx && ctx.pg && !ctx.channels) return interaction.client; // ctx is not client
  return ctx || interaction.client;
}

async function requireSchema(client) {
  const ok = await ensureLurkerSchema(client);
  if (!ok) throw new Error("DB not ready (client.pg missing?)");
}

function cleanLower(s) {
  return String(s || "").trim().toLowerCase();
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function extractOpenSeaSlug(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;

  // If user passes just "cryptopimps-1"
  if (!raw.includes("/") && !raw.includes("?") && raw.length <= 120) {
    return cleanLower(raw);
  }

  // URL forms:
  // https://opensea.io/collection/<slug>...
  // https://opensea.io/collection/<slug>
  // https://opensea.io/collection/<slug>?sortBy=...
  const m = raw.match(/opensea\.io\/collection\/([^/?#]+)/i);
  if (m && m[1]) return cleanLower(m[1]);

  return null;
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
      sc.setName("quick")
        .setDescription("Quick-create a rule (no popup)")
        .addStringOption(o =>
          o.setName("chain").setDescription("eth/base/ape").setRequired(true)
            .addChoices(
              { name: "base", value: "base" },
              { name: "eth", value: "eth" },
              { name: "ape", value: "ape" }
            )
        )
        .addStringOption(o =>
          o.setName("contract").setDescription("0x contract").setRequired(true)
        )
        .addStringOption(o =>
          o.setName("opensea").setDescription("OpenSea slug or URL (recommended for v2 listings)").setRequired(false)
        )
        .addIntegerOption(o =>
          o.setName("rarity_max").setDescription("e.g. 100").setRequired(false)
        )
        .addStringOption(o =>
          o.setName("traits_json").setDescription('JSON e.g. {"Hat":["Crown"]}').setRequired(false)
        )
        .addStringOption(o =>
          o.setName("max_price_native").setDescription("e.g. 0.05").setRequired(false)
        )
        .addStringOption(o =>
          o.setName("channel_id").setDescription("channel id for alerts (optional)").setRequired(false)
        )
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
    )
    .addSubcommand(sc =>
      sc.setName("status")
        .setDescription("Show Lurker config/health")
    ),

  async execute(interaction, ctx) {
    const client = resolveClient(ctx, interaction);

    // Owner-only for now
    if (!isOwner(interaction)) {
      return interaction.reply({ content: "Owner-only for now (set BOT_OWNER_ID).", ephemeral: true }).catch(() => null);
    }

    const sub = interaction.options.getSubcommand();
    await requireSchema(client);

    if (sub === "status") {
      const pg = client.pg;
      const enabled = String(process.env.LURKER_ENABLED || "0").trim() === "1";
      const pollMs = Number(process.env.LURKER_POLL_MS || 15000);
      const defCh = (process.env.LURKER_DEFAULT_CHANNEL_ID || "").trim();
      const src = (process.env.LURKER_SOURCE || "opensea").trim();
      const owner = (process.env.BOT_OWNER_ID || "").trim();

      const res = await pg.query(
        `SELECT COUNT(*)::int AS n FROM lurker_rules WHERE enabled=TRUE AND guild_id=$1`,
        [interaction.guildId]
      );
      const n = res.rows?.[0]?.n ?? 0;

      const embed = new EmbedBuilder()
        .setColor(EMERALD)
        .setTitle("🟢 Lurker Status")
        .setDescription("Health + config snapshot")
        .addFields(
          { name: "Enabled", value: enabled ? "YES" : "NO", inline: true },
          { name: "Poll", value: `${pollMs}ms`, inline: true },
          { name: "Source", value: src, inline: true },
          { name: "Owner Set", value: owner ? "YES" : "NO", inline: true },
          { name: "Default Channel", value: defCh ? `<#${defCh}>` : "NOT SET", inline: true },
          { name: "Active Rules (this server)", value: String(n), inline: true },
        )
        .setTimestamp(new Date());

      // Rarity build status per active contract (best-effort)
      if (typeof getBuildStatus === "function") {
        try {
          const rr = await pg.query(
            `SELECT DISTINCT chain, contract
             FROM lurker_rules
             WHERE guild_id=$1 AND enabled=TRUE`,
            [interaction.guildId]
          );
          const rows = rr.rows || [];
          for (const row of rows.slice(0, 6)) {
            const chain = cleanLower(row.chain);
            const contract = cleanLower(row.contract);

            const st = await getBuildStatus(client, { chain, contract }).catch(() => null);
            if (!st) continue;

            const status = String(st.status || "unknown");
            const pc = st.processed_count != null ? String(st.processed_count) : "?";
            const ts = st.total_supply != null ? String(st.total_supply) : "?";

            embed.addFields({
              name: `Rarity Build — ${chain.toUpperCase()} ${contract.slice(0, 8)}…`,
              value: `Status: **${status}** | processed: **${pc}** | supply: **${ts}**`,
              inline: false
            });
          }
        } catch {
          // ignore
        }
      }

      return interaction.reply({ embeds: [embed], ephemeral: true }).catch(() => null);
    }

    if (sub === "set") {
      const modal = new ModalBuilder()
        .setCustomId("lurker_modal_set")
        .setTitle("🟢 Lurker Rule (Emerald)");

      const chain = new TextInputBuilder()
        .setCustomId("chain")
        .setLabel("Chain (eth/base/ape)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setValue("base");

      const contract = new TextInputBuilder()
        .setCustomId("contract")
        .setLabel("Contract Address (0x...)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      const opensea = new TextInputBuilder()
        .setCustomId("opensea")
        .setLabel("OpenSea slug or URL (recommended)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false);

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
        new ActionRowBuilder().addComponents(opensea),
        new ActionRowBuilder().addComponents(rarityMax),
        new ActionRowBuilder().addComponents(traitsJson),
        new ActionRowBuilder().addComponents(maxPrice)
      );

      return interaction.showModal(modal);
    }

    if (sub === "quick") {
      const chain = cleanLower(interaction.options.getString("chain"));
      const contract = cleanLower(interaction.options.getString("contract"));
      const openseaRaw = (interaction.options.getString("opensea") || "").trim();
      const osSlug = extractOpenSeaSlug(openseaRaw);

      const rarityMax = interaction.options.getInteger("rarity_max");
      const traitsJson = (interaction.options.getString("traits_json") || "").trim();
      const maxPrice = (interaction.options.getString("max_price_native") || "").trim();
      const channelId = (interaction.options.getString("channel_id") || "").trim()
        || (process.env.LURKER_DEFAULT_CHANNEL_ID || "").trim()
        || null;

      if (!["eth", "base", "ape"].includes(chain)) {
        return interaction.reply({ content: "Chain must be eth/base/ape", ephemeral: true }).catch(() => null);
      }
      if (!contract.startsWith("0x") || contract.length < 42) {
        return interaction.reply({ content: "Contract address looks invalid.", ephemeral: true }).catch(() => null);
      }
      if (traitsJson && !safeJsonParse(traitsJson)) {
        return interaction.reply({ content: "Traits JSON is invalid JSON.", ephemeral: true }).catch(() => null);
      }
      if (openseaRaw && !osSlug) {
        return interaction.reply({
          content: "OpenSea value must be a slug like `cryptopimps-1` or a URL like `https://opensea.io/collection/cryptopimps-1`.",
          ephemeral: true
        }).catch(() => null);
      }

      const pg = client.pg;
      const ins = await pg.query(
        `
        INSERT INTO lurker_rules(guild_id, chain, contract, opensea_slug, channel_id, rarity_max, traits_json, max_price_native, auto_buy, created_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
        RETURNING id
        `,
        [
          interaction.guildId,
          chain,
          contract,
          osSlug || null,
          channelId,
          rarityMax ?? null,
          traitsJson || null,
          maxPrice || null,
          interaction.user?.id || null
        ]
      );

      const id = ins.rows?.[0]?.id;
      return interaction.reply({
        content:
          `🟢 Lurker rule created: **#${id}**\n` +
          `Chain: **${chain}**\n` +
          `Contract: \`${contract}\`\n` +
          (osSlug ? `OpenSea: **${osSlug}**\n` : `OpenSea: _(not set — may fallback to v1)_\n`) +
          `Channel: ${channelId ? `<#${channelId}>` : "(missing)"}`,
        ephemeral: true
      }).catch(() => null);
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
        `SELECT id, chain, contract, opensea_slug, enabled, rarity_max, max_price_native, auto_buy, channel_id
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
        .setDescription(rows.length ? "Your current Lurker rules:" : "No rules yet. Use `/lurker set` or `/lurker quick`.")
        .setTimestamp(new Date());

      for (const r of rows) {
        embed.addFields({
          name: `Rule #${r.id} — ${String(r.chain || "").toUpperCase()} — ${String(r.contract).slice(0, 8)}…`,
          value: [
            `Enabled: **${r.enabled ? "YES" : "NO"}**`,
            r.opensea_slug ? `OpenSea: **${String(r.opensea_slug)}**` : `OpenSea: _none_`,
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
  async handleModal(interaction, ctx) {
    const client = resolveClient(ctx, interaction);

    if (interaction.customId !== "lurker_modal_set") return false;

    if (!isOwner(interaction)) {
      await interaction.reply({ content: "Owner-only for now (set BOT_OWNER_ID).", ephemeral: true }).catch(() => null);
      return true;
    }

    await requireSchema(client);

    const chain = cleanLower(interaction.fields.getTextInputValue("chain"));
    const contract = cleanLower(interaction.fields.getTextInputValue("contract"));
    const openseaRaw = (interaction.fields.getTextInputValue("opensea") || "").trim();
    const osSlug = extractOpenSeaSlug(openseaRaw);

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
    if (traitsJson && !safeJsonParse(traitsJson)) {
      await interaction.reply({ content: "Traits JSON is invalid JSON.", ephemeral: true }).catch(() => null);
      return true;
    }
    if (openseaRaw && !osSlug) {
      await interaction.reply({
        content: "OpenSea must be a slug like `cryptopimps-1` or a URL like `https://opensea.io/collection/cryptopimps-1`.",
        ephemeral: true
      }).catch(() => null);
      return true;
    }

    const pg = client.pg;

    const ins = await pg.query(
      `
      INSERT INTO lurker_rules(guild_id, chain, contract, opensea_slug, channel_id, rarity_max, traits_json, max_price_native, auto_buy, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9)
      RETURNING id
      `,
      [
        interaction.guildId,
        chain,
        contract,
        osSlug || null,
        (process.env.LURKER_DEFAULT_CHANNEL_ID || "").trim() || null,
        rarityMax ? Number(rarityMax) : null,
        traitsJson || null,
        maxPrice || null,
        interaction.user?.id || null
      ]
    );

    const id = ins.rows?.[0]?.id;

    await interaction.reply({
      content:
        `🟢 Lurker rule created: **#${id}**\n` +
        `Chain: **${chain}**\n` +
        `Contract: \`${contract}\`\n` +
        (osSlug ? `OpenSea: **${osSlug}**` : `OpenSea: _(not set — may fallback to v1)_`),
      ephemeral: true
    }).catch(() => null);

    return true;
  }
};
