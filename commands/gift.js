// commands/gift.js
// ======================================================
// /gift config  (PUBLIC ONLY)
// /gift start   (Wizard Start + Clean Drop Card) ✅ UPDATED (public-only defaults)
// /gift stop    ✅
// /gift review  ✅ (POSTS PUBLICLY INTO CHANNEL)
// /gift audit   ✅ (posts audit into channel)
// /gift dbcheck ✅ (posts DB fingerprint + gift table counts into channel)
//
// NOTE: Runtime gameplay is handled by listeners/giftGameListener.js
//
// PATCH:
// ✅ Remove prize type "ROLE" entirely (UI + wizard flow)
// ✅ Keep only NFT / TOKEN / TEXT
// ✅ Keep defaults: prize_secret=true, commit=true, mode=public
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
  const r = await pg.query(`SELECT * FROM gift_games WHERE guild_id=$1 AND status='active' ORDER BY started_at DESC LIMIT 1`, [
    guildId,
  ]);
  return r.rows?.[0] || null;
}

async function getGiftGameById(pg, gameId) {
  const r = await pg.query(`SELECT * FROM gift_games WHERE id=$1 LIMIT 1`, [gameId]);
  return r.rows?.[0] || null;
}

async function createGiftGameRow(pg, game) {
  // NOTE: started_at uses NOW() special path below (kept for stability)
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
      $6,$7,
      $8,$9,
      $10,$11,
      $12,$13,$14,
      $15,$16,$17,$18,
      $19, $20,
      $21,$22,$23,
      $24
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
    game.status || "active",

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

    game.started_at || "NOW()",
    game.ends_at,

    game.per_user_cooldown_ms,
    game.max_guesses_per_user,
    game.hints_mode,

    game.notes || null,
  ];

  try {
    const startedAtIsNow = game.started_at === "NOW()";
    if (startedAtIsNow) {
      const q2 = `
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
          $6,$7,
          $8,$9,
          $10,$11,
          $12,$13,$14,
          $15,$16,$17,$18,
          NOW(), $19,
          $20,$21,$22,
          $23
        )
        RETURNING *;
      `;
      const v2 = [
        game.guild_id,
        game.channel_id,
        game.thread_id || null,

        game.created_by,
        game.created_by_tag || null,

        game.mode,
        game.status || "active",

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

        game.ends_at,

        game.per_user_cooldown_ms,
        game.max_guesses_per_user,
        game.hints_mode,

        game.notes || null,
      ];
      const res2 = await pg.query(q2, v2);
      return res2.rows?.[0] || null;
    }

    const res = await pg.query(q, vals);
    return res.rows?.[0] || null;
  } catch (e) {
    console.warn("⚠️ [GIFT] createGiftGameRow failed:", e?.message || e);
    return null;
  }
}

async function disableAllComponents(components) {
  try {
    if (!Array.isArray(components)) return [];
    return components.map((row) => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components = newRow.components.map((c) => {
        const b = ButtonBuilder.from(c);
        b.setDisabled(true);
        return b;
      });
      return newRow;
    });
  } catch {
    return [];
  }
}

function fmtStatus(s) {
  const v = String(s || "").toLowerCase();
  if (v === "active") return "🟢 active";
  if (v === "draft") return "🟡 draft";
  if (v === "ended") return "🏁 ended";
  if (v === "expired") return "⏳ expired";
  if (v === "cancelled") return "🛑 cancelled";
  return v || "unknown";
}

