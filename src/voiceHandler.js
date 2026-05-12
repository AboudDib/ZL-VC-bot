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

// Cooldown set to prevent duplicate channel creation per user
const creationCooldown = new Set();

async function handleVoiceStateUpdate(client, oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // ── User joins trigger channel ───────────────────────────────────────────
  if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
    // If this user is already being processed, ignore the duplicate event
    if (creationCooldown.has(member.id)) return;
    creationCooldown.add(member.id);
    setTimeout(() => creationCooldown.delete(member.id), 5000); // clear after 5s

    await createTempChannel(client, member, newState.guild);
    return;
  }

  // ── User leaves a managed VC ─────────────────────────────────────────────
  if (oldState.channelId && activeChannels.has(oldState.channelId)) {
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
    // Step 1: Create the VC immediately with a temp name
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

    // Step 2: Move member into it
    await member.voice.setChannel(channel);
    console.log(`✅ Temp VC created: ${channel.name} for ${member.user.tag}`);

    // Step 3: Post language picker in the VC text chat
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

    // Step 4: Store as pending — no language yet
    const timeout = setTimeout(async () => {
      if (pendingCreation.has(channel.id)) {
        pendingCreation.delete(channel.id);
        activeChannels.delete(channel.id);
        console.log(`⏰ Timeout — deleting VC: ${channel.name}`);
        await channel.delete().catch(() => {});
      }
    }, 60_000);

    pendingCreation.set(channel.id, {
      ownerId: member.id,
      guildId: guild.id,
      promptMsg,
      timeout,
    });

    // Mark as active but language not set yet
    activeChannels.set(channel.id, {
      ownerId: member.id,
      language: null,
      guildId: guild.id,
      locked: false,
    });

  } catch (err) {
    console.error('Failed to create temp VC:', err);
  }
}

async function finalizeChannel(client, member, guild, channel, languageCode, promptMsg, timeout) {
  // Cancel the 60s timeout
  clearTimeout(timeout);
  pendingCreation.delete(channel.id);

  const lang = LANGUAGES.find((l) => l.code === languageCode);
  const newName = `${lang.prefix} ${member.displayName}'s VC`;

  // Rename the channel
  await channel.setName(newName).catch(() => {});

  // Update language in store
  const channelData = activeChannels.get(channel.id);
  if (channelData) channelData.language = languageCode;

  // Delete the language prompt message
  await promptMsg.delete().catch(() => {});

  // Send control panel in VC text chat
  await sendControlPanel(member, channel);

  console.log(`✅ Finalized VC: ${newName}`);
}

async function sendControlPanel(member, channel) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎛️ VC Control Panel')
    .setDescription(`Welcome to **${channel.name}**! Use the buttons below to manage your VC.`)
    .addFields(
      { name: '🔒 Lock', value: 'Block others from joining', inline: true },
      { name: '🔓 Unlock', value: 'Open it back up', inline: true },
      { name: '✏️ Rename', value: 'Change channel name', inline: true },
      { name: '👥 Limit', value: 'Set max users', inline: true },
      { name: '👢 Kick', value: 'Remove someone', inline: true },
    )
    .setFooter({ text: 'Only the owner can use these buttons' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc_lock_${channel.id}`).setLabel('🔒 Lock').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vc_unlock_${channel.id}`).setLabel('🔓 Unlock').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vc_rename_${channel.id}`).setLabel('✏️ Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vc_limit_${channel.id}`).setLabel('👥 Limit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc_kick_${channel.id}`).setLabel('👢 Kick').setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `<@${member.id}>`, embeds: [embed], components: [row] }).catch(() => {});
}

module.exports = { handleVoiceStateUpdate, finalizeChannel };
