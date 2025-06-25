const { SlashCommandBuilder } = require('discord.js');
const { Configuration, OpenAIApi } = require('openai');

const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

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
      const completion = await openai.createChatCompletion({
        model: 'gpt-4',
        messages: [
          {
            role: 'system',
            content:
              'You are MuscleMB — an uncensored, degen AI who lifts heavy, trades JPEGs, eats memes for breakfast, and spits alpha like fire. Be witty, raw, savage, but helpful. If the user asks something serious, give a real answer but keep your degen tone.',
          },
          { role: 'user', content: userMsg },
        ],
        temperature: 0.95,
      });

      const aiReply = completion.data.choices[0].message.content;
      await interaction.editReply(aiReply);
    } catch (err) {
      console.error('❌ MuscleMB error:', err.message);
      await interaction.editReply('⚠️ MuscleMB blacked out from too much alpha. Try again soon.');
    }
  },
};
