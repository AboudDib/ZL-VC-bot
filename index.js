require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleVoiceStateUpdate } = require('./src/voiceHandler');
const { handleInteraction } = require('./src/interactionHandler');
const http = require('http');

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
});

client.on('voiceStateUpdate', (oldState, newState) => {
  handleVoiceStateUpdate(client, oldState, newState);
});

client.on('interactionCreate', (interaction) => {
  handleInteraction(client, interaction);
});

// ── Keep-alive server so Render doesn't sleep the bot ───────────────────────
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end('OK');
});

server.listen(3000, () => {
  console.log('🌐 Keep-alive server running on port 3000');
});

// Ping itself every 5 minutes
setInterval(() => {
  http.get('http://localhost:3000', (res) => {
    console.log(`♻️  Keep-alive ping: ${res.statusCode}`);
  }).on('error', (err) => {
    console.error('Keep-alive ping failed:', err.message);
  });
}, 5 * 60 * 1000);

client.login(process.env.BOT_TOKEN);
