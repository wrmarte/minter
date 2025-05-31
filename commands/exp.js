const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');

// Guild name cache (for autocomplete)
const guildNameCache = new Map();

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. rich)')
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
      res = await pg.query(`SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`, [name]);
    } else {
      res = await pg.query(`SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`, [name, guildId]);
    }

    if (!res.rows.length && !flavorMap[name]) {
      await interaction.deferReply();
      try {
        const aiResponse = await getGroqAI(name);
        const embed = new EmbedBuilder()
          .setTitle('🧠 AI Expression')
          .setDescription(aiResponse)
          .setColor(0xFFD700);
        return await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        console.error('❌ AI error:', err);
        if (interaction.deferred) {
          await interaction.editReply('❌ AI failed.');
        } else {
          await interaction.reply('❌ AI failed.');
        }
        return;
      }
    }

    const exp = res.rows[0];
    const customMessage = exp?.content?.includes('{user}')
      ? exp.content.replace('{user}', userMention)
      : getRandomFlavor(name, userMention) || `💥 ${userMention} is experiencing "${name}" energy today!`;

    if (exp?.type === 'image') {
      try {
        const imageRes = await fetch(exp.content);
        if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
        const file = new AttachmentBuilder(exp.content);
        return await interaction.reply({ content: customMessage, files: [file] });
      } catch (err) {
        console.error('❌ Image fetch error:', err.message);
        return await interaction.reply({ content: `⚠️ Image broken, but:\n${customMessage}` });
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
    const filtered = combined.filter(c => c.name.toLowerCase().includes(focused.toLowerCase())).slice(0, 25);

    await interaction.respond(filtered);
  }
};

// GROQ AI function (FREE version)
async function getGroqAI(keyword) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const apiKey = process.env.GROQ_API_KEY;

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      {
        role: 'system',
        content: 'You are a savage Discord bot AI expression generator.'
      },
      {
        role: 'user',
        content: `Someone gave you the word "${keyword}". Generate a super short savage one-liner reaction. Max 1 sentence. Avoid chatty answers. Use Web3 or Discord slang if helpful.`
      }
    ],
    max_tokens: 50,
    temperature: 0.9
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const errData = await res.json();
    console.error(errData);
    throw new Error('Groq AI call failed');
  }

  const data = await res.json();
  return data.choices[0].message.content.trim();
}






