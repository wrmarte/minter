const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');
const { flavorMap, getRandomFlavor } = require('../utils/flavorMap');

const guildNameCache = new Map();

function getRandomColor() {
  const colors = [
    0xFFD700, 0x66CCFF, 0xFF66CC, 0xFF4500,
    0x00FF99, 0xFF69B4, 0x00CED1, 0xFFA500, 0x8A2BE2
  ];
  return colors[Math.floor(Math.random() * colors.length)];
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exp')
    .setDescription('Show a visual experience vibe')
    .addStringOption(option =>
      option.setName('name')
        .setDescription('Name of the expression (e.g. rich)')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addUserOption(option =>
      option.setName('target')
        .setDescription('Tag another user (optional)')
        .setRequired(false)
    ),

  async execute(interaction, { pg }) {
    const ownerId = process.env.BOT_OWNER_ID;
    const isOwner = interaction.user.id === ownerId;
    const name = interaction.options.getString('name').toLowerCase();
    const targetUser = interaction.options.getUser('target') || interaction.user;
    const userMention = `<@${targetUser.id}>`;
    const guildId = interaction.guild?.id ?? null;

   await interaction.deferReply({ ephemeral: true });
await interaction.deleteReply().catch(() => {});


    let res = { rows: [] };
    try {
      if (pg) {
        if (isOwner) {
          res = await pg.query(`SELECT * FROM expressions WHERE name = $1 ORDER BY RANDOM() LIMIT 1`, [name]);
        } else {
          res = await pg.query(`SELECT * FROM expressions WHERE name = $1 AND (guild_id = $2 OR guild_id IS NULL) ORDER BY RANDOM() LIMIT 1`, [name, guildId]);
        }
      }
    } catch (err) {
      console.error('❌ DB error in /exp:', err);
    }

    if (!res.rows.length && !flavorMap[name]) {
      try {
        const aiResponse = await smartAIResponse(name, userMention);
        const embed = new EmbedBuilder()
          .setDescription(`💬 ${aiResponse}`)
          .setColor(getRandomColor());
        return await interaction.channel.send({ embeds: [embed] });
      } catch (err) {
        console.error('❌ AI error in /exp:', err);
        return await interaction.channel.send('❌ AI failed to respond.');
      }
    }

    if (res.rows.length) {
      const exp = res.rows[0];
      const customMessage = exp?.content?.includes('{user}')
        ? exp.content.replace('{user}', userMention)
        : `💥 ${userMention} is experiencing "${name}" energy today!`;

      if (exp?.type === 'image') {
        try {
          const imageRes = await fetch(exp.content);
          if (!imageRes.ok) throw new Error(`Image failed to load: ${imageRes.status}`);
          const file = new AttachmentBuilder(exp.content);
          return await interaction.channel.send({ content: customMessage, files: [file] });
        } catch (err) {
          return await interaction.channel.send({ content: `⚠️ Image broken, but:\n${customMessage}` });
        }
      }

      const embed = new EmbedBuilder().setDescription(customMessage).setColor(getRandomColor());
      return interaction.channel.send({ embeds: [embed] });
    }

    const builtIn = getRandomFlavor(name, userMention);
    const embed = new EmbedBuilder()
      .setDescription(builtIn || `💥 ${userMention} is experiencing "${name}" energy today!`)
      .setColor(getRandomColor());

    return interaction.channel.send({ embeds: [embed] });
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

    let query, params, res = { rows: [] };
    try {
      if (pg) {
        if (isOwner) {
          query = `SELECT DISTINCT name, guild_id FROM expressions`;
          params = [];
        } else {
          query = `SELECT DISTINCT name, guild_id FROM expressions WHERE guild_id = $1 OR guild_id IS NULL`;
          params = [guildId];
        }
        res = await pg.query(query, params);
      }
    } catch (err) {
      console.error('❌ Autocomplete DB error for exp:', err);
    }

    const thisServer = [], global = [], otherServers = [];
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

// ✅ Smart AI with Fallback Logic
async function smartAIResponse(keyword, userMention) {
  try {
    return await getGroqAI(keyword, userMention);
  } catch {
    console.warn('❌ Groq failed, trying OpenAI');
    try {
      return await getOpenAI(keyword, userMention);
    } catch {
      console.warn('❌ OpenAI failed');
      return `🧠 ${userMention} tried to flex "${keyword}" but confused every AI out there.`;
    }
  }
}

async function getGroqAI(keyword, userMention) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const apiKey = process.env.GROQ_API_KEY;

  const body = {
    model: 'llama3-70b-8192',
    messages: [
      { role: 'system', content: 'You are a savage Discord bot AI expression generator.' },
      { role: 'user', content: `Someone typed "${keyword}". Generate a savage one-liner. Insert {user} where you want to mention the user. Use Discord/Web3 slang. Max 1 sentence.` }
    ],
    max_tokens: 50,
    temperature: 0.9
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await res.json();
  const rawReply = data?.choices?.[0]?.message?.content?.trim();
  if (!rawReply) throw new Error('Empty AI response');

  return cleanQuotes(rawReply.replace(/{user}/gi, userMention));
}

async function getOpenAI(keyword, userMention) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: 'You are a witty and sarcastic Discord bot that talks like a Web3 degenerate.' },
        { role: 'user', content: `Make a short sharp comment for someone expressing "${keyword}". Mention {user}.` }
      ],
      max_tokens: 60,
      temperature: 1.1
    })
  });

  const json = await res.json();
  const rawReply = json?.choices?.[0]?.message?.content;
  if (!rawReply) throw new Error('OpenAI gave no response');
  return cleanQuotes(rawReply).replace(/{user}/gi, userMention);
}

function cleanQuotes(text) {
  return text.replace(/^"(.*)"$/, '$1').trim();
}













