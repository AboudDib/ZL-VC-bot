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
const { activeChannels } = require('./store');

async function handleVoiceStateUpdate(client, oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // ── User joins the trigger channel ───────────────────────────────────────
  if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
    await createTempChannel(client, member, newState.guild);
    return;
  }

  // ── User joins a managed VC — cancel any pending delete ──────────────────
  if (newState.channelId && activeChannels.has(newState.channelId)) {
    const data = activeChannels.get(newState.channelId);
    if (data?.deleteTimer) {
      clearTimeout(data.deleteTimer);
      data.deleteTimer = null;
      console.log(`↩️  Delete cancelled — user rejoined: ${newState.channel?.name}`);
    }
  }

  // ── User leaves a managed VC ─────────────────────────────────────────────
  if (oldState.channelId && activeChannels.has(oldState.channelId)) {
    const ch = oldState.guild.channels.cache.get(oldState.channelId);
    const data = activeChannels.get(oldState.channelId);

    if (ch && ch.members.size === 0 && data) {
      // 5s grace period — cancels if someone rejoins before it fires
      const deleteTimer = setTimeout(async () => {
        const freshCh = oldState.guild.channels.cache.get(oldState.channelId);
        if (!freshCh || freshCh.members.size > 0) {
          console.log(`↩️  Reprieve — someone rejoined: ${ch.name}`);
          return;
        }
        if (data.timeoutRef) clearTimeout(data.timeoutRef);
        activeChannels.delete(oldState.channelId);
        await freshCh.delete().catch(() => {});
        console.log(`🗑️  Deleted empty VC: ${freshCh.name}`);
      }, 5_000);

      data.deleteTimer = deleteTimer;
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

    await member.voice.setChannel(channel);
    console.log(`✅ Temp VC created: ${channel.name} for ${member.user.tag}`);

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

    const timeoutRef = setTimeout(async () => {
      const data = activeChannels.get(channel.id);
      if (data && !data.finalized) {
        activeChannels.delete(channel.id);
        console.log(`⏰ Timeout — deleting VC: ${channel.name}`);
        await channel.delete().catch(() => {});
      }
    }, 60_000);

    activeChannels.set(channel.id, {
      ownerId: member.id,
      guildId: guild.id,
      language: null,
      locked: false,
      finalized: false,
      timeoutRef,
      deleteTimer: null,
      promptMsgId: promptMsg.id,
    });

  } catch (err) {
    console.error('Failed to create temp VC:', err);
  }
}

async function finalizeChannel(client, member, guild, channel, languageCode) {
  const data = activeChannels.get(channel.id);
  if (!data) return;

  clearTimeout(data.timeoutRef);

  const lang = LANGUAGES.find((l) => l.code === languageCode);
  const newName = `${lang.prefix} ${member.displayName}'s VC`;

  await channel.setName(newName).catch(() => {});

  try {
    const promptMsg = await channel.messages.fetch(data.promptMsgId);
    await promptMsg.delete().catch(() => {});
  } catch {
    // message already gone, fine
  }

  data.language = languageCode;
  data.finalized = true;
  data.timeoutRef = null;
  data.promptMsgId = null;

  await sendControlPanel(member, channel);
  console.log(`✅ Finalized VC: ${newName}`);
}

async function sendControlPanel(member, channel) {
  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎛️ VC Control Panel')
    .setDescription(`Welcome to **${channel.name}**! Use the buttons below to manage your VC.`)
    .addFields(
      { name: '🔒 Lock',   value: 'Block others from joining', inline: true },
      { name: '🔓 Unlock', value: 'Open it back up',           inline: true },
      { name: '✏️ Rename', value: 'Change channel name',       inline: true },
      { name: '👥 Limit',  value: 'Set max users',             inline: true },
      { name: '👢 Kick',   value: 'Remove someone',            inline: true },
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
