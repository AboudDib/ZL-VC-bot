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

  // ── User leaves a managed VC ─────────────────────────────────────────────
  if (oldState.channelId && activeChannels.has(oldState.channelId)) {
    const ch = oldState.guild.channels.cache.get(oldState.channelId);
    if (ch && ch.members.size === 0) {
      const data = activeChannels.get(oldState.channelId);

      // Clear the 60s timeout if it's still running (finalized or not)
      if (data?.timeoutRef) clearTimeout(data.timeoutRef);

      activeChannels.delete(oldState.channelId);
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

    // Step 4: 60s timeout — delete if still not finalized
    const timeoutRef = setTimeout(async () => {
      const data = activeChannels.get(channel.id);
      if (data && !data.finalized) {
        activeChannels.delete(channel.id);
        console.log(`⏰ Timeout — deleting VC: ${channel.name}`);
        await channel.delete().catch(() => {});
      }
    }, 60_000);

    // Step 5: Register in activeChannels — single source of truth
    activeChannels.set(channel.id, {
      ownerId: member.id,
      guildId: guild.id,
      language: null,
      locked: false,
      finalized: false,
      timeoutRef,
      promptMsgId: promptMsg.id,
    });

  } catch (err) {
    console.error('Failed to create temp VC:', err);
  }
}

async function finalizeChannel(client, member, guild, channel, languageCode) {
  const data = activeChannels.get(channel.id);
  if (!data) return; // already cleaned up

  // Cancel the 60s timeout
  clearTimeout(data.timeoutRef);

  const lang = LANGUAGES.find((l) => l.code === languageCode);
  const newName = `${lang.prefix} ${member.displayName}'s VC`;

  // Rename the channel
  await channel.setName(newName).catch(() => {});

  // Delete the language prompt message
  try {
    const promptMsg = await channel.messages.fetch(data.promptMsgId);
    await promptMsg.delete().catch(() => {});
  } catch {
    // message already gone, fine
  }

  // Update the store entry in-place — channel.id never changes
  data.language = languageCode;
  data.finalized = true;
  data.timeoutRef = null;
  data.promptMsgId = null;

  // Send control panel
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
