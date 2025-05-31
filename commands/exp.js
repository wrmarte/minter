const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');
const { OpenAI } = require('openai');

// Init OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Simple in-memory cache for guild names
const guildNameCache = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. "rich")')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;

    const name = interaction.options.getString('name').toLowerCase();
    const guildId = interaction.guild?.id ?? null;
    const userMention = `<@${interaction.user.id}>`;

    let res;
    if (isOwner) {
      res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`,
        [name]
      );
    } else {
      res = await pg.query(
        `SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`,
        [name, guildId]
      );
    }

    // 🔥 Main logic: database → flavorMap → AI fallback
    if (!res.rows.length && !flavorMap[name]) {
      // AI fallback time
      await interaction.deferReply();

      const prompt = `
You are a savage, funny, web3-native Discord bot. Someone typed: "${name}". 
Generate a creative, witty, or savage 1-liner reaction for this vibe. Use emojis/slang if helpful. Do NOT repeat the word directly.
      `;

      try {
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages: [
            { role: 'system', content: 'You are a savage Discord bot AI expression generator.' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 50,
          temperature: 0.9
        });

        const aiResponse = completion.choices[0].message.content.trim();

        const embed = new EmbedBuilder()
          .setTitle('🧠 AI Expression')
          .setDescription(aiResponse)
          .setColor(0xFFD700)
          .setFooter({ text: 'Powered by PimpsDev AI Engine' });

        return await interaction.editReply({ embeds: [embed] });

      } catch (err) {
        console.error('❌ AI error:', err);
        return await interaction.reply({ content: `❌ No expression found & AI failed.`, flags: 64 });
      }
    }

    const exp = res.rows[0];
    const customMessage = exp?.content?.includes('{user}')
      ? exp.content.replace('{user}', userMention)
      : getRandomFlavor(name, userMention) || `💥 ${userMention} is experiencing **"${name}"** energy today!`;

    if (exp?.type === 'image') {
      try {
        const imageRes = await fetch(exp.content);
        if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
        const file = new AttachmentBuilder(exp.content);
        return await interaction.reply({ content: customMessage, files: [file] });
      } catch (err) {
        console.error('❌ Image fetch error:', err.message);
        return await interaction.reply({ content: `⚠️ Image broken, but:\n${customMessage}`, flags: 64 });
      }
    }

    return interaction.reply({ content: customMessage });
  },

  async autocomplete(interaction, { pg }) {
    const focused = interaction.options.getFocused();
    const guildId = interaction.guild?.id ?? null;
    const userId = interaction.user.id;
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = userId === ownerId;
    const client = interaction.client;

    const builtInChoices = Object.keys(flavorMap).map(name => ({
      name: `🔥 ${name} (Built-in)`,
      value: name
    }));

    let query, params;
    if (isOwner) {
      query = `SELECT DISTINCT name, guild_id FROM expressions`;
      params = [];
    } else {
      query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`;
      params = [guildId];
    }

    const res = await pg.query(query, params);

    const thisServer = [];
    const global = [];
    const otherServers = [];

    for (const row of res.rows) {
      if (!row.name) continue;

      if (row.guild_id === null) {
        global.push({ name: `🌐 ${row.name} (Global)`, value: row.name });
      } else if (row.guild_id === guildId) {
        thisServer.push({ name: `🏠 ${row.name} (This Server)`, value: row.name });
      } else {
        let guildName = guildNameCache.get(row.guild_id);
        if (!guildName) {
          const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
          guildName = guild?.name ?? 'Other Server';
          guildNameCache.set(row.guild_id, guildName);
        }
        otherServers.push({ name: `🛡️ ${row.name} (${guildName})`, value: row.name });
      }
    }

    const combined = [...builtInChoices, ...thisServer, ...global, ...otherServers];
    const filtered = combined
      .filter(c => c.name.toLowerCase().includes(focused.toLowerCase()))
      .slice(0, 25);

    console.log(`🔁 Optimized Autocomplete for /exp:`, filtered);
    await interaction.respond(filtered);
  }
};




