require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { handleVoiceStateUpdate } = require('./src/voiceHandler');
const { handleInteraction } = require('./src/interactionHandler');
const http = require('http');

// Keep Render Web Service alive by binding to a port
http.createServer((req, res) => res.end('Bot is alive!')).listen(process.env.PORT || 3000);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── REST request/response logger ─────────────────────────────────────────────
client.rest.on('request', (req) => {
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    console.log(`[REST ▶] ${req.method} ${req.path}`);
    if (req.data?.body) {
      try {
        console.log(`[REST ▶] body:`, JSON.stringify(JSON.parse(req.data.body), null, 2));
      } catch {
        console.log(`[REST ▶] body:`, req.data.body);
      }
    }
  }
});

client.rest.on('response', (req, res) => {
  if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
    console.log(`[REST ◀] ${req.method} ${req.path} → ${res.status}`);
  }
});
// ─────────────────────────────────────────────────────────────────────────────

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

client.login(process.env.BOT_TOKEN);