async function safeCount(pg, tableName) {
  try {
    const r = await pg.query(`SELECT COUNT(*)::int AS n FROM ${tableName}`);
    return Number(r.rows?.[0]?.n || 0);
  } catch (e) {
    return `ERR: ${e?.message || e}`;
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
          opt.setName("channel").setDescription("Default channel for gift drops").addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addChannelOption((opt) =>
          opt
            .setName("announce_channel")
            .setDescription("Optional: separate channel for big winner announcements")
            .addChannelTypes(ChannelType.GuildText)
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("range_min").setDescription("Default minimum number (ex: 1)").setMinValue(0).setMaxValue(1000000).setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("range_max").setDescription("Default maximum number (ex: 100)").setMinValue(1).setMaxValue(1000000).setRequired(false)
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
          opt.setName("cooldown_ms").setDescription("Per-user guess cooldown in ms (ex: 6000)").setMinValue(0).setMaxValue(600000).setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("max_guesses").setDescription("Max guesses per user per game (ex: 25)").setMinValue(1).setMaxValue(1000).setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("hints")
            .setDescription("Hint style")
            .addChoices({ name: "None", value: "none" }, { name: "High / Low", value: "highlow" }, { name: "Hot / Warm / Cold", value: "hotcold" })
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("start")
        .setDescription("Start a Gift Drop (Wizard UI) (admin) — PUBLIC MODE ONLY")
        .addChannelOption((opt) =>
          opt.setName("channel").setDescription("Channel to run this game in (overrides default)").addChannelTypes(ChannelType.GuildText).setRequired(false)
        )
        .addIntegerOption((opt) => opt.setName("range_min").setDescription("Minimum number").setMinValue(0).setMaxValue(1000000).setRequired(false))
        .addIntegerOption((opt) => opt.setName("range_max").setDescription("Maximum number").setMinValue(1).setMaxValue(1000000).setRequired(false))
        .addIntegerOption((opt) =>
          opt.setName("target").setDescription("Secret target number (leave empty to random)").setMinValue(0).setMaxValue(1000000).setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt.setName("duration_sec").setDescription("Duration in seconds (ex: 600 = 10 minutes)").setMinValue(10).setMaxValue(86400).setRequired(false)
        )
        .addBooleanOption((opt) => opt.setName("commit").setDescription("Enable fairness proof (commit hash revealed at end)").setRequired(false))
        .addBooleanOption((opt) => opt.setName("prize_secret").setDescription("Hide prize until reveal (recommended)").setRequired(false))
        .addStringOption((opt) => opt.setName("notes").setDescription("Optional admin notes for review later").setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setDescription("Stop the active gift game (admin)")
        .addStringOption((opt) => opt.setName("reason").setDescription("Optional reason (for audit/review)").setRequired(false))
        .addBooleanOption((opt) =>
          opt.setName("reveal_target").setDescription("Reveal the target number when stopping (admin-only info)").setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("review")
        .setDescription("Review a gift game (admin)")
        .addIntegerOption((opt) => opt.setName("game_id").setDescription("Game ID to review (leave empty for latest)").setMinValue(1).setRequired(false))
    )
    .addSubcommand((sub) =>
      sub
        .setName("audit")
        .setDescription("Post a visible audit log into this channel (admin)")
        .addIntegerOption((opt) => opt.setName("game_id").setDescription("Optional: audit a specific game id").setMinValue(1).setRequired(false))
        .addIntegerOption((opt) => opt.setName("limit").setDescription("How many rows to show (max 25)").setMinValue(1).setMaxValue(25).setRequired(false))
    )
    .addSubcommand((sub) => sub.setName("dbcheck").setDescription("Debug: post DB fingerprint + gift table health into this channel (admin)"))
    .setDMPermission(false),

  async execute(interaction) {
    try {
      if (!interaction.guildId) {
        return interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
      }

      const sub = interaction.options.getSubcommand();

      // Admin/manager check for all subcommands
      const perms = interaction.memberPermissions;
      const allowed = perms?.has(PermissionFlagsBits.Administrator) || perms?.has(PermissionFlagsBits.ManageGuild);

      if (!allowed) {
        return interaction.reply({
          content: "⛔ You need **Manage Server** (or Administrator) for Gift controls.",
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

      // Ensure schema exists (safe)
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
      // /gift dbcheck (posts into channel)
      // =========================
      if (sub === "dbcheck") {
        await interaction.deferReply({ ephemeral: true });

        let fp = null;
        try {
          const r = await pg.query(`
            SELECT
              current_database() AS db,
              current_user AS db_user,
              inet_server_addr() AS host,
              inet_server_port() AS port,
              version() AS version
          `);
          fp = r.rows?.[0] || null;
        } catch (e) {
          fp = { error: e?.message || String(e) };
        }

        const counts = {
          gift_config: await safeCount(pg, "gift_config"),
          gift_games: await safeCount(pg, "gift_games"),
          gift_audit: await safeCount(pg, "gift_audit"),
          gift_guesses: await safeCount(pg, "gift_guesses"),
          gift_user_state: await safeCount(pg, "gift_user_state"),
        };

        let recentGames = [];
        try {
          const r = await pg.query(`
            SELECT id, guild_id, status, mode, channel_id, started_at, ends_at, created_by_tag
            FROM gift_games
            ORDER BY id DESC
            LIMIT 5
          `);
          recentGames = r.rows || [];
        } catch {}

        let recentAudit = [];
        try {
          const r = await pg.query(`
            SELECT id, game_id, action, actor_tag, created_at
            FROM gift_audit
            ORDER BY id DESC
            LIMIT 8
          `);
          recentAudit = r.rows || [];
        } catch {}

        const lines = [];

        lines.push("**DB Fingerprint (where the bot is writing)**");
        if (fp?.error) {
          lines.push(`❌ ${fp.error}`);
        } else if (fp) {
          lines.push(`• db: \`${fp.db}\``);
          lines.push(`• user: \`${fp.db_user}\``);
          lines.push(`• host: \`${fp.host}\``);
          lines.push(`• port: \`${fp.port}\``);
        } else {
          lines.push("❌ Could not read fingerprint.");
        }

        lines.push("");
        lines.push("**Gift Table Counts**");
        for (const [k, v] of Object.entries(counts)) {
          lines.push(`• \`${k}\`: \`${v}\``);
        }

        lines.push("");
        lines.push("**Recent gift_games (last 5)**");
        if (recentGames.length) {
          for (const g of recentGames) {
            const st = g.started_at ? `<t:${Math.floor(new Date(g.started_at).getTime() / 1000)}:t>` : "—";
            lines.push(`• #${g.id} \`${g.status}\` \`${g.mode}\` ch:${g.channel_id} at:${st}`);
          }
        } else {
          lines.push("• (none or query failed)");
        }

        lines.push("");
        lines.push("**Recent gift_audit (last 8)**");
        if (recentAudit.length) {
          for (const a of recentAudit) {
            const ts = a.created_at ? `<t:${Math.floor(new Date(a.created_at).getTime() / 1000)}:t>` : "—";
            lines.push(`• ${ts} \`${a.action}\` game:${a.game_id ?? "-"} by:${a.actor_tag ?? "system"}`);
          }
        } else {
          lines.push("• (none or query failed)");
        }

        const embed = new EmbedBuilder()
          .setTitle("🧪 Gift DB Check")
          .setDescription(lines.join("\n").slice(0, 3900))
          .setFooter({ text: "If counts are 0 but games work, you're viewing a different DB than the bot uses." });

        await interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});

        await writeAudit(pg, {
          guild_id: interaction.guildId,
          game_id: null,
          action: "dbcheck_posted",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: { channel_id: interaction.channelId },
        });

        return interaction.editReply("✅ Posted DB check into this channel.");
      }

      // =========================
      // /gift config (PUBLIC ONLY)
      // =========================
      if (sub === "config") {
        const existing = await pg.query(`SELECT * FROM gift_config WHERE guild_id=$1`, [interaction.guildId]);
        const cur = existing.rows?.[0] || null;

        const channel = interaction.options.getChannel("channel");
        const announceChannel = interaction.options.getChannel("announce_channel");
        const rangeMin = intOrNull(interaction.options.getInteger("range_min"));
        const rangeMax = intOrNull(interaction.options.getInteger("range_max"));
        const durationSec = intOrNull(interaction.options.getInteger("duration_sec"));
        const cooldownMs = intOrNull(interaction.options.getInteger("cooldown_ms"));
        const maxGuesses = intOrNull(interaction.options.getInteger("max_guesses"));
        const hints = interaction.options.getString("hints");

        // ✅ Public-only defaults enforced here
        const row = {
          guild_id: interaction.guildId,
          channel_id: channel?.id ?? cur?.channel_id ?? null,
          announce_channel_id: announceChannel?.id ?? cur?.announce_channel_id ?? null,

          mode_default: "public",
          allow_public_mode: true,
          allow_modal_mode: false,

          range_min_default: rangeMin ?? cur?.range_min_default ?? 1,
          range_max_default: rangeMax ?? cur?.range_max_default ?? 100,

          duration_sec_default: durationSec ?? cur?.duration_sec_default ?? 600,
          per_user_cooldown_ms: cooldownMs ?? cur?.per_user_cooldown_ms ?? 6000,
          max_guesses_per_user: maxGuesses ?? cur?.max_guesses_per_user ?? 25,

          hints_mode: hints ?? cur?.hints_mode ?? "highlow",
          created_at: cur?.created_at || null,
        };

        row.range_min_default = clampInt(Number(row.range_min_default), 0, 1000000);
        row.range_max_default = clampInt(Number(row.range_max_default), 1, 1000000);
        if (row.range_max_default <= row.range_min_default) row.range_max_default = row.range_min_default + 1;

        row.duration_sec_default = clampInt(Number(row.duration_sec_default), 10, 86400);
        row.per_user_cooldown_ms = clampInt(Number(row.per_user_cooldown_ms), 0, 600000);
        row.max_guesses_per_user = clampInt(Number(row.max_guesses_per_user), 1, 1000);

        const saved = await upsertGiftConfig(pg, row);

        await writeAudit(pg, {
          guild_id: interaction.guildId,
          action: "config_update",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: {
            channel_id: saved?.channel_id || null,
            announce_channel_id: saved?.announce_channel_id || null,
            mode_default: "public",
            allow_public_mode: true,
            allow_modal_mode: false,
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
          .setTitle("🎁 Gift Drop Config Saved (Public Only)")
          .setDescription("These are the **default** settings for this server.")
          .addFields(
            { name: "Default Channel", value: chStr, inline: true },
            { name: "Announce Channel", value: annStr, inline: true },
            { name: "Mode", value: "`public`", inline: true },
            { name: "Range", value: `\`${saved?.range_min_default} → ${saved?.range_max_default}\``, inline: true },
            { name: "Duration", value: `\`${saved?.duration_sec_default}s\``, inline: true },
            { name: "Hints", value: `\`${safeStr(saved?.hints_mode || "highlow")}\``, inline: true },
            { name: "Cooldown", value: `\`${saved?.per_user_cooldown_ms}ms\``, inline: true },
            { name: "Max Guesses/User", value: `\`${saved?.max_guesses_per_user}\``, inline: true }
          )
          .setFooter({ text: "Use /gift start to open the wizard and launch a drop." });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // =========================
      // /gift audit  (posts into channel)
      // =========================
      if (sub === "audit") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;
        const gameId = intOrNull(interaction.options.getInteger("game_id"));
        const limit = clampInt(Number(intOrNull(interaction.options.getInteger("limit")) ?? 12), 1, 25);

        const params = [gid];
        let where = `guild_id=$1`;
        if (gameId) {
          params.push(gameId);
          where += ` AND game_id=$2`;
        }

        const r = await pg.query(
          `
          SELECT id, game_id, action, actor_user_id, actor_tag, details, created_at
          FROM gift_audit
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT ${limit}
          `,
          params
        );

        const rows = r.rows || [];

        const embed = new EmbedBuilder()
          .setTitle(`🧾 Gift Audit Log${gameId ? ` — Game #${gameId}` : ""}`)
          .setDescription(
            rows.length
              ? rows
                  .map((x) => {
                    const ts = x.created_at ? Math.floor(new Date(x.created_at).getTime() / 1000) : null;
                    const who = x.actor_user_id ? `<@${x.actor_user_id}>` : x.actor_tag ? `\`${x.actor_tag}\`` : "`system`";
                    const gidTxt = x.game_id ? `#${x.game_id}` : "-";
                    return `${ts ? `<t:${ts}:t>` : ""} **${safeStr(x.action, 40)}** • game \`${gidTxt}\` • ${who}`;
                  })
                  .join("\n")
                  .slice(0, 3900)
              : "No audit rows found."
          )
          .setFooter({ text: "This log is posted publicly for transparency." });

        await interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});

        await writeAudit(pg, {
          guild_id: gid,
          game_id: gameId || null,
          action: "audit_posted",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: { limit, channel_id: interaction.channelId },
        });

        return interaction.editReply("✅ Posted audit log into this channel.");
      }

      // =========================
      // /gift start (Wizard UI) — PUBLIC ONLY + DEFAULTS
      // Defaults requested:
      //   - mode: public
      //   - commit: true
      //   - prize_secret: true
      // =========================
      if (sub === "start") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;

        const active = await getActiveGiftGame(pg, gid);
        if (active) {
          return interaction.editReply(
            `⚠️ A Gift game is already **active** in <#${active.channel_id}> (gameId: \`${active.id}\`).\n` + `Use \`/gift stop\` to end it.`
          );
        }

        const cfg = await getGiftConfig(pg, gid);

        const channelOpt = interaction.options.getChannel("channel");
        const channelId = channelOpt?.id || cfg?.channel_id || interaction.channelId;

        const channel = await interaction.client.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.type !== ChannelType.GuildText) {
          return interaction.editReply("❌ Could not resolve a valid text channel for the game. Set one via `/gift config channel:#...`.");
        }

        // ✅ Force public mode always
        const mode = "public";

        const rangeMin = intOrNull(interaction.options.getInteger("range_min"));
        const rangeMax = intOrNull(interaction.options.getInteger("range_max"));

        let rMin = rangeMin ?? cfg?.range_min_default ?? 1;
        let rMax = rangeMax ?? cfg?.range_max_default ?? 100;

        rMin = clampInt(Number(rMin), 0, 1000000);
        rMax = clampInt(Number(rMax), 1, 1000000);
        if (rMax <= rMin) rMax = rMin + 1;

        const durationOpt = intOrNull(interaction.options.getInteger("duration_sec"));
        const durationSec = clampInt(Number(durationOpt ?? cfg?.duration_sec_default ?? 600), 10, 86400);

        const perUserCooldownMs = clampInt(Number(cfg?.per_user_cooldown_ms ?? 6000), 0, 600000);
        const maxGuessesPerUser = clampInt(Number(cfg?.max_guesses_per_user ?? 25), 1, 1000);
        const hintsMode = String(cfg?.hints_mode ?? "highlow").toLowerCase();

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

        // ✅ default commit ON
        const commit = Boolean(interaction.options.getBoolean("commit") ?? true);
        let commitSalt = null;
        let commitHash = null;
        if (commit) {
          commitSalt = randomSaltHex(16);
          commitHash = sha256Hex(`${targetNumber}:${commitSalt}`);
        }

        // ✅ default prize_secret ON
        const prizeSecret = Boolean(interaction.options.getBoolean("prize_secret") ?? true);
        const notes = safeStr(interaction.options.getString("notes") || "", 400);

        const endsAt = new Date(Date.now() + durationSec * 1000).toISOString();

        const gameRow = await createGiftGameRow(pg, {
          guild_id: gid,
          channel_id: channel.id,
          thread_id: null,
          created_by: interaction.user.id,
          created_by_tag: interaction.user.tag,

          mode,
          status: "draft",

          range_min: rMin,
          range_max: rMax,

          target_number: targetNumber,
          target_source: targetSource,

          commit_enabled: commit,
          commit_salt: commitSalt,
          commit_hash: commitHash,

          prize_type: "text",
          prize_label: "Mystery prize 🎁",
          prize_secret: prizeSecret,
          prize_payload: null,

          ends_at: endsAt,

          per_user_cooldown_ms: perUserCooldownMs,
          max_guesses_per_user: maxGuessesPerUser,
          hints_mode: hintsMode,

          notes,
          started_at: "NOW()",
        });

        if (!gameRow?.id) {
          return interaction.editReply("❌ Failed to create draft game in DB.");
        }

        await writeAudit(pg, {
          guild_id: gid,
          game_id: gameRow.id,
          action: "draft_created",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: {
            mode,
            range_min: rMin,
            range_max: rMax,
            duration_sec: durationSec,
            target_source: targetSource,
            commit_enabled: commit,
            prize_secret: prizeSecret,
          },
        });

        const hintsUnlockAt = Math.floor(Date.now() / 1000 + Math.floor(durationSec * 0.75));
        const endsTs = Math.floor(Date.now() / 1000 + durationSec);

        const embed = new EmbedBuilder()
          .setTitle("🎁 Gift Drop Wizard — Choose Prize Type")
          .setDescription(
            [
              `**Draft Game ID:** \`${gameRow.id}\``,
              `**Channel:** <#${channel.id}>`,
              `**Mode:** \`public\``,
              `**Range:** \`${rMin} → ${rMax}\``,
              `**Ends:** <t:${endsTs}:R>`,
              `**Hints unlock:** <t:${hintsUnlockAt}:R>`,
              `**Prize:** ${prizeSecret ? "??? (hidden until win)" : "`visible`"}`,
              commit ? `**Fairness:** commit hash locked ✅` : `**Fairness:** standard`,
              "",
              "Pick what you’re giving away:",
            ].join("\n")
          )
          .setThumbnail(GIFT_BOX_GIF)
          .setFooter({ text: "Next: you’ll fill only the fields needed for that prize type." });

        // ✅ ROLE removed
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`gift_wiz_pick:${gameRow.id}:nft`).setLabel("NFT").setEmoji("🖼️").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`gift_wiz_pick:${gameRow.id}:token`).setLabel("Token").setEmoji("🪙").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`gift_wiz_pick:${gameRow.id}:text`).setLabel("Text").setEmoji("📝").setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`gift_wiz_cancel:${gameRow.id}`).setLabel("Cancel").setEmoji("❌").setStyle(ButtonStyle.Danger)
        );

        return interaction.editReply({ embeds: [embed], components: [row] });
      }

      // =========================
      // /gift stop
      // =========================
      if (sub === "stop") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;
        const reason = safeStr(interaction.options.getString("reason") || "", 300);
        const revealTarget = Boolean(interaction.options.getBoolean("reveal_target") ?? false);

        const active = await getActiveGiftGame(pg, gid);
        if (!active) {
          return interaction.editReply("ℹ️ No active gift game in this server.");
        }

        const upd = await pg.query(
          `
          UPDATE gift_games
          SET status='cancelled', ended_at=NOW()
          WHERE id=$1 AND status='active'
          RETURNING *;
          `,
          [active.id]
        );

        const cancelled = upd.rows?.[0] || null;
        if (!cancelled) {
          return interaction.editReply("⚠️ Could not stop — game already ended.");
        }

        let uniquePlayers = 0;
        try {
          const r = await pg.query(`SELECT COUNT(DISTINCT user_id) AS n FROM gift_guesses WHERE game_id=$1`, [cancelled.id]);
          uniquePlayers = Number(r.rows?.[0]?.n || 0);
          if (!Number.isFinite(uniquePlayers)) uniquePlayers = 0;
          await pg.query(`UPDATE gift_games SET unique_players=$2 WHERE id=$1`, [cancelled.id, uniquePlayers]);
        } catch {}

        await writeAudit(pg, {
          guild_id: gid,
          game_id: cancelled.id,
          action: "stop",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: { reason: reason || null },
        });

        try {
          const channel = await interaction.client.channels.fetch(cancelled.channel_id).catch(() => null);
          if (channel && cancelled.drop_message_id) {
            const msg = await channel.messages.fetch(cancelled.drop_message_id).catch(() => null);
            if (msg) {
              const endedEmbed = EmbedBuilder.from(msg.embeds?.[0] || {})
                .setTitle("🎁 GIFT DROP — CANCELLED")
                .setDescription(
                  [
                    `🛑 This drop was stopped by an admin.`,
                    reason ? `**Reason:** ${reason}` : null,
                    ``,
                    `**Range:** \`${cancelled.range_min} → ${cancelled.range_max}\``,
                    `**Total Guesses:** \`${Number(cancelled.total_guesses || 0)}\``,
                    `**Unique Players:** \`${uniquePlayers}\``,
                  ]
                    .filter(Boolean)
                    .join("\n")
                );

              await msg
                .edit({
                  embeds: [endedEmbed],
                  components: await disableAllComponents(msg.components),
                })
                .catch(() => {});
            }
          }
        } catch {}

        const extra = revealTarget ? `\n🔐 Target number was: \`${cancelled.target_number}\`` : "";
        return interaction.editReply(`✅ Stopped active game \`${cancelled.id}\` in <#${cancelled.channel_id}>.${extra}`);
      }

      // =========================
      // /gift review  (POSTS PUBLICLY)
      // =========================
      if (sub === "review") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;
        const gameIdOpt = intOrNull(interaction.options.getInteger("game_id"));

        let game = null;
        if (gameIdOpt) {
          game = await getGiftGameById(pg, gameIdOpt);
          if (!game || String(game.guild_id) !== String(gid)) {
            return interaction.editReply("❌ Game not found for this server.");
          }
        } else {
          const r = await pg.query(`SELECT * FROM gift_games WHERE guild_id=$1 ORDER BY started_at DESC LIMIT 1`, [gid]);
          game = r.rows?.[0] || null;
          if (!game) return interaction.editReply("ℹ️ No gift games found for this server.");
        }

        const totalGuesses = Number(game.total_guesses || 0);

        let uniquePlayers = Number(game.unique_players || 0);
        if (!Number.isFinite(uniquePlayers) || uniquePlayers < 0) uniquePlayers = 0;

        let topGuessers = [];
        try {
          const r = await pg.query(
            `
            SELECT user_id, COALESCE(MAX(user_tag), '') AS user_tag, COUNT(*) AS n
            FROM gift_guesses
            WHERE game_id=$1
            GROUP BY user_id
            ORDER BY n DESC
            LIMIT 10
            `,
            [game.id]
          );
          topGuessers = (r.rows || []).map((x) => ({
            user_id: x.user_id,
            user_tag: x.user_tag,
            n: Number(x.n || 0),
          }));
        } catch {}

        let recent = [];
        try {
          const r = await pg.query(
            `
            SELECT user_id, COALESCE(user_tag,'') AS user_tag, guess_value, source, created_at, is_correct, hint
            FROM gift_guesses
            WHERE game_id=$1
            ORDER BY created_at DESC
            LIMIT 10
            `,
            [game.id]
          );
          recent = r.rows || [];
        } catch {}

        const startedTs = game.started_at ? Math.floor(new Date(game.started_at).getTime() / 1000) : null;
        const endedTs = game.ended_at ? Math.floor(new Date(game.ended_at).getTime() / 1000) : null;
        const endsTs = game.ends_at ? Math.floor(new Date(game.ends_at).getTime() / 1000) : null;

        const prizeLine = game.prize_secret && game.status === "active" ? "??? (hidden)" : game.prize_label || "Mystery prize 🎁";

        const dropUrl = game.drop_message_url ? `[Open Drop Message](${game.drop_message_url})` : "N/A";

        const embed = new EmbedBuilder()
          .setTitle(`🎁 Gift Game Review — #${game.id}`)
          .setDescription(
            [
              `**Status:** ${fmtStatus(game.status)}`,
              `**Channel:** <#${game.channel_id}>`,
              `**Mode:** \`public\``,
              ``,
              `**Started:** ${startedTs ? `<t:${startedTs}:f>` : "N/A"}`,
              `**Scheduled End:** ${endsTs ? `<t:${endsTs}:f>` : "N/A"}`,
              `**Ended:** ${endedTs ? `<t:${endedTs}:f>` : "N/A"}`,
              ``,
              `**Range:** \`${game.range_min} → ${game.range_max}\``,
              `**Hints:** \`${game.hints_mode}\``,
              `**Cooldown:** \`${game.per_user_cooldown_ms}ms\``,
              `**Max guesses/user:** \`${game.max_guesses_per_user}\``,
              ``,
              `**Prize:** ${prizeLine}`,
              `**Drop:** ${dropUrl}`,
              ``,
              game.winner_user_id ? `🏆 **Winner:** <@${game.winner_user_id}> | number \`${game.winning_guess}\`` : `🏆 **Winner:** none`,
            ].join("\n")
          )
          .addFields(
            { name: "Total Guesses", value: `\`${totalGuesses}\``, inline: true },
            { name: "Unique Players", value: `\`${uniquePlayers}\``, inline: true },
            { name: "Commit Proof", value: game.commit_enabled ? "✅ enabled" : "—", inline: true }
          );

        if (topGuessers.length) {
          embed.addFields({
            name: "Top Guessers",
            value: topGuessers.map((u, i) => `${i + 1}. <@${u.user_id}> — \`${u.n}\` guesses`).join("\n").slice(0, 1024),
            inline: false,
          });
        }

        if (recent.length) {
          embed.addFields({
            name: "Recent Guesses (latest 10)",
            value: recent
              .map((r) => {
                const ts = r.created_at ? Math.floor(new Date(r.created_at).getTime() / 1000) : null;
                const who = `<@${r.user_id}>`;
                const g = `\`${r.guess_value}\``;
                const src = `\`${r.source}\``;
                const tag = r.is_correct ? "✅" : "";
                const tss = ts ? `<t:${ts}:t>` : "";
                return `${tss} ${who} → ${g} ${src} ${tag}`;
              })
              .join("\n")
              .slice(0, 1024),
            inline: false,
          });
        }

        if (game.notes) {
          embed.addFields({ name: "Notes", value: safeStr(game.notes, 900), inline: false });
        }

        await interaction.channel.send({ embeds: [embed], allowedMentions: { parse: [] } }).catch(() => {});

        await writeAudit(pg, {
          guild_id: gid,
          game_id: game.id,
          action: "review_posted",
          actor_user_id: interaction.user.id,
          actor_tag: interaction.user.tag,
          details: { channel_id: interaction.channelId },
        });

        return interaction.editReply("✅ Posted the review into this channel.");
      }

      return interaction.reply({ content: "Not implemented.", ephemeral: true });
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

