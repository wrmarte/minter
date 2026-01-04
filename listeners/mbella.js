// listeners/mbella.js
// ======================================================
// MBella — Modular Entry
// (Wires messageCreate -> uses modules in ./mbella/*)
// ======================================================

const { EmbedBuilder } = require("discord.js");

const Config = require("./mbella/config");
const State = require("./mbella/state");
const Memory = require("./mbella/memory");
const Text = require("./mbella/text");
const Vibe = require("./mbella/vibe");
const Discord = require("./mbella/discord");
const Webhook = require("./mbella/webhook");
const Groq = require("./mbella/groqClient");
const Media = require("./mbella/media");
const Prompt = require("./mbella/prompt");
const Utils = require("./mbella/utils");

module.exports = (client) => {
  client.on("messageCreate", async (message) => {
    let typingTimer = null;
    let placeholder = null;
    let placeholderHook = null;
    let typingStartMs = 0;

    const clearPlaceholderTimer = () => {
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
    };

    async function ensurePlaceholder(channel) {
      const { hook, message: ph } = await Webhook.sendViaBellaWebhook(client, channel, {
        username: Config.MBELLA_NAME,
        avatarURL: Config.MBELLA_AVATAR_URL,
        content: "…",
      });
      placeholderHook = hook || null;
      placeholder = ph || null;
    }

    async function editPlaceholderToEmbed(embed, channel) {
      // Edit placeholder if possible (keeps illusion)
      if (placeholder && placeholderHook && typeof placeholderHook.editMessage === "function") {
        try {
          await placeholderHook.editMessage(placeholder.id, {
            content: null,
            embeds: [embed],
            allowedMentions: { parse: [] },
          });
          return true;
        } catch (e) {
          if (Config.DEBUG) console.log("[MBella] editMessage failed, will resend:", e?.message || e);

          const { hook, message: fresh } = await Webhook.sendViaBellaWebhook(client, channel, {
            username: Config.MBELLA_NAME,
            avatarURL: Config.MBELLA_AVATAR_URL,
            embeds: [embed],
          });

          if (fresh) {
            try {
              await placeholderHook.deleteMessage?.(placeholder.id);
            } catch {}
            placeholderHook = hook || placeholderHook;
            return true;
          }
        }
      }

      // Fallback: send fresh
      const { message: finalMsg } = await Webhook.sendViaBellaWebhook(client, channel, {
        username: Config.MBELLA_NAME,
        avatarURL: Config.MBELLA_AVATAR_URL,
        embeds: [embed],
      });

      return Boolean(finalMsg);
    }

    try {
      if (!message || message.author?.bot || !message.guild) return;
      if (State.alreadyHandled(client, message.id)) return;

      if (!Discord.canSendInChannel(message.guild, message.channel)) return;

      const lowered = (message.content || "").toLowerCase();
      const isOwnerAdmin = Discord.isOwnerOrAdmin(message);

      // ===== owner/admin toggles =====
      if (isOwnerAdmin) {
        const guildId = message.guild.id;

        if (Config.GOD_ON_REGEX.test(message.content || "")) {
          State.setGod(guildId, true);
          try {
            await message.reply({
              content: `🪽 MBella GOD MODE: ON (expires in ${Math.round(Config.MBELLA_GOD_TTL_MS / 60000)}m).`,
              allowedMentions: { parse: [] },
            });
          } catch {}
          return;
        }
        if (Config.GOD_OFF_REGEX.test(message.content || "")) {
          State.setGod(guildId, false);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: OFF.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }

        const hm = (message.content || "").match(Config.HUMAN_SET_REGEX);
        if (hm && hm[2] != null) {
          State.setHuman(guildId, Number(hm[2]));
          const st = State.getGuildState(guildId);
          try {
            await message.reply({
              content: `✨ MBella Human Level: ${st.human.level} (expires in ${Math.round(Config.MBELLA_HUMAN_TTL_MS / 60000)}m).`,
              allowedMentions: { parse: [] },
            });
          } catch {}
          return;
        }

        if (Config.CURSE_ON_REGEX.test(message.content || "")) {
          State.setCurse(guildId, true);
          try {
            await message.reply({ content: `😈 MBella profanity: ON.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
        if (Config.CURSE_OFF_REGEX.test(message.content || "")) {
          State.setCurse(guildId, false);
          try {
            await message.reply({ content: `😇 MBella profanity: OFF.`, allowedMentions: { parse: [] } });
          } catch {}
          return;
        }
      }

      // ===== triggers =====
      const hasFemaleTrigger = Config.FEMALE_TRIGGERS.some((t) => lowered.includes(t));
      const botMentioned = message.mentions.has(client.user);
      const hintedBella = /\bbella\b/.test(lowered);

      if (Config.RELEASE_REGEX.test(message.content || "")) {
        State.clearBellaPartner(message.channel.id);
        return;
      }

      const replyingToMBella = await Discord.isReplyToMBella(message, client, Config);
      const partnerId = State.getBellaPartner(message.channel.id);

      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      // ===== cooldown =====
      const isOwner = message.author.id === String(process.env.BOT_OWNER_ID || "");
      const bypassCooldown = replyAllowed;

      if (!bypassCooldown) {
        if (State.cooldownHas(message.author.id) && !isOwner) return;
        State.cooldownAdd(message.author.id);
        setTimeout(() => State.cooldownDelete(message.author.id), Config.COOLDOWN_MS);
      }

      // Typing
      try {
        await message.channel.sendTyping();
      } catch {}
      typingStartMs = Date.now();

      State.setTypingSuppress(client, message.channel.id, 12000);

      typingTimer = setTimeout(() => {
        ensurePlaceholder(message.channel).catch(() => {});
      }, Config.MBELLA_TYPING_DEBOUNCE_MS);

      // Roast mode
      const mentionedUsers = message.mentions.users.filter((u) => u.id !== client.user.id);
      const shouldRoast = (hasFemaleTrigger || (botMentioned && hintedBella) || replyAllowed) && mentionedUsers.size > 0;

      const isRoastingBot =
        shouldRoast &&
        message.mentions.has(client.user) &&
        mentionedUsers.size === 1 &&
        mentionedUsers.has(client.user.id);

      // Fetch mb_mode (optional)
      let currentMode = "default";
      try {
        if (client?.pg?.query) {
          const modeRes = await client.pg.query(`SELECT mode FROM mb_modes WHERE server_id = $1 LIMIT 1`, [message.guild.id]);
          currentMode = modeRes.rows[0]?.mode || "default";
        }
      } catch {
        if (Config.DEBUG) console.warn("⚠️ (MBella) failed to fetch mb_mode, using default.");
      }

      const guildState = State.getGuildState(message.guild.id);
      const godMode = Boolean(guildState?.god?.on) && isOwnerAdmin;
      const humanLevel = Number(guildState?.human?.level ?? Config.MBELLA_HUMAN_LEVEL_DEFAULT);
      const curseEnabledGuild = Boolean(guildState?.curse?.on);

      const intensity = Vibe.computeIntensityScore(message.content || "");
      const vibe = Vibe.detectVibe(message.content || "");

      const curseAllowedNow = Boolean(Config.MBELLA_ALLOW_PROFANITY && curseEnabledGuild);
      const curseRate = Config.MBELLA_CURSE_RATE_DEFAULT;

      const [recentContext, referenceSnippet] = await Promise.all([
        Discord.getRecentContext(message),
        Discord.getReferenceSnippet(message),
      ]);

      // Memory keys (channel + per-user)
      const chKey = Memory.memKey(message.channel.id, "any");
      const uKey = Memory.memKey(message.channel.id, message.author.id);

      const memoryContext = [
        Memory.getMemoryContext(uKey, Config),
        Memory.getMemoryContext(chKey, Config),
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(0, 2200);

      const awarenessContext = [referenceSnippet, recentContext].filter(Boolean).join("\n\n");

      // Clean input
      let cleanedInput = String(message.content || "");

      for (const t of Config.FEMALE_TRIGGERS) {
        const re = new RegExp(`\\b${Text.escapeRegex(t)}\\b`, "ig");
        cleanedInput = cleanedInput.replace(re, "");
      }

      try {
        message.mentions.users.forEach((user) => {
          cleanedInput = cleanedInput.replaceAll(`<@${user.id}>`, "");
          cleanedInput = cleanedInput.replaceAll(`<@!${user.id}>`, "");
        });
      } catch {}

      cleanedInput = cleanedInput.replaceAll(`<@${client.user.id}>`, "");
      cleanedInput = cleanedInput.replace(/\s+/g, " ").trim();
      if (!cleanedInput) cleanedInput = shouldRoast ? "Roast them." : "Talk to me.";

      const roastTargets = [...mentionedUsers.values()].map((u) => u.username).join(", ");

      const systemPrompt = Prompt.buildMBellaSystemPrompt({
        Config,
        isRoast: shouldRoast && !isRoastingBot,
        isRoastingBot,
        roastTargets,
        currentMode,
        recentContext: awarenessContext,
        memoryContext,
        humanLevel,
        curseAllowedNow,
        curseRate,
        intensity,
        godMode,
        vibe,
      });

      // Temperature (human + flirty)
      let temperature = 0.96;
      if (Config.MBELLA_SPICE === "pg13") temperature = 0.84;
      if (Config.MBELLA_SPICE === "feral") temperature = 0.99;
      if (currentMode === "villain") temperature = Math.min(temperature, 0.88);

      const maxTokens = godMode
        ? Math.max(520, Config.DEFAULT_MAX_TOKENS)
        : Math.max(300, Config.DEFAULT_MAX_TOKENS);

      // Build messages (context separated helps “awareness”)
      const messages = [];

      if (memoryContext) messages.push({ role: "system", content: memoryContext });
      if (awarenessContext) messages.push({ role: "system", content: awarenessContext });

      messages.push({
        role: "system",
        content:
          "Write like a real Discord chat partner: confident, natural, affectionate/sassy. Never mention being AI or any system/meta. No explicit sexual content.",
      });

      messages.push({ role: "user", content: String(cleanedInput).slice(0, 5000) });

      const groqTry = await Groq.groqWithDiscovery({
        apiKey: Config.GROQ_API_KEY,
        modelEnv: Config.GROQ_MODEL_ENV,
        systemPrompt,
        messages,
        temperature,
        maxTokens,
        debug: Config.DEBUG,
        maxRetriesPerModel: Config.MAX_RETRIES_PER_MODEL,
      });

      clearPlaceholderTimer();

      if (!groqTry || groqTry.error) {
        console.error("❌ (MBella) network error:", groqTry?.error?.message || "unknown");
        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription("…ugh. signal dipped. say it again. 💋");

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      if (!groqTry.res?.ok) {
        console.error(`❌ (MBella) HTTP ${groqTry.res?.status} on "${groqTry.model}": ${String(groqTry.bodyText || "").slice(0, 400)}`);

        let hint = "…not now. try again in a sec. 😮‍💨";
        const status = groqTry.res?.status;

        if (status === 401 || status === 403) {
          hint = message.author.id === String(process.env.BOT_OWNER_ID || "")
            ? "Auth error. Check GROQ_API_KEY & model access."
            : "…hold up. give me a sec. 💅";
        } else if (status === 429) {
          hint = "rate limited. breathe… then try again. 😘";
        } else if (status === 400 || status === 404) {
          hint = message.author.id === String(process.env.BOT_OWNER_ID || "")
            ? "Model issue. Set GROQ_MODEL or let discovery handle it."
            : "cloud hiccup. one more shot. 🖤";
        } else if (status >= 500) {
          hint = "server cramps. i’ll be back. 🥀";
        }

        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription(hint);

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      const groqData = Utils.safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error("❌ (MBella) API body error:", groqData?.error || String(groqTry.bodyText || "").slice(0, 300));
        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription("…static. say it again, slower. 😌");

        const ok = await editPlaceholderToEmbed(embedErr, message.channel);
        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
        return;
      }

      let aiReply = groqData.choices?.[0]?.message?.content?.trim() || "";
      aiReply = Text.sanitizeOutput(Text.deRobotify(aiReply || "…"));
      aiReply = Text.enforceQuestionLimit(aiReply, Config.MBELLA_MAX_QUESTIONS);

      // Save memory (channel + per-user)
      Memory.pushMemory(chKey, "user", cleanedInput, Config);
      Memory.pushMemory(chKey, "bella", aiReply, Config);
      Memory.pushMemory(uKey, "user", cleanedInput, Config);
      Memory.pushMemory(uKey, "bella", aiReply, Config);

      // Optional media
      const attachMedia = Media.shouldAttachMedia({
        Config,
        vibe,
        intensity,
        godMode,
      });

      const mediaUrl = attachMedia ? Media.pickMediaUrlByVibe({ Config, vibe }) : "";

      const embed = new EmbedBuilder()
        .setColor(Config.MBELLA_EMBED_COLOR)
        .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
        .setDescription(`💬 ${aiReply}`);

      if (mediaUrl) embed.setImage(mediaUrl);

      // Typing delay (illusion)
      const plannedDelay =
        Math.min((aiReply || "").length * Config.MBELLA_MS_PER_CHAR, Config.MBELLA_MAX_DELAY_MS) +
        Config.MBELLA_DELAY_OFFSET_MS;

      const sinceTyping = typingStartMs ? Date.now() - typingStartMs : 0;
      const floorExtra = Config.MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await Utils.sleep(finalDelay);

      const edited = await editPlaceholderToEmbed(embed, message.channel);
      if (!edited) {
        try {
          await message.reply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch (err) {
          if (Config.DEBUG) console.warn("❌ (MBella) send fallback error:", err.message);
          if (aiReply) {
            try {
              await message.reply({ content: aiReply, allowedMentions: { parse: [] } });
            } catch {}
          }
        }
      }

      // Lock partner in channel
      State.setBellaPartner(message.channel.id, message.author.id, Config.BELLA_TTL_MS);
      State.markHandled(client, message.id);
    } catch (err) {
      clearPlaceholderTimer();
      console.error("❌ MBella listener error:", err?.stack || err?.message || String(err));

      try {
        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription("…i tripped in heels. i’m up though. 🦵✨");

        const { message: sent } = await Webhook.sendViaBellaWebhook(client, message.channel, {
          username: Config.MBELLA_NAME,
          avatarURL: Config.MBELLA_AVATAR_URL,
          embeds: [embedErr],
        });

        if (!sent) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [] } });
          } catch {}
        }
      } catch {}
    }
  });
};
