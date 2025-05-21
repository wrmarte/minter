const { JsonRpcProvider, Contract, ZeroAddress, id, Interface } = require('ethers');
const { EmbedBuilder } = require('discord.js');
const fetch = require('node-fetch');

const abi = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event ERC20Payment(address indexed from, address indexed to, address token, uint256 amount)',
  'function tokenURI(uint256 tokenId) view returns (string)'
];

const iface = new Interface(abi);

module.exports = function trackContract(client, pg, contractAddress, channelIds) {
  const provider = new JsonRpcProvider(process.env.RPC_URL);
  const contract = new Contract(contractAddress, abi, provider);

  provider.on('block', async (blockNumber) => {
    try {
      const logs = await provider.getLogs({
        address: contractAddress,
        fromBlock: blockNumber - 1,
        toBlock: blockNumber
      });

      for (const log of logs) {
        const parsed = iface.parseLog(log);
        if (parsed.name === 'Transfer') {
          const from = parsed.args.from;
          const to = parsed.args.to;
          const tokenId = parsed.args.tokenId.toString();

          if (from === ZeroAddress) {
            for (const channelId of channelIds) {
              const embed = new EmbedBuilder()
                .setTitle('🟢 Mint Detected')
                .setDescription(`**Token ID:** ${tokenId}\n**To:** ${to}`)
                .setFooter({ text: `Contract: ${contractAddress}` })
                .setColor(0x2ecc71);
              const channel = await client.channels.fetch(channelId);
              if (channel) channel.send({ embeds: [embed] });
            }
          }
        }

        if (parsed.name === 'ERC20Payment') {
          const from = parsed.args.from;
          const to = parsed.args.to;
          const token = parsed.args.token;
          const amount = parsed.args.amount.toString();

          for (const channelId of channelIds) {
            const embed = new EmbedBuilder()
              .setTitle('🟨 Token Sale Detected')
              .setDescription(`**Amount:** ${amount}\n**Token:** ${token}`)
              .setFooter({ text: `Contract: ${contractAddress}` })
              .setColor(0xf1c40f);
            const channel = await client.channels.fetch(channelId);
            if (channel) channel.send({ embeds: [embed] });
          }
        }
      }
    } catch (err) {
      console.error('❌ Error in trackContract for', contractAddress, err);
    }
  });
};



