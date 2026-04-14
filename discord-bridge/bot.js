/**
 * n8n-claw Discord Bridge
 *
 * Connects to Discord's Gateway as a bot, forwards incoming channel messages
 * to n8n's webhook adapter, and exposes a /reply endpoint so n8n can send
 * replies back through the same bot (no duplicate bot token in n8n).
 *
 * Enabled only when COMPOSE_PROFILES=discord and DISCORD_BOT_TOKEN is set.
 */

const express = require('express');
const { Client, GatewayIntentBits, ChannelType } = require('discord.js');

const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL || 'http://n8n:5678/webhook/adapter';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || '';
const BRIDGE_PORT = parseInt(process.env.BRIDGE_PORT || '3300', 10);

if (!BOT_TOKEN) {
  console.error('[discord-bridge] DISCORD_BOT_TOKEN not set — exiting');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
});

const recentIds = new Map();
setInterval(() => {
  const cutoff = Date.now() - 30000;
  for (const [id, ts] of recentIds) if (ts < cutoff) recentIds.delete(id);
}, 30000);

client.once('ready', () => {
  console.log(`[discord-bridge] logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.webhookId) return;
  if (!message.content || !message.content.trim()) return;
  if (recentIds.has(message.id)) return;
  recentIds.set(message.id, Date.now());

  try {
    const resp = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        message: message.content,
        user_id: message.author.id,
        session_id: `discord:${message.channel.id}`,
        source: 'discord',
        metadata: {
          _responseChannel: 'discord',
          channelId: message.channel.id,
          messageId: message.id,
          guildId: message.guild ? message.guild.id : null,
          authorName: message.author.username,
        },
      }),
    });
    if (!resp.ok) {
      console.error(`[discord-bridge] n8n returned ${resp.status}`);
    }
  } catch (e) {
    console.error(`[discord-bridge] forward error: ${e.message}`);
  }
});

client.on('error', (e) => console.error(`[discord-bridge] client error: ${e.message}`));

client.login(BOT_TOKEN).catch((e) => {
  console.error(`[discord-bridge] login failed: ${e.message}`);
  process.exit(1);
});

const app = express();
app.use(express.json({ limit: '1mb' }));

app.post('/reply', async (req, res) => {
  const { channelId, content } = req.body || {};
  if (!channelId || typeof content !== 'string') {
    return res.status(400).json({ error: 'channelId + content (string) required' });
  }
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased || !channel.isTextBased()) {
      return res.status(404).json({ error: 'channel not found or not text-based' });
    }
    const chunks = [];
    for (let i = 0; i < content.length; i += 1900) chunks.push(content.slice(i, i + 1900));
    if (chunks.length === 0) chunks.push('');
    for (const chunk of chunks) await channel.send(chunk);
    return res.json({ ok: true, chunks: chunks.length });
  } catch (e) {
    console.error(`[discord-bridge] reply error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: client.isReady(), bot: client.user ? client.user.tag : null });
});

app.listen(BRIDGE_PORT, () => {
  console.log(`[discord-bridge] http listening on :${BRIDGE_PORT}`);
});
