// commands/gift.js
// ======================================================
// /gift config  (Step 2)
// - Admin sets default Gift Drop Guess settings per guild
// - Stores to Postgres (gift_config) + audit (gift_audit)
// - Works even if schema init didn't run yet (calls ensureGiftSchema)
// ======================================================

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
} = require("discord.js");

let ensureGiftSchema = null;
try {
  const mod = require("../services/gift/ensureGiftSchema");
  if (mod && typeof mod.ensureGiftSchema === "function") ensureGiftSchema = mod.ensureGiftSchema;
} catch {}

function intOrNull(v) {
  if (v === undefined || v === null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return n;
  return Math.max(min, Math.min(max, n));
}

function safeStr(v, max = 140) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

async function upsertGiftConfig(pg, row) {
  // Insert or update full row for the guild
  const q = `
    INSERT INTO gift_config (
      guild_id,
      channel_id,
      mode_default,
      allow_public_mode,
      allow_modal_mode,
      range_min_default,
      range_max_default,
      duration_sec_default,
      per_user_cooldown_ms,
      max_guesses_per_user,
      hints_mode,
      announce_channel_id,
      created_at,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      COALESCE($13, NOW()),
      NOW()
    )
    ON CONFLICT (guild_id) DO UPDATE SET
      channel_id = EXCLUDED.channel_id,
      mode_default = EXCLUDED.mode_default,
      allow_public_mode = EXCLUDED.allow_public_mode,
      allow_modal_mode = EXCLUDED.allow_modal_mode,
      range_min_default = EXCLUDED.range_min_default,
      range_max_default = EXCLUDED.range_max_default,
      duration_sec_default = EXCLUDED.duration_sec_default,
      per_user_cooldown_ms = EXCLUDED.per_user_cooldown_ms,
      max_guesses_per_user = EXCLUDED.max_guesses_per_user,
      hints_mode = EXCLUDED.hints_mode,
      announce_channel_id = EXCLUDED.announce_channel_id,
      updated_at = NOW()
    RETURNING *;
  `;
  const values = [
    row.guild_id,
    row.channel_id,
    row.mode_default,
    row.allow_public_mode,
    row.allow_modal_mode,
    row.range_min_default,
    row.range_max_default,
    row.duration_sec_default,
    row.per_user_cooldown_ms,
    row.max_guesses_per_user,
    row.hints_mode,
    row.announce_channel_id,
    row.created_at || null,
  ];
  const res = await pg.query(q, values);
  return res.rows?.[0] || null;
}

async function writeAudit(pg, { guild_id, game_id = null, action, actor_user_id, actor_tag, details }) {
  try {
    await pg.query(
      `
      INSERT INTO gift_audit (guild_id, game_id, action, actor_user_id, actor_tag, details)
      VALUES ($1,$2,$3,$4,$5,$6)
      `,
      [guild_id, game_id, action, actor_user_id, actor_tag, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    // audit should never break command
    console.warn("⚠️ [GIFT] audit insert failed:", e?.message || e);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName("gift")
    .setDescription("🎁 Gift Drop Guess Game settings + controls")
    .addSubcommand((sub) =>
      sub
        .setName("config")
        .setDescription("Configure default Gift Drop settings for this server (admin)")
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Default channel for gift drops")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName("announce_channel")
            .setDescription("Optional: separate channel for big winner announcements")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("mode_default")
            .setDescription("Default play mode")
            .addChoices(
              { name: "Modern (modal)", value: "modal" },
              { name: "Public (chat guesses)", value: "public" }
            )
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("allow_modal")
            .setDescription("Allow modern modal mode at all")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("allow_public")
            .setDescription("Allow public chat mode at all")
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("range_min")
            .setDescription("Default minimum number (ex: 1)")
            .setMinValue(0)
            .setMaxValue(1000000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("range_max")
            .setDescription("Default maximum number (ex: 100)")
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("duration_sec")
            .setDescription("Default game duration in seconds (ex: 600 = 10 minutes)")
            .setMinValue(10)
            .setMaxValue(86400)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("cooldown_ms")
            .setDescription("Per-user guess cooldown in ms (ex: 6000)")
            .setMinValue(0)
            .setMaxValue(600000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("max_guesses")
            .setDescription("Max guesses per user per game (ex: 25)")
            .setMinValue(1)
            .setMaxValue(1000)
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("hints")
            .setDescription("Hint style (best used for modal mode)")
            .addChoices(
              { name: "None", value: "none" },
              { name: "High / Low", value: "highlow" },
              { name: "Hot / Warm / Cold", value: "hotcold" }
            )
            .setRequired(false)
        )
    )
    // Permissions are enforced manually so the command still registers cleanly
    .setDMPermission(false),

  async execute(interaction) {
    try {
      if (!interaction.guildId) {
        return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();
      if (sub !== "config") {
        return interaction.reply({ content: "Not implemented yet. Next steps will add start/stop/review.", ephemeral: true });
      }

      // Admin/manager check
      const perms = interaction.memberPermissions;
      const allowed =
        perms?.has(PermissionFlagsBits.Administrator) ||
        perms?.has(PermissionFlagsBits.ManageGuild);

      if (!allowed) {
        return interaction.reply({
          content: "⛔ You need **Manage Server** (or Administrator) to configure Gift Drops.",
          ephemeral: true,
        });
      }

      const pg = interaction.client?.pg;
      if (!pg?.query) {
        return interaction.reply({
          content: "❌ Database not ready (client.pg missing). Check Railway Postgres + DATABASE_URL.",
          ephemeral: true,
        });
      }

      // Ensure schema exists (safe even if already ran on boot)
      if (ensureGiftSchema) {
        const ok = await ensureGiftSchema(interaction.client);
        if (!ok) {
          return interaction.reply({
            content: "❌ Gift schema init failed. Check logs for `[GIFT] schema init failed`.",
            ephemeral: true,
          });
        }
      }

      // Load existing row (if any)
      const gid = interaction.guildId;
      const existing = await pg.query(`SELECT * FROM gift_config WHERE guild_id=$1`, [gid]);
      const cur = existing.rows?.[0] || null;

      // Extract options
      const channel = interaction.options.getChannel("channel");
      const announceChannel = interaction.options.getChannel("announce_channel");
      const modeDefault = interaction.options.getString("mode_default");
      const allowModal = interaction.options.getBoolean("allow_modal");
      const allowPublic = interaction.options.getBoolean("allow_public");
      const rangeMin = intOrNull(interaction.options.getInteger("range_min"));
      const rangeMax = intOrNull(interaction.options.getInteger("range_max"));
      const durationSec = intOrNull(interaction.options.getInteger("duration_sec"));
      const cooldownMs = intOrNull(interaction.options.getInteger("cooldown_ms"));
      const maxGuesses = intOrNull(interaction.options.getInteger("max_guesses"));
      const hints = interaction.options.getString("hints");

      // Merge with defaults (keep current if not provided)
      const row = {
        guild_id: gid,
        channel_id: (channel?.id ?? cur?.channel_id ?? null),
        announce_channel_id: (announceChannel?.id ?? cur?.announce_channel_id ?? null),

        mode_default: (modeDefault ?? cur?.mode_default ?? "modal"),
        allow_modal_mode: (allowModal ?? cur?.allow_modal_mode ?? true),
        allow_public_mode: (allowPublic ?? cur?.allow_public_mode ?? true),

        range_min_default: (rangeMin ?? cur?.range_min_default ?? 1),
        range_max_default: (rangeMax ?? cur?.range_max_default ?? 100),

        duration_sec_default: (durationSec ?? cur?.duration_sec_default ?? 600),
        per_user_cooldown_ms: (cooldownMs ?? cur?.per_user_cooldown_ms ?? 6000),
        max_guesses_per_user: (maxGuesses ?? cur?.max_guesses_per_user ?? 25),

        hints_mode: (hints ?? cur?.hints_mode ?? "highlow"),

        created_at: cur?.created_at || null,
      };

      // Sanity clamps + ordering
      row.range_min_default = clampInt(Number(row.range_min_default), 0, 1000000);
      row.range_max_default = clampInt(Number(row.range_max_default), 1, 1000000);
      if (row.range_max_default <= row.range_min_default) {
        // auto-fix: make max = min+1
        row.range_max_default = row.range_min_default + 1;
      }
      row.duration_sec_default = clampInt(Number(row.duration_sec_default), 10, 86400);
      row.per_user_cooldown_ms = clampInt(Number(row.per_user_cooldown_ms), 0, 600000);
      row.max_guesses_per_user = clampInt(Number(row.max_guesses_per_user), 1, 1000);

      // If admin disables a mode but sets it as default, auto-correct
      if (row.mode_default === "modal" && !row.allow_modal_mode && row.allow_public_mode) {
        row.mode_default = "public";
      }
      if (row.mode_default === "public" && !row.allow_public_mode && row.allow_modal_mode) {
        row.mode_default = "modal";
      }

      const saved = await upsertGiftConfig(pg, row);

      await writeAudit(pg, {
        guild_id: gid,
        action: "config_update",
        actor_user_id: interaction.user.id,
        actor_tag: interaction.user.tag,
        details: {
          channel_id: saved?.channel_id || null,
          announce_channel_id: saved?.announce_channel_id || null,
          mode_default: saved?.mode_default,
          allow_modal_mode: saved?.allow_modal_mode,
          allow_public_mode: saved?.allow_public_mode,
          range_min_default: saved?.range_min_default,
          range_max_default: saved?.range_max_default,
          duration_sec_default: saved?.duration_sec_default,
          per_user_cooldown_ms: saved?.per_user_cooldown_ms,
          max_guesses_per_user: saved?.max_guesses_per_user,
          hints_mode: saved?.hints_mode,
        },
      });

      const chStr = saved?.channel_id ? `<#${saved.channel_id}>` : "Not set";
      const annStr = saved?.announce_channel_id ? `<#${saved.announce_channel_id}>` : "Not set";

      const embed = new EmbedBuilder()
        .setTitle("🎁 Gift Drop Config Saved")
        .setDescription("These are the **default** settings for this server. Next step will add `/gift start`.")
        .addFields(
          { name: "Default Channel", value: chStr, inline: true },
          { name: "Announce Channel", value: annStr, inline: true },
          { name: "Default Mode", value: `\`${safeStr(saved?.mode_default || "modal")}\``, inline: true },

          { name: "Allow Modes", value: `modal: **${saved?.allow_modal_mode ? "ON" : "OFF"}** | public: **${saved?.allow_public_mode ? "ON" : "OFF"}**`, inline: false },

          { name: "Range", value: `\`${saved?.range_min_default} → ${saved?.range_max_default}\``, inline: true },
          { name: "Duration", value: `\`${saved?.duration_sec_default}s\``, inline: true },
          { name: "Hints", value: `\`${safeStr(saved?.hints_mode || "highlow")}\``, inline: true },

          { name: "Cooldown", value: `\`${saved?.per_user_cooldown_ms}ms\``, inline: true },
          { name: "Max Guesses/User", value: `\`${saved?.max_guesses_per_user}\``, inline: true }
        )
        .setFooter({ text: "Next: /gift start (modal/public, secret number, commit proof, prize reveal)" });

      return interaction.reply({ embeds: [embed], ephemeral: true });
    } catch (err) {
      console.error("❌ /gift config error:", err);
      try {
        return interaction.reply({
          content: "❌ Gift config failed. Check Railway logs for `/gift config error`.",
          ephemeral: true,
        });
      } catch {}
    }
  },
};
