require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleVoiceStateUpdate, startCleanupLoop } = require('./src/voiceHandler');
const { handleInteraction } = require('./src/interactionHandler');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  console.log(`📡 Serving ${client.guilds.cache.size} server(s)`);
  startCleanupLoop(client);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(client, oldState, newState);
});

client.on('interactionCreate', (interaction) => {
  handleInteraction(client, interaction);
});

client.login(process.env.BOT_TOKEN);
