// commands/gift.js
// ======================================================
// /gift config  (Step 2)
// /gift start   (Step 3) ✅ SMARTER prize inputs + validations
// /gift stop    (Step 5) ✅ ADDED
// /gift review  (Step 5) ✅ ADDED
//
// NOTE: Runtime (Step 4) is handled by listeners/giftGameListener.js
// ======================================================

const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  EmbedBuilder,
  ChannelType,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
} = require("discord.js");

const crypto = require("crypto");

let ensureGiftSchema = null;
try {
  const mod = require("../services/gift/ensureGiftSchema");
  if (mod && typeof mod.ensureGiftSchema === "function") ensureGiftSchema = mod.ensureGiftSchema;
} catch {}

const GIFT_BOX_GIF =
  (process.env.GIFT_BOX_GIF || "").trim() ||
  "https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif";

const GIFT_TOKEN_GIF =
  (process.env.GIFT_TOKEN_GIF || "").trim() ||
  "https://iili.io/fS5Dk3Q.gif"; // ✅ your new token gif default

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
    console.warn("⚠️ [GIFT] audit insert failed:", e?.message || e);
  }
}

async function ensureGiftConfigColumns(pg) {
  // ✅ add safe “smart” config columns without manual DB work
  const alters = [
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_mode TEXT DEFAULT 'reply';`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_hint_delete_ms INT DEFAULT 8000;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS public_out_of_range_feedback BOOLEAN DEFAULT FALSE;`,

    // ✅ Progressive hints knobs
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS progressive_hints_enabled BOOLEAN DEFAULT TRUE;`,
    `ALTER TABLE gift_config ADD COLUMN IF NOT EXISTS progressive_hint_delete_ms INT DEFAULT 0;`,
  ];

  for (const q of alters) {
    try { await pg.query(q); } catch {}
  }
}

async function upsertGiftConfig(pg, row) {
  await ensureGiftConfigColumns(pg);

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

      public_hint_mode,
      public_hint_delete_ms,
      public_out_of_range_feedback,

      progressive_hints_enabled,
      progressive_hint_delete_ms,

      created_at,
      updated_at
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
      $13,$14,$15,
      $16,$17,
      COALESCE($18, NOW()),
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

      public_hint_mode = EXCLUDED.public_hint_mode,
      public_hint_delete_ms = EXCLUDED.public_hint_delete_ms,
      public_out_of_range_feedback = EXCLUDED.public_out_of_range_feedback,

      progressive_hints_enabled = EXCLUDED.progressive_hints_enabled,
      progressive_hint_delete_ms = EXCLUDED.progressive_hint_delete_ms,

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

    row.public_hint_mode,
    row.public_hint_delete_ms,
    row.public_out_of_range_feedback,

    row.progressive_hints_enabled,
    row.progressive_hint_delete_ms,

    row.created_at || null,
  ];

  const res = await pg.query(q, values);
  return res.rows?.[0] || null;
}

async function getGiftConfig(pg, guildId) {
  await ensureGiftConfigColumns(pg);

  // lazy insert default row if missing
  await pg.query(
    `INSERT INTO gift_config (guild_id) VALUES ($1) ON CONFLICT (guild_id) DO NOTHING`,
    [guildId]
  ).catch(() => {});

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

async function getGiftGameById(pg, gameId) {
  const r = await pg.query(`SELECT * FROM gift_games WHERE id=$1 LIMIT 1`, [gameId]);
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

function disableAllComponents(components) {
  try {
    if (!Array.isArray(components)) return [];
    return components.map(row => {
      const newRow = ActionRowBuilder.from(row);
      newRow.components = newRow.components.map(c => {
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
  if (v === "ended") return "🏁 ended";
  if (v === "expired") return "⏳ expired";
  if (v === "cancelled") return "🛑 cancelled";
  return v || "unknown";
}

function buildSmartPrizePayload({ prizeType, opts, prizeJsonPayload }) {
  const payload = (prizeJsonPayload && typeof prizeJsonPayload === "object")
    ? { ...prizeJsonPayload }
    : {};

  const type = String(prizeType || "text").toLowerCase();

  if (type === "nft") {
    const name = safeStr(opts.getString("nft_name") || payload.name || payload.collectionName || payload.project || "", 140);
    const contract = safeStr(opts.getString("nft_contract") || payload.contract || payload.ca || payload.address || "", 100);
    const tokenId = safeStr(opts.getString("nft_token_id") || payload.tokenId || payload.id || payload.tokenID || "", 60);
    const chain = safeStr(opts.getString("nft_chain") || payload.chain || payload.network || payload.net || "base", 24);
    const image = safeStr(opts.getString("nft_image_url") || payload.image || payload.image_url || payload.imageUrl || "", 320);
    const meta = safeStr(opts.getString("nft_metadata_url") || payload.metadataUrl || payload.metadata_url || payload.tokenURI || payload.uri || "", 320);

    if (name) payload.name = name;
    if (contract) payload.contract = contract;
    if (tokenId) payload.tokenId = tokenId;
    if (chain) payload.chain = chain;
    if (image) payload.image = image;
    if (meta) payload.metadataUrl = meta;
  }

  if (type === "token") {
    const amount = safeStr(opts.getString("token_amount") || payload.amount || "", 60);
    const symbol = safeStr(opts.getString("token_symbol") || payload.symbol || "", 20);
    const chain = safeStr(opts.getString("token_chain") || payload.chain || payload.network || payload.net || "base", 24);
    const logo = safeStr(opts.getString("token_logo_url") || payload.logoUrl || payload.logo_url || payload.icon || payload.image || "", 320);

    if (amount) payload.amount = amount;
    if (symbol) payload.symbol = symbol;
    if (chain) payload.chain = chain;
    if (logo) payload.logoUrl = logo;
  }

  if (type === "url") {
    const url = safeStr(opts.getString("url_target") || payload.url || payload.target || "", 320);
    if (url) payload.url = url;
  }

  if (type === "role") {
    const rid = safeStr(opts.getString("role_id") || payload.roleId || payload.role_id || "", 80);
    if (rid) payload.roleId = rid;
  }

  // If empty object => return null
  return Object.keys(payload).length ? payload : null;
}

function validatePrizeInputs({ prizeType, prizeLabel, prizePayload }) {
  const type = String(prizeType || "text").toLowerCase();
  const label = safeStr(prizeLabel || "", 220);

  if (type === "nft") {
    const p = prizePayload || {};
    const hasContractAndId = Boolean(p.contract || p.ca || p.address) && (p.tokenId != null || p.id != null || p.tokenID != null);
    const hasImage = Boolean(p.image || p.image_url || p.imageUrl);
    const hasName = Boolean(p.name || p.collectionName || p.project);
    if (!hasContractAndId && !hasImage && !hasName) {
      return {
        ok: false,
        msg:
          "❌ **NFT prize selected**, but missing NFT info.\n\n" +
          "Use at least ONE:\n" +
          "• `nft_contract` + `nft_token_id`\n" +
          "• OR `nft_image_url`\n" +
          "• OR `nft_name`\n\n" +
          "Example: `/gift start prize_type:NFT nft_name:CryptoPimps nft_contract:0x... nft_token_id:123 nft_chain:base`"
      };
    }
  }

  if (type === "token") {
    const p = prizePayload || {};
    const hasAmount = Boolean(p.amount);
    const hasSymbol = Boolean(p.symbol);
    const hasLabel = Boolean(label);
    if ((!hasAmount || !hasSymbol) && !hasLabel) {
      return {
        ok: false,
        msg:
          "❌ **Token prize selected**, but missing token details.\n\n" +
          "Provide either:\n" +
          "• `token_amount` + `token_symbol`\n" +
          "• OR `prize_label` (ex: \"50,000 $ADRIAN\")\n\n" +
          "Example: `/gift start prize_type:Token token_amount:50000 token_symbol:ADRIAN token_chain:base`"
      };
    }
  }

  if (type === "url") {
    const p = prizePayload || {};
    const hasUrl = Boolean(p.url) || Boolean(label);
    if (!hasUrl) {
      return { ok: false, msg: "❌ **URL prize selected** — provide `url_target` or `prize_label`." };
    }
  }

  if (type === "role") {
    const p = prizePayload || {};
    const hasRole = Boolean(p.roleId) || Boolean(label);
    if (!hasRole) {
      return { ok: false, msg: "❌ **Role prize selected** — provide `role_id` (Role ID) or `prize_label`." };
    }
  }

  return { ok: true };
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
            .setDescription("Hint style")
            .addChoices(
              { name: "None", value: "none" },
              { name: "High / Low", value: "highlow" },
              { name: "Hot / Warm / Cold", value: "hotcold" }
            )
            .setRequired(false)
        )
        // ✅ public mode feedback
        .addStringOption((opt) =>
          opt
            .setName("public_hint_mode")
            .setDescription("Public mode feedback style")
            .addChoices(
              { name: "Reply", value: "reply" },
              { name: "React", value: "react" },
              { name: "Both", value: "both" },
              { name: "Silent", value: "silent" }
            )
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("public_hint_delete_ms")
            .setDescription("Auto-delete bot hint replies in public mode (ms). 0 = keep")
            .setMinValue(0)
            .setMaxValue(600000)
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("public_out_of_range_feedback")
            .setDescription("In public mode, warn users when guess is out of range")
            .setRequired(false)
        )
        // ✅ progressive hints (after 75% time)
        .addBooleanOption((opt) =>
          opt
            .setName("progressive_hints")
            .setDescription("Enable progressive hints near end (starts after 75% time)")
            .setRequired(false)
        )
        .addIntegerOption((opt) =>
          opt
            .setName("progressive_hint_delete_ms")
            .setDescription("Auto-delete progressive hint messages (ms). 0 = keep")
            .setMinValue(0)
            .setMaxValue(600000)
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
            .setDescription('Optional JSON payload (advanced). Example: {"contract":"0x..","tokenId":"123"}')
            .setRequired(false)
        )

        // ✅ SMART FRIENDLY NFT FIELDS
        .addStringOption((opt) =>
          opt
            .setName("nft_name")
            .setDescription("NFT name/collection (ex: CryptoPimps)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("nft_contract")
            .setDescription("NFT contract address (0x...)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("nft_token_id")
            .setDescription("NFT token ID")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("nft_chain")
            .setDescription("NFT chain (base / eth / ape)")
            .addChoices(
              { name: "Base", value: "base" },
              { name: "Ethereum", value: "eth" },
              { name: "ApeChain", value: "ape" }
            )
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("nft_image_url")
            .setDescription("NFT image URL (optional if contract+tokenId provided)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("nft_metadata_url")
            .setDescription("NFT metadata URL (optional)")
            .setRequired(false)
        )

        // ✅ SMART FRIENDLY TOKEN FIELDS
        .addStringOption((opt) =>
          opt
            .setName("token_amount")
            .setDescription("Token amount (ex: 50000)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("token_symbol")
            .setDescription("Token symbol (ex: ADRIAN)")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("token_chain")
            .setDescription("Token chain (base / eth / ape)")
            .addChoices(
              { name: "Base", value: "base" },
              { name: "Ethereum", value: "eth" },
              { name: "ApeChain", value: "ape" }
            )
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("token_logo_url")
            .setDescription("Token logo URL (optional)")
            .setRequired(false)
        )

        // URL/Role helpers (optional)
        .addStringOption((opt) =>
          opt
            .setName("url_target")
            .setDescription("URL prize target")
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName("role_id")
            .setDescription("Role ID prize target (advanced)")
            .setRequired(false)
        )

        .addStringOption((opt) =>
          opt
            .setName("notes")
            .setDescription("Optional admin notes for review later")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("stop")
        .setDescription("Stop the active gift game (admin)")
        .addStringOption((opt) =>
          opt
            .setName("reason")
            .setDescription("Optional reason (for audit/review)")
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName("reveal_target")
            .setDescription("Reveal the target number when stopping (admin-only info)")
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName("review")
        .setDescription("Review a gift game (admin)")
        .addIntegerOption((opt) =>
          opt
            .setName("game_id")
            .setDescription("Game ID to review (leave empty for latest)")
            .setMinValue(1)
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

      // Admin/manager check for all subcommands here
      const perms = interaction.memberPermissions;
      const allowed =
        perms?.has(PermissionFlagsBits.Administrator) ||
        perms?.has(PermissionFlagsBits.ManageGuild);

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
      // /gift config
      // =========================
      if (sub === "config") {
        const cur = await getGiftConfig(pg, interaction.guildId);

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

        const publicHintMode = interaction.options.getString("public_hint_mode");
        const publicHintDeleteMs = intOrNull(interaction.options.getInteger("public_hint_delete_ms"));
        const outOfRange = interaction.options.getBoolean("public_out_of_range_feedback");

        const progHints = interaction.options.getBoolean("progressive_hints");
        const progHintDeleteMs = intOrNull(interaction.options.getInteger("progressive_hint_delete_ms"));

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

          public_hint_mode: (publicHintMode ?? cur?.public_hint_mode ?? "reply"),
          public_hint_delete_ms: (publicHintDeleteMs ?? cur?.public_hint_delete_ms ?? 8000),
          public_out_of_range_feedback: (outOfRange ?? cur?.public_out_of_range_feedback ?? false),

          progressive_hints_enabled: (progHints ?? cur?.progressive_hints_enabled ?? true),
          progressive_hint_delete_ms: (progHintDeleteMs ?? cur?.progressive_hint_delete_ms ?? 0),
        };

        row.range_min_default = clampInt(Number(row.range_min_default), 0, 1000000);
        row.range_max_default = clampInt(Number(row.range_max_default), 1, 1000000);
        if (row.range_max_default <= row.range_min_default) row.range_max_default = row.range_min_default + 1;

        row.duration_sec_default = clampInt(Number(row.duration_sec_default), 10, 86400);
        row.per_user_cooldown_ms = clampInt(Number(row.per_user_cooldown_ms), 0, 600000);
        row.max_guesses_per_user = clampInt(Number(row.max_guesses_per_user), 1, 1000);

        row.public_hint_delete_ms = clampInt(Number(row.public_hint_delete_ms), 0, 600000);
        row.progressive_hint_delete_ms = clampInt(Number(row.progressive_hint_delete_ms), 0, 600000);

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

            public_hint_mode: saved?.public_hint_mode,
            public_hint_delete_ms: saved?.public_hint_delete_ms,
            public_out_of_range_feedback: saved?.public_out_of_range_feedback,

            progressive_hints_enabled: saved?.progressive_hints_enabled,
            progressive_hint_delete_ms: saved?.progressive_hint_delete_ms,
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
            { name: "Max Guesses/User", value: `\`${saved?.max_guesses_per_user}\``, inline: true },

            { name: "Public Hint Mode", value: `\`${safeStr(saved?.public_hint_mode || "reply")}\``, inline: true },
            { name: "Public Hint Auto-Delete", value: `\`${Number(saved?.public_hint_delete_ms || 0)}ms\``, inline: true },
            { name: "Public Out-of-Range Feedback", value: saved?.public_out_of_range_feedback ? "✅ ON" : "—", inline: true },

            { name: "Progressive Hints", value: saved?.progressive_hints_enabled ? "✅ ON (starts at 75%)" : "—", inline: true },
            { name: "Progressive Hint Auto-Delete", value: `\`${Number(saved?.progressive_hint_delete_ms || 0)}ms\``, inline: true }
          )
          .setFooter({ text: "Use /gift start to drop a new gift game." });

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // =========================
      // /gift start
      // =========================
      if (sub === "start") {
        await interaction.deferReply({ ephemeral: true });

        const gid = interaction.guildId;

        // Block if already active
        const active = await getActiveGiftGame(pg, gid);
        if (active) {
          return interaction.editReply(
            `⚠️ A Gift game is already **active** in <#${active.channel_id}> (gameId: \`${active.id}\`).\n` +
              `Use \`/gift stop\` to end it.`
          );
        }

        const cfg = await getGiftConfig(pg, gid);

        // Resolve channel
        const channelOpt = interaction.options.getChannel("channel");
        const channelId = channelOpt?.id || cfg?.channel_id || interaction.channelId;

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
        const prizeLabel = safeStr(interaction.options.getString("prize_label") || "Mystery prize 🎁", 220);
        const prizeSecret = Boolean(interaction.options.getBoolean("prize_secret") ?? true);

        // Parse prize_json (optional)
        const prizeJsonRaw = interaction.options.getString("prize_json");
        let prizeJsonPayload = null;
        if (prizeJsonRaw && String(prizeJsonRaw).trim()) {
          try {
            const parsed = JSON.parse(String(prizeJsonRaw));
            if (parsed && typeof parsed === "object") prizeJsonPayload = parsed;
          } catch {
            return interaction.editReply(
              "❌ `prize_json` is invalid JSON.\nExample: `{ \"contract\":\"0x...\", \"tokenId\":\"123\" }`"
            );
          }
        }

        // ✅ Build SMART payload from friendly fields + optional json
        const prizePayload = buildSmartPrizePayload({
          prizeType,
          opts: interaction.options,
          prizeJsonPayload,
        });

        // ✅ Validate based on prize type (smart “conditions”)
        const v = validatePrizeInputs({ prizeType, prizeLabel, prizePayload });
        if (!v.ok) return interaction.editReply(v.msg);

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
            prize_payload: prizePayload ? { ...prizePayload, _note: "stored" } : null,
          },
        });

        // Build Drop Card message + buttons
        const showPrizeLine = prizeSecret ? "??? (reveals when someone wins)" : prizeLabel;

        // ✅ Smarter “top section” text based on prize type
        const typeHelp = (() => {
          if (prizeType === "nft") {
            const name = safeStr(prizePayload?.name || "", 60);
            const tokenId = safeStr(prizePayload?.tokenId || "", 40);
            const chain = safeStr(prizePayload?.chain || "", 10);
            const contract = safeStr(prizePayload?.contract || "", 22);
            const compact = [name && tokenId ? `${name} #${tokenId}` : (name || (tokenId ? `#${tokenId}` : "")), chain].filter(Boolean).join(" • ");
            const c2 = contract ? `${contract.slice(0, 8)}…${contract.slice(-6)}` : "";
            return `🖼️ **NFT Prize:** ${compact || "set"}${c2 ? ` • \`${c2}\`` : ""}`;
          }
          if (prizeType === "token") {
            const amount = safeStr(prizePayload?.amount || "", 30);
            const sym = safeStr(prizePayload?.symbol || "", 12);
            const chain = safeStr(prizePayload?.chain || "", 10);
            const line = [amount && sym ? `\`${amount} ${sym}\`` : "", chain ? `chain: \`${chain}\`` : ""].filter(Boolean).join(" • ");
            return `🪙 **Token Prize:** ${line || "set"}`;
          }
          if (prizeType === "url") {
            const u = safeStr(prizePayload?.url || "", 90);
            return `🔗 **URL Prize:** ${u ? `\`${u}\`` : "set"}`;
          }
          if (prizeType === "role") {
            const rid = safeStr(prizePayload?.roleId || "", 40);
            return `🎭 **Role Prize:** ${rid ? `\`${rid}\`` : "set"}`;
          }
          return `🎁 **Prize Type:** \`${prizeType}\``;
        })();

        const thumb = prizeType === "token" ? GIFT_TOKEN_GIF : GIFT_BOX_GIF;

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
              typeHelp,
              commit ? `**Fairness:** Commit hash locked ✅` : `**Fairness:** Standard`,
              ``,
              mode === "modal"
                ? `Click **🎯 Guess** to submit your number (no chat spam).`
                : `Type your guess as a number in this channel (example: \`42\`).`,
            ].join("\n")
          )
          .setThumbnail(thumb)
          .setFooter({ text: `Game ID: ${gameRow.id}` });

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`gift_guess:${gameRow.id}`)
            .setLabel("Guess")
            .setEmoji("🎯")
            .setStyle(ButtonStyle.Primary)
            .setDisabled(mode !== "modal"),
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

        return interaction.editReply(`✅ Gift Drop started in <#${channel.id}> (gameId: \`${gameRow.id}\`).`);
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

        // Cancel active game
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

        // Update unique players (best-effort)
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
          details: { reason: reason || null }
        });

        // Edit drop card to cancelled + disable buttons (best-effort)
        try {
          const channel = await interaction.client.channels.fetch(cancelled.channel_id).catch(() => null);
          if (channel && cancelled.drop_message_id) {
            const msg = await channel.messages.fetch(cancelled.drop_message_id).catch(() => null);
            if (msg) {
              const endedEmbed = EmbedBuilder.from(msg.embeds?.[0] || {})
                .setTitle("🎁 MYSTERY GIFT DROP — CANCELLED")
                .setDescription(
                  [
                    `🛑 This drop was stopped by an admin.`,
                    reason ? `**Reason:** ${reason}` : null,
                    ``,
                    `**Range:** \`${cancelled.range_min} → ${cancelled.range_max}\``,
                    `**Total Guesses:** \`${Number(cancelled.total_guesses || 0)}\``,
                    `**Unique Players:** \`${uniquePlayers}\``,
                  ].filter(Boolean).join("\n")
                );

              await msg.edit({
                embeds: [endedEmbed],
                components: disableAllComponents(msg.components),
              }).catch(() => {});
            }
          }
        } catch {}

        const extra = revealTarget ? `\n🔐 Target number was: \`${cancelled.target_number}\`` : "";
        return interaction.editReply(`✅ Stopped active game \`${cancelled.id}\` in <#${cancelled.channel_id}>.${extra}`);
      }

      // =========================
      // /gift review
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
          const r = await pg.query(
            `SELECT * FROM gift_games WHERE guild_id=$1 ORDER BY started_at DESC LIMIT 1`,
            [gid]
          );
          game = r.rows?.[0] || null;
          if (!game) return interaction.editReply("ℹ️ No gift games found for this server.");
        }

        // Pull guess stats
        const totalGuesses = Number(game.total_guesses || 0);

        let uniquePlayers = Number(game.unique_players || 0);
        if (!Number.isFinite(uniquePlayers) || uniquePlayers < 0) uniquePlayers = 0;

        // Top guessers (count)
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
          topGuessers = (r.rows || []).map(x => ({
            user_id: x.user_id,
            user_tag: x.user_tag,
            n: Number(x.n || 0),
          }));
        } catch {}

        // Recent guesses (last 10)
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

        const prizeLine = game.prize_secret && game.status === "active"
          ? "??? (hidden)"
          : (game.prize_label || "Mystery prize 🎁");

        const dropUrl = game.drop_message_url ? `[Open Drop Message](${game.drop_message_url})` : "N/A";

        const embed = new EmbedBuilder()
          .setTitle(`🎁 Gift Game Review — #${game.id}`)
          .setDescription(
            [
              `**Status:** ${fmtStatus(game.status)}`,
              `**Channel:** <#${game.channel_id}>`,
              `**Mode:** \`${game.mode}\``,
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
              game.winner_user_id
                ? `🏆 **Winner:** <@${game.winner_user_id}> | number \`${game.winning_guess}\``
                : `🏆 **Winner:** none`,
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
            value: topGuessers
              .map((u, i) => `${i + 1}. <@${u.user_id}> — \`${u.n}\` guesses`)
              .join("\n")
              .slice(0, 1024),
            inline: false
          });
        }

        if (recent.length) {
          embed.addFields({
            name: "Recent Guesses (latest 10)",
            value: recent
              .map(r => {
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
            inline: false
          });
        }

        if (game.notes) {
          embed.addFields({ name: "Notes", value: safeStr(game.notes, 900), inline: false });
        }

        return interaction.editReply({ embeds: [embed] });
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

