const { SlashCommandBuilder } = require('discord.js');
const OpenAI = require('openai');

// ✅ OpenAI v4 compatible
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

module.exports = {
  data: new SlashCommandBuilder()
    .setName('musclemb')
    .setDescription('Talk to MuscleMB — your savage degen AI')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('What do you want to ask this beast?')
        .setRequired(true)
    ),

  async execute(interaction) {
    const userMsg = interaction.options.getString('message');
    await interaction.deferReply();

    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are MuscleMB — an uncensored, degen AI who lifts, flips JPEGs, and spits savage alpha. Stay raw, real, and ruthless.',
          },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.95,
      });

      const aiReply = completion.choices[0].message.content;
      await interaction.editReply(aiReply);
    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      await interaction.editReply('⚠️ MuscleMB is on cooldown after leg day. Try again soon.');
    }
  },
};
