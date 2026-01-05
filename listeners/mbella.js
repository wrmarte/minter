// listeners/mbella.js
// =======================================================
// MBella — Modular Entry
// (Wires messageCreate -> uses modules in ./mbella/*)
// ✅ PATCH: ALWAYS reply to the user message (native reply when possible)
// ✅ PATCH: Single-message “placeholder” that gets EDITED (webhook OR bot fallback)
// ✅ PATCH: If webhook cannot be used (missing Manage Webhooks / webhookAuto),
//           MBella still replies via bot (but will LOG why webhook persona can't be used)
// =======================================================

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

    // Placeholder can be webhook OR bot message (fallback)
    let placeholder = null; // webhook message OR bot message
    let placeholderHook = null; // webhook client (if webhook placeholder)
    let placeholderIsBot = false; // true when placeholder is bot message
    let typingStartMs = 0;

    const clearPlaceholderTimer = () => {
      if (typingTimer) {
        clearTimeout(typingTimer);
        typingTimer = null;
      }
    };

    function safeOneLine(s, max = 160) {
      const t = String(s || "").replace(/\s+/g, " ").trim();
      if (!t) return "";
      return t.length > max ? t.slice(0, max - 1) + "…" : t;
    }

    function buildReplyHeader(msg) {
      // “Reply-like” header that works even if Discord won’t render native webhook reply arrow
      const who = msg?.member?.displayName || msg?.author?.username || "someone";
      const snippet = safeOneLine(msg?.content, 180);
      const jump = msg?.url ? msg.url : "";
      if (jump && snippet) return `↪ Replying to **${who}**: ${snippet}\n[Jump to message](${jump})\n\n`;
      if (jump) return `↪ Replying to **${who}**\n[Jump to message](${jump})\n\n`;
      if (snippet) return `↪ Replying to **${who}**: ${snippet}\n\n`;
      return `↪ Replying to **${who}**\n\n`;
    }

    async function ensurePlaceholder(channel) {
      // 1) Try webhook placeholder (preferred: shows MBella as sender)
      try {
        const { hook, message: ph } = await Webhook.sendViaBellaWebhook(client, channel, {
          username: Config.MBELLA_NAME,
          avatarURL: Config.MBELLA_AVATAR_URL,
          content: "…",
          // ✅ attempt native reply arrow
          messageReference: message.id,
          allowedMentions: { parse: [], repliedUser: false },
        });

        if (ph) {
          placeholderHook = hook || null;
          placeholder = ph;
          placeholderIsBot = false;
          return;
        }

        if (Config.DEBUG) {
          console.log(
            "[MBella] placeholder webhook send failed (no message returned) -> will fallback to bot reply"
          );
        }
      } catch (e) {
        if (Config.DEBUG) console.log("[MBella] ensurePlaceholder webhook exception:", e?.message || e);
      }

      // 2) Fallback placeholder via bot reply (always replies, but sender will be the bot)
      try {
        const botPh = await message.reply({
          content: "…",
          allowedMentions: { parse: [], repliedUser: false },
        });
        placeholder = botPh || null;
        placeholderHook = null;
        placeholderIsBot = true;

        if (Config.DEBUG) {
          console.log(
            "[MBella] Using bot placeholder (webhook not available). " +
              "If you want MBella as SENDER, bot needs Manage Webhooks + webhookAuto working."
          );
        }
      } catch (e2) {
        placeholder = null;
        placeholderHook = null;
        placeholderIsBot = false;
        if (Config.DEBUG) console.log("[MBella] bot placeholder failed too:", e2?.message || e2);
      }
    }

    async function editPlaceholderToEmbed(embed, channel) {
      // A) If placeholder is webhook message and we can edit via webhook client
      if (!placeholderIsBot && placeholder && placeholderHook && typeof placeholderHook.editMessage === "function") {
        try {
          await placeholderHook.editMessage(placeholder.id, {
            content: null,
            embeds: [embed],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return true;
        } catch (e) {
          if (Config.DEBUG) console.log("[MBella] webhook editMessage failed, will resend:", e?.message || e);
          // try fresh webhook message (still a reply)
          try {
            const { hook, message: fresh } = await Webhook.sendViaBellaWebhook(client, channel, {
              username: Config.MBELLA_NAME,
              avatarURL: Config.MBELLA_AVATAR_URL,
              embeds: [embed],
              messageReference: message.id,
              allowedMentions: { parse: [], repliedUser: false },
            });

            if (fresh) {
              try {
                await placeholderHook.deleteMessage?.(placeholder.id);
              } catch {}
              placeholderHook = hook || placeholderHook;
              placeholder = fresh;
              placeholderIsBot = false;
              return true;
            }
          } catch (e2) {
            if (Config.DEBUG) console.log("[MBella] webhook resend failed:", e2?.message || e2);
          }
        }
      }

      // B) If placeholder is a bot message, edit it directly
      if (placeholderIsBot && placeholder && typeof placeholder.edit === "function") {
        try {
          await placeholder.edit({
            content: null,
            embeds: [embed],
            allowedMentions: { parse: [], repliedUser: false },
          });
          return true;
        } catch (e) {
          if (Config.DEBUG) console.log("[MBella] bot placeholder edit failed:", e?.message || e);
        }
      }

      // C) No placeholder or edit failed -> send fresh (prefer webhook, else bot reply)
      try {
        const { message: finalMsg } = await Webhook.sendViaBellaWebhook(client, channel, {
          username: Config.MBELLA_NAME,
          avatarURL: Config.MBELLA_AVATAR_URL,
          embeds: [embed],
          messageReference: message.id,
          allowedMentions: { parse: [], repliedUser: false },
        });
        if (finalMsg) return true;
      } catch {}

      try {
        await message.reply({ embeds: [embed], allowedMentions: { parse: [], repliedUser: false } });
        return true;
      } catch {}

      return false;
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
              allowedMentions: { parse: [], repliedUser: false },
            });
          } catch {}
          return;
        }
        if (Config.GOD_OFF_REGEX.test(message.content || "")) {
          State.setGod(guildId, false);
          try {
            await message.reply({ content: `🪽 MBella GOD MODE: OFF.`, allowedMentions: { parse: [], repliedUser: false } });
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
              allowedMentions: { parse: [], repliedUser: false },
            });
          } catch {}
          return;
        }

        if (Config.CURSE_ON_REGEX.test(message.content || "")) {
          State.setCurse(guildId, true);
          try {
            await message.reply({ content: `😈 MBella profanity: ON.`, allowedMentions: { parse: [], repliedUser: false } });
          } catch {}
          return;
        }
        if (Config.CURSE_OFF_REGEX.test(message.content || "")) {
          State.setCurse(guildId, false);
          try {
            await message.reply({ content: `😇 MBella profanity: OFF.`, allowedMentions: { parse: [], repliedUser: false } });
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

      // Replies to MBella are allowed if partner is not set or matches user
      const replyAllowed = replyingToMBella && (!partnerId || partnerId === message.author.id);

      if (!hasFemaleTrigger && !(botMentioned && hintedBella) && !replyAllowed) return;
      if (message.mentions.everyone || message.mentions.roles.size > 0) return;

      // If NOT a reply, enforce partner lock (one partner per channel)
      if (!replyAllowed && partnerId && partnerId !== message.author.id) return;

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

      // ✅ Always create a placeholder (reply) so MBella ALWAYS “replies to” the user message
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
          .setDescription(buildReplyHeader(message) + "…ugh. signal dipped. say it again. 💋");

        // Ensure we have a placeholder, then edit it (or send fresh)
        if (!placeholder) await ensurePlaceholder(message.channel).catch(() => {});
        await editPlaceholderToEmbed(embedErr, message.channel);
        return;
      }

      if (!groqTry.res?.ok) {
        console.error(
          `❌ (MBella) HTTP ${groqTry.res?.status} on "${groqTry.model}": ${String(groqTry.bodyText || "").slice(0, 400)}`
        );

        let hint = "…not now. try again in a sec. 😮‍💨";
        const status = groqTry.res?.status;

        if (status === 401 || status === 403) {
          hint =
            message.author.id === String(process.env.BOT_OWNER_ID || "")
              ? "Auth error. Check GROQ_API_KEY & model access."
              : "…hold up. give me a sec. 💅";
        } else if (status === 429) {
          hint = "rate limited. breathe… then try again. 😘";
        } else if (status === 400 || status === 404) {
          hint =
            message.author.id === String(process.env.BOT_OWNER_ID || "")
              ? "Model issue. Set GROQ_MODEL or let discovery handle it."
              : "cloud hiccup. one more shot. 🖤";
        } else if (status >= 500) {
          hint = "server cramps. i’ll be back. 🥀";
        }

        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription(buildReplyHeader(message) + hint);

        if (!placeholder) await ensurePlaceholder(message.channel).catch(() => {});
        await editPlaceholderToEmbed(embedErr, message.channel);
        return;
      }

      const groqData = Utils.safeJsonParse(groqTry.bodyText);
      if (!groqData || groqData.error) {
        console.error("❌ (MBella) API body error:", groqData?.error || String(groqTry.bodyText || "").slice(0, 300));

        const embedErr = new EmbedBuilder()
          .setColor(Config.MBELLA_EMBED_COLOR)
          .setAuthor({ name: Config.MBELLA_NAME, iconURL: Config.MBELLA_AVATAR_URL || undefined })
          .setDescription(buildReplyHeader(message) + "…static. say it again, slower. 😌");

        if (!placeholder) await ensurePlaceholder(message.channel).catch(() => {});
        await editPlaceholderToEmbed(embedErr, message.channel);
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
        .setDescription(buildReplyHeader(message) + `💬 ${aiReply}`);

      if (mediaUrl) embed.setImage(mediaUrl);

      // Typing delay (illusion)
      const plannedDelay =
        Math.min((aiReply || "").length * Config.MBELLA_MS_PER_CHAR, Config.MBELLA_MAX_DELAY_MS) +
        Config.MBELLA_DELAY_OFFSET_MS;

      const sinceTyping = typingStartMs ? Date.now() - typingStartMs : 0;
      const floorExtra = Config.MBELLA_TYPING_TARGET_MS - sinceTyping;
      const finalDelay = Math.max(0, Math.max(plannedDelay, floorExtra));

      await Utils.sleep(finalDelay);

      // Ensure placeholder exists, then edit it (single message)
      if (!placeholder) await ensurePlaceholder(message.channel).catch(() => {});
      await editPlaceholderToEmbed(embed, message.channel);

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
          .setDescription(buildReplyHeader(message) + "…i tripped in heels. i’m up though. 🦵✨");

        if (!placeholder) await ensurePlaceholder(message.channel).catch(() => {});
        const ok = await editPlaceholderToEmbed(embedErr, message.channel);

        if (!ok) {
          try {
            await message.reply({ embeds: [embedErr], allowedMentions: { parse: [], repliedUser: false } });
          } catch {}
        }
      } catch {}
    }
  });
};



