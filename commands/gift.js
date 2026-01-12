// commands/gift.js
// ======================================================
// /gift config  (Step 2)
// /gift start   (Step 3)  ✅ ADDED NOW
//
// - Admin config stored per guild in gift_config
// - /gift start creates a game row (gift_games) + posts the 🎁 Drop Card
// - Guess handling (button -> modal submit + public chat mode) comes NEXT step
// ======================================================

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const crypto = require("crypto");

let ensureGiftSchema = null;
try {
  const mod = require("../services/gift/ensureGiftSchema");
  if (mod && typeof mod.ensureGiftSchema === "function") ensureGiftSchema = mod.ensureGiftSchema;
} catch {}

const GIFT_BOX_GIF =
  (process.env.GIFT_BOX_GIF || "").trim() ||
  "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif"; // fallback placeholder

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

function discordMessageUrl(guildId, channelId, messageId) {
  if (!guildId || !channelId || !messageId) return null;
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

function pickRandomInt(min, max) {
  // inclusive
  const a = Math.trunc(Number(min));
  const b = Math.trunc(Number(max));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  const span = hi - lo + 1;
  const r = crypto.randomInt(0, span);
  return lo + r;
}

function sha256Hex(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function randomSaltHex(bytes = 16) {
  return crypto.randomBytes(bytes).toString("hex");
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

async function upsertGiftConfig(pg, row) {
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

async function getGiftConfig(pg, guildId) {
  const r = await pg.query(`SELECT * FROM gift_config WHERE guild_id=$1`, [guildId]);
  return r.rows?.[0] || null;
}

async function getActiveGiftGame(pg, guildId) {
  const r = await pg.query(
    `SELECT * FROM gift_games WHERE guild_id=$1 AND status='active' ORDER BY started_at DESC LIMIT 1`,
    [guildId]
  );
  return r.rows?.[0] || null;
}

async function createGiftGameRow(pg, game) {
  const q = `
    INSERT INTO gift_games (
      guild_id, channel_id, thread_id,
      created_by, created_by_tag,
      mode, status,
      range_min, range_max,
      target_number, target_source,
      commit_hash, commit_salt, commit_enabled,
      prize_type, prize_label, prize_secret, prize_payload,
      started_at, ends_at,
      per_user_cooldown_ms, max_guesses_per_user, hints_mode,
      notes
    ) VALUES (
      $1,$2,$3,
      $4,$5,
      $6,'active',
      $7,$8,
      $9,$10,
      $11,$12,$13,
      $14,$15,$16,$17,
      NOW(), $18,
      $19,$20,$21,
      $22
    )
    RETURNING *;
  `;
  const vals = [
    game.guild_id,
    game.channel_id,
    game.thread_id || null,

    game.created_by,
    game.created_by_tag || null,

    game.mode,

    game.range_min,
    game.range_max,

    game.target_number,
    game.target_source,

    game.commit_hash || null,
    game.commit_salt || null,
    Boolean(game.commit_enabled),

    game.prize_type || "text",
    game.prize_label || null,
    Boolean(game.prize_secret),
    game.prize_payload ? JSON.stringify(game.prize_payload) : null,

    game.ends_at, // timestamptz

    game.per_user_cooldown_ms,
    game.max_guesses_per_user,
    game.hints_mode,

    game.notes || null,
  ];

  const res = await pg.query(q, vals);
  return res.rows?.[0] || null;
}

async function attachDropMessage(pg, { gameId, messageId, messageUrl }) {
  await pg.query(
    `UPDATE gift_games SET drop_message_id=$1, drop_message_url=$2 WHERE id=$3`,
    [String(messageId), messageUrl || null, gameId]
  );
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
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Start a Mystery Gift Drop Guess Game (admin)")
        .addStringOption((opt) =>
          opt
            .setName("mode")
            .setDescription("Game mode for this round")
            .addChoices(
              { name: "Modern (modal)", value: "modal" },
              { name: "Public (chat guesses)", value: "public" }
            )
            .setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName("channel")
            .setDescription("Channel to run this game in (overrides default)")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("range_min")
            .setDescription("Minimum number for this round")
            .setMinValue(0)
            .setMaxValue(1000000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("range_max")
            .setDescription("Maximum number for this round")
            .setMinValue(1)
            .setMaxValue(1000000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("target")
            .setDescription("Secret target number (leave empty to random)")
            .setMinValue(0)
            .setMaxValue(1000000)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("duration_sec")
            .setDescription("Duration in seconds (ex: 600 = 10 minutes)")
            .setMinValue(10)
            .setMaxValue(86400)
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("commit")
            .setDescription("Enable fairness proof (commit hash revealed at end)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("prize_type")
            .setDescription("What kind of prize this is")
            .addChoices(
              { name: "Text", value: "text" },
              { name: "NFT", value: "nft" },
              { name: "Token", value: "token" },
              { name: "Role", value: "role" },
              { name: "URL", value: "url" }
            )
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("prize_label")
            .setDescription('Prize label (ex: "CryptoPimps #???", "50,000 $ADRIAN")')
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("prize_secret")
            .setDescription("Hide prize until reveal (recommended)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("prize_json")
            .setDescription('Optional JSON payload (ex: {"contract":"0x..","tokenId":"123"})')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("notes")
            .setDescription("Optional admin notes for review later")
            .setRequired(false)
        )
    )
    .setDMPermission(false),

  async execute(interaction) {
    try {
      if (!interaction.guildId) {
        return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();

      // Admin/manager check for config + start
      const perms = interaction.memberPermissions;
      const allowed =
        perms?.has(PermissionFlagsBits.Administrator) ||
        perms?.has(PermissionFlagsBits.ManageGuild);

      if (!allowed) {
        return interaction.reply({
          content: "⛔ You need **Manage Server** (or Administrator) for Gift admin controls.",
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

      // =========================
      // /gift config (Step 2)
      // =========================
      if (sub === "config") {
        const existing = await pg.query(`SELECT * FROM gift_config WHERE guild_id=$1`, [interaction.guildId]);
        const cur = existing.rows?.[0] || null;

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

        const row = {
          guild_id: interaction.guildId,
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

        row.range_min_default = clampInt(Number(row.range_min_default), 0, 1000000);
        row.range_max_default = clampInt(Number(row.range_max_default), 1, 1000000);
        if (row.range_max_default <= row.range_min_default) row.range_max_default = row.range_min_default + 1;

        row.duration_sec_default = clampInt(Number(row.duration_sec_default), 10, 86400);
        row.per_user_cooldown_ms = clampInt(Number(row.per_user_cooldown_ms), 0, 600000);
        row.max_guesses_per_user = clampInt(Number(row.max_guesses_per_user), 1, 1000);

        if (row.mode_default === "modal" && !row.allow_modal_mode && row.allow_public_mode) row.mode_default = "public";
        if (row.mode_default === "public" && !row.allow_public_mode && row.allow_modal_mode) row.mode_default = "modal";

        const saved = await upsertGiftConfig(pg, row);

        await writeAudit(pg, {
          guild_id: interaction.guildId,
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
          .setDescription("These are the **default** settings for this server.")
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
          .setFooter({ text: "Next: /gift start (posts the gift drop card)" });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // =========================
      // /gift start (Step 3)
      // =========================
      if (sub === "start") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;

        // Block if already active
        const active = await getActiveGiftGame(pg, gid);
        if (active) {
          return interaction.editReply(
            `⚠️ A Gift game is already **active** in <#${active.channel_id}> (gameId: \`${active.id}\`).\n` +
              `End it first (next step will add \`/gift stop\`).`
          );
        }

        const cfg = await getGiftConfig(pg, gid);

        // Resolve channel
        const channelOpt = interaction.options.getChannel("channel");
        const channelId =
          channelOpt?.id ||
          cfg?.channel_id ||
          interaction.channelId;

        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.editReply("❌ Could not resolve a valid text channel for the game. Set one via `/gift config channel:#...`.");
        }

        // Resolve mode
        const modeOpt = interaction.options.getString("mode");
        let mode = (modeOpt || cfg?.mode_default || "modal").toLowerCase();
        const allowModal = cfg?.allow_modal_mode ?? true;
        const allowPublic = cfg?.allow_public_mode ?? true;

        if (mode === "modal" && !allowModal && allowPublic) mode = "public";
        if (mode === "public" && !allowPublic && allowModal) mode = "modal";

        if (mode === "modal" && !allowModal) {
          return interaction.editReply("❌ Modal mode is disabled for this server. Enable it via `/gift config allow_modal:true`.");
        }
        if (mode === "public" && !allowPublic) {
          return interaction.editReply("❌ Public mode is disabled for this server. Enable it via `/gift config allow_public:true`.");
        }

        // Range
        const rangeMin = intOrNull(interaction.options.getInteger("range_min"));
        const rangeMax = intOrNull(interaction.options.getInteger("range_max"));

        let rMin = rangeMin ?? cfg?.range_min_default ?? 1;
        let rMax = rangeMax ?? cfg?.range_max_default ?? 100;

        rMin = clampInt(Number(rMin), 0, 1000000);
        rMax = clampInt(Number(rMax), 1, 1000000);
        if (rMax <= rMin) rMax = rMin + 1;

        // Duration
        const durationOpt = intOrNull(interaction.options.getInteger("duration_sec"));
        const durationSec = clampInt(Number(durationOpt ?? cfg?.duration_sec_default ?? 600), 10, 86400);

        // Cooldown + max guesses snapshot
        const perUserCooldownMs = clampInt(Number(cfg?.per_user_cooldown_ms ?? 6000), 0, 600000);
        const maxGuessesPerUser = clampInt(Number(cfg?.max_guesses_per_user ?? 25), 1, 1000);
        const hintsMode = String(cfg?.hints_mode ?? "highlow").toLowerCase();

        // Target
        const targetOpt = intOrNull(interaction.options.getInteger("target"));
        let targetNumber = null;
        let targetSource = "random";
        if (targetOpt !== null) {
          targetNumber = clampInt(Number(targetOpt), 0, 1000000);
          targetSource = "admin";
        } else {
          targetNumber = pickRandomInt(rMin, rMax);
          targetSource = "random";
        }

        // Commit proof
        const commit = Boolean(interaction.options.getBoolean("commit") ?? false);
        let commitSalt = null;
        let commitHash = null;
        if (commit) {
          commitSalt = randomSaltHex(16);
          commitHash = sha256Hex(`${targetNumber}:${commitSalt}`);
        }

        // Prize
        const prizeType = (interaction.options.getString("prize_type") || "text").toLowerCase();
        const prizeLabel = safeStr(interaction.options.getString("prize_label") || "Mystery prize 🎁", 200);
        const prizeSecret = Boolean(interaction.options.getBoolean("prize_secret") ?? true);

        const prizeJsonRaw = interaction.options.getString("prize_json");
        let prizePayload = null;
        if (prizeJsonRaw && String(prizeJsonRaw).trim()) {
          try {
            const parsed = JSON.parse(String(prizeJsonRaw));
            if (parsed && typeof parsed === "object") prizePayload = parsed;
          } catch {
            // keep null, but log for admin clarity
            prizePayload = { _error: "invalid_json", raw: String(prizeJsonRaw).slice(0, 300) };
          }
        }

        const notes = safeStr(interaction.options.getString("notes") || "", 400);

        // Ends at
        const endsAt = new Date(Date.now() + durationSec * 1000).toISOString();

        // Create DB game row first
        const gameRow = await createGiftGameRow(pg, {
          guild_id: gid,
          channel_id: channel.id,
          thread_id: null,
          created_by: interaction.user.id,
          created_by_tag: interaction.user.tag,

          mode,
          range_min: rMin,
          range_max: rMax,

          target_number: targetNumber,
          target_source: targetSource,

          commit_enabled: commit,
          commit_salt: commitSalt,
          commit_hash: commitHash,

          prize_type: prizeType,
          prize_label: prizeLabel,
          prize_secret: prizeSecret,
          prize_payload: prizePayload,

          ends_at: endsAt,

          per_user_cooldown_ms: perUserCooldownMs,
          max_guesses_per_user: maxGuessesPerUser,
          hints_mode: hintsMode,

          notes,
        });

        if (!gameRow?.id) {
          return interaction.editReply("❌ Failed to create game row in DB.");
        }

        await writeAudit(pg, {
          guild_id: gid,
          game_id: gameRow.id,
          action: "start",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: {
            mode,
            range_min: rMin,
            range_max: rMax,
            duration_sec: durationSec,
            target_source: targetSource,
            commit_enabled: commit,
            prize_type: prizeType,
            prize_secret: prizeSecret,
          },
        });

        // Build Drop Card message + buttons
        const showPrizeLine = prizeSecret ? "??? (reveals when someone wins)" : prizeLabel;

        const embed = new EmbedBuilder()
          .setTitle("🎁 MYSTERY GIFT DROP")
          .setDescription(
            [
              `**Guess the secret number!**`,
              ``,
              `**Range:** \`${rMin} → ${rMax}\``,
              `**Mode:** \`${mode}\``,
              `**Ends:** <t:${Math.floor(Date.now() / 1000 + durationSec)}:R>`,
              `**Prize:** ${showPrizeLine}`,
              commit ? `**Fairness:** Commit hash locked ✅` : `**Fairness:** Standard`,
              ``,
              mode === "modal"
                ? `Click **🎯 Guess** to submit your number (no chat spam).`
                : `Type your guess as a number in this channel (example: \`42\`).`,
            ].join("\n")
          )
          .setThumbnail(GIFT_BOX_GIF)
          .setFooter({ text: `Game ID: ${gameRow.id}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gift_guess:${gameRow.id}`)
            .setLabel("Guess")
            .setEmoji("🎯")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(mode !== "modal"), // public mode doesn't use button for guesses
          new ButtonBuilder()
            .setCustomId(`gift_rules:${gameRow.id}`)
            .setLabel("Rules")
            .setEmoji("📜")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`gift_stats:${gameRow.id}`)
            .setLabel("Stats")
            .setEmoji("📊")
            .setStyle(ButtonStyle.Secondary)
        );

        const dropMsg = await channel.send({ embeds: [embed], components: [row] });

        const msgUrl = discordMessageUrl(gid, channel.id, dropMsg.id);
        await attachDropMessage(pg, { gameId: gameRow.id, messageId: dropMsg.id, messageUrl: msgUrl });

        return interaction.editReply(
          `✅ Gift Drop started in <#${channel.id}> (gameId: \`${gameRow.id}\`).\n` +
            `Next step: I’ll add the **Guess handler** (button→modal submit + public chat parsing) so the game can actually be won.`
        );
      }

      // Fallback
      return interaction.reply({ content: "Not implemented yet.", ephemeral: true });
    } catch (err) {
      console.error("❌ /gift error:", err);
      try {
        if (interaction.deferred || interaction.replied) {
          return interaction.editReply("❌ Gift command failed. Check Railway logs for `/gift error`.");
        }
        return interaction.reply({ content: "❌ Gift command failed. Check Railway logs.", ephemeral: true });
      } catch {}
    }
  },
};
