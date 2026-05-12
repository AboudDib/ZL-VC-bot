require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleVoiceStateUpdate } = require('./src/voiceHandler');
const { handleInteraction } = require('./src/interactionHandler');
const http = require('http');

process.on("unhandledRejection", console.error);
process.on("uncaughtException", console.error);

// ── Discord Client ───────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Events ───────────────────────────────
client.once('ready', () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(client, oldState, newState);
});

client.on('interactionCreate', (interaction) => {
  handleInteraction(client, interaction);
});

// ── Keep-alive server ───────────────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`🌐 Keep-alive server running on port ${process.env.PORT || 3000}`);
});

// ── Login bot (ONLY ONCE) ───────────────────────────
client.login(process.env.BOT_TOKEN);
