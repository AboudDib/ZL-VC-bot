const {
  ChannelType,
  PermissionFlagsBits,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
} = require('discord.js');
const { JOIN_TO_CREATE_CHANNEL_ID, CATEGORY_ID, LANGUAGES, DEFAULT_USER_LIMIT } = require('./config');
const { activeChannels, pendingCreation } = require('./store');

async function handleVoiceStateUpdate(client, oldState, newState) {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  // ─── User JOINS the trigger channel ───────────────────────────────────────
  if (newState.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
    await promptLanguageSelection(client, member, newState.guild);
    return;
  }

  // ─── User LEAVES a channel ────────────────────────────────────────────────
  if (oldState.channelId && activeChannels.has(oldState.channelId)) {
    const ch = oldState.guild.channels.cache.get(oldState.channelId);
    if (ch && ch.members.size === 0) {
      activeChannels.delete(oldState.channelId);
      await ch.delete().catch(() => {});
      console.log(`🗑️  Deleted empty VC: ${ch.name}`);
    }
  }
}

// ─── Send language selector DM / ephemeral ────────────────────────────────
async function promptLanguageSelection(client, member, guild) {
  // Move them to a "limbo" — we just keep them in the trigger channel until they pick
  pendingCreation.set(member.id, { guildId: guild.id });

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('select_language')
      .setPlaceholder('🌐 Pick your VC language...')
      .addOptions(
        LANGUAGES.map((l) => ({
          label: l.label,
          value: l.code,
          description: `Channel will be prefixed with ${l.prefix}`,
        }))
      )
  );

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🎙️ Create Your Voice Channel')
    .setDescription(
      'Pick the **language** for your VC.\nIt will be added as a prefix to your channel name.\n\n> You can rename, lock, and manage your VC after creation.'
    )
    .setFooter({ text: 'VoiceMaster • Selection expires in 60s' });

  try {
    const dm = await member.send({ embeds: [embed], components: [row] });

    // Auto-expire after 60s
    setTimeout(async () => {
      if (pendingCreation.has(member.id)) {
        pendingCreation.delete(member.id);
        await dm.edit({ content: '⏰ Selection expired.', components: [] }).catch(() => {});
        // Kick them out of trigger channel
        const triggerCh = guild.channels.cache.get(JOIN_TO_CREATE_CHANNEL_ID);
        if (triggerCh) {
          const voiceState = guild.voiceStates.cache.get(member.id);
          if (voiceState?.channelId === JOIN_TO_CREATE_CHANNEL_ID) {
            await member.voice.disconnect().catch(() => {});
          }
        }
      }
    }, 60_000);
  } catch {
    // DMs closed — fall back to a channel message
    const fallback = guild.channels.cache.find(
      (c) => c.isTextBased() && c.name.includes('general')
    );
    if (fallback) {
      const msg = await fallback.send({
        content: `${member}, pick a language for your VC:`,
        embeds: [embed],
        components: [row],
      });
      setTimeout(() => msg.delete().catch(() => {}), 60_000);
    }
  }
}

// ─── Actually create the VC after language is chosen ─────────────────────
async function createVoiceChannel(client, member, guild, languageCode) {
  const lang = LANGUAGES.find((l) => l.code === languageCode);
  if (!lang) return;

  const channelName = `${lang.prefix} ${member.displayName}'s VC`;

  try {
    const channel = await guild.channels.create({
      name: channelName,
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
      language: languageCode,
      guildId: guild.id,
      locked: false,
    });

    // Move the member into their new channel
    await member.voice.setChannel(channel);
    console.log(`✅ Created VC: ${channelName} for ${member.user.tag}`);

    // Send control panel
    await sendControlPanel(member, channel);
  } catch (err) {
    console.error('Failed to create VC:', err);
  }
}

// ─── Control panel DM ─────────────────────────────────────────────────────
async function sendControlPanel(member, channel) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle('🎛️ Your VC Control Panel')
    .setDescription(`**Channel:** ${channel.name}`)
    .addFields(
      { name: '🔒 Lock', value: 'Block others from joining', inline: true },
      { name: '🔓 Unlock', value: 'Allow everyone to join', inline: true },
      { name: '✏️ Rename', value: 'Change channel name', inline: true },
      { name: '👥 Set Limit', value: 'Max user count', inline: true },
      { name: '👢 Kick User', value: 'Remove someone', inline: true },
      { name: '👑 Transfer', value: 'Give ownership', inline: true }
    )
    .setFooter({ text: `Channel ID: ${channel.id}` });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`vc_lock_${channel.id}`).setLabel('🔒 Lock').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`vc_unlock_${channel.id}`).setLabel('🔓 Unlock').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`vc_rename_${channel.id}`).setLabel('✏️ Rename').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`vc_limit_${channel.id}`).setLabel('👥 Set Limit').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`vc_kick_${channel.id}`).setLabel('👢 Kick User').setStyle(ButtonStyle.Danger)
  );

  try {
    await member.send({ embeds: [embed], components: [row1] });
  } catch {
    // DMs closed, skip panel
  }
}

module.exports = { handleVoiceStateUpdate, createVoiceChannel };
