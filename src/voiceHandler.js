const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { JOIN_TO_CREATE_CHANNEL_ID, CATEGORY_ID, LANGUAGES, DEFAULT_USER_LIMIT } = require('./config');
const { activeChannels, pendingCreation } = require('./store');

// Tracks userId -> timestamp of last VC creation trigger (30s user cooldown)
const creationCooldown = new Map();
const COOLDOWN_MS = 5_000;

// Synchronous lock — set before any await so duplicate events in same tick are blocked
const functionLock = new Set();

async function handleVoiceStateUpdate(client, oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // ── User joins trigger channel ───────────────────────────────────────────
  if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
    const now = Date.now();
    const lastTrigger = creationCooldown.get(member.id);

    if (lastTrigger && now - lastTrigger < COOLDOWN_MS) {
      console.log(`🚫 Cooldown active for ${member.user.tag}, ignoring trigger`);
      return;
    }

    // Check function lock synchronously before doing anything async
    if (functionLock.has(member.id)) {
      console.log(`🔒 Function locked for ${member.user.tag}, ignoring trigger`);
      return;
    }

    // Set BOTH locks synchronously right here — before any await
    functionLock.add(member.id);
    creationCooldown.set(member.id, now);

    // Clear them after their respective durations
    setTimeout(() => functionLock.delete(member.id), 5_000);
    setTimeout(() => creationCooldown.delete(member.id), COOLDOWN_MS);

    await createTempChannel(client, member, newState.guild);
    return;
  }

  // ── User leaves a managed VC ─────────────────────────────────────────────
  if (oldState.channelId && activeChannels.has(oldState.channelId)) {
    if (newState.channelId) return;

    const ch = oldState.guild.channels.cache.get(oldState.channelId);
    if (ch && ch.members.size === 0) {
      activeChannels.delete(oldState.channelId);
      pendingCreation.delete(oldState.channelId);
      await ch.delete().catch(() => {});
      console.log(`🗑️  Deleted empty VC: ${ch.name}`);
    }
  }
}

async function createTempChannel(client, member, guild) {
  try {
    const channel = await guild.channels.create({
      name: `🌐 ${member.displayName}'s VC`,
      type: ChannelType.GuildVoice,
      parent: CATEGORY_ID,
      userLimit: DEFAULT_USER_LIMIT,
      permissionOverwrites: [
        {
          id: guild.id,
          allow: [PermissionFlagsBits.Connect, PermissionFlagsBits.ViewChannel],
        },
        {
          id: member.id,
          allow: [
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.MoveMembers,
            PermissionFlagsBits.MuteMembers,
            PermissionFlagsBits.DeafenMembers,
          ],
        },
      ],
    });

    activeChannels.set(channel.id, {
      ownerId: member.id,
      language: null,
      guildId: guild.id,
    });

    await member.voice.setChannel(channel);

    const row = new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(`select_language_${channel.id}`)
        .setPlaceholder('🌐 Pick your VC language...')
        .addOptions(
          LANGUAGES.map((l) => ({
            label: l.label,
            value: l.code,
            description: `Prefix: ${l.prefix}`,
          }))
        )
    );

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle('🎙️ Pick Your VC Language')
      .setDescription(
        `Hey ${member}, pick a **language** for your VC!\nIt will be added as a prefix to the channel name.\n\n⏰ **You have 60 seconds** or the channel will close.`
      )
      .setFooter({ text: 'Only the owner can pick' });

    const promptMsg = await channel.send({
      content: `<@${member.id}>`,
      embeds: [embed],
      components: [row],
    });

    const timeout = setTimeout(async () => {
      if (pendingCreation.has(channel.id)) {
        pendingCreation.delete(channel.id);
        activeChannels.delete(channel.id);
        await channel.delete().catch(() => {});
      }
    }, 60_000);

    pendingCreation.set(channel.id, {
      ownerId: member.id,
      guildId: guild.id,
      promptMsg,
      timeout,
    });

  } catch (err) {
    console.error('Failed to create temp VC:', err);
    functionLock.delete(member.id);
    for (const [id, data] of activeChannels) {
      if (data.ownerId === member.id && data.language === null) {
        activeChannels.delete(id);
      }
    }
  }
}

async function finalizeChannel(client, member, guild, channel, languageCode, promptMsg, timeout) {
  clearTimeout(timeout);
  pendingCreation.delete(channel.id);

  const lang = LANGUAGES.find((l) => l.code === languageCode);
  const newName = `${lang.prefix} ${member.displayName}'s VC`;

  await channel.setName(newName).catch(() => {});

  const channelData = activeChannels.get(channel.id);
  if (channelData) channelData.language = languageCode;

  await promptMsg.delete().catch(() => {});
  await sendControlPanel(member, channel);

}

async function sendControlPanel(member, channel) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎛️ VC Control Panel')
    .setDescription(`Welcome to **${channel.name}**! Use the buttons below to manage your VC.`)
    .addFields(
      { name: '✏️ Rename', value: 'Change channel name', inline: true },
      { name: '👥 Limit', value: 'Set max users', inline: true },
      { name: '👢 Kick', value: 'Remove someone', inline: true },
    )
    .setFooter({ text: 'Only the owner can use these buttons' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc_rename_${channel.id}`).setLabel('✏️ Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vc_limit_${channel.id}`).setLabel('👥 Limit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc_kick_${channel.id}`).setLabel('👢 Kick').setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] }).catch(() => {});
}

module.exports = { handleVoiceStateUpdate, finalizeChannel };
