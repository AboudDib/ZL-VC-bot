const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  UserSelectMenuBuilder,
} = require('discord.js');
const { activeChannels, pendingCreation } = require('./store');
const { createVoiceChannel } = require('./voiceHandler');
const { LANGUAGES } = require('./config');

async function handleInteraction(client, interaction) {
  // ── Language Select Menu ─────────────────────────────────────────────────
  if (interaction.isStringSelectMenu() && interaction.customId === 'select_language') {
    await interaction.deferReply({ ephemeral: true });

    const languageCode = interaction.values[0];
    const userId = interaction.user.id;

    if (!pendingCreation.has(userId)) {
      return interaction.editReply({ content: '❌ No pending VC creation. Join the trigger channel first.' });
    }

    const { guildId } = pendingCreation.get(userId);
    pendingCreation.delete(userId);

    const guild = client.guilds.cache.get(guildId);
    if (!guild) return interaction.editReply({ content: '❌ Server not found.' });

    const member = guild.members.cache.get(userId) || await guild.members.fetch(userId);

    // Check if member is still in the trigger channel
    const voiceState = guild.voiceStates.cache.get(userId);
    if (!voiceState?.channelId) {
      return interaction.editReply({ content: '❌ You left the trigger channel. Rejoin to create a VC.' });
    }

    const lang = LANGUAGES.find((l) => l.code === languageCode);
    await interaction.editReply({ content: `✅ Creating your **${lang.label}** voice channel...` });

    await createVoiceChannel(client, member, guild, languageCode);
    return;
  }

  // ── Buttons ───────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const [, action, channelId] = interaction.customId.split('_');
    const channel = interaction.guild
      ? interaction.guild.channels.cache.get(channelId)
      : client.channels.cache.get(channelId);

    const channelData = activeChannels.get(channelId);

    if (!channelData) {
      return interaction.reply({ content: '❌ This VC no longer exists.', ephemeral: true });
    }

    if (channelData.ownerId !== interaction.user.id) {
      return interaction.reply({ content: '❌ You are not the owner of this VC.', ephemeral: true });
    }

    // Resolve the guild from the channel
    const guild = client.guilds.cache.get(channelData.guildId);
    const guildChannel = guild?.channels.cache.get(channelId);

    if (!guildChannel) {
      return interaction.reply({ content: '❌ Channel not found.', ephemeral: true });
    }

    // 🔒 LOCK
    if (action === 'lock') {
      await guildChannel.permissionOverwrites.edit(guild.id, {
        Connect: false,
      });
      channelData.locked = true;
      return interaction.reply({ content: '🔒 Your VC is now **locked**. No one new can join.', ephemeral: true });
    }

    // 🔓 UNLOCK
    if (action === 'unlock') {
      await guildChannel.permissionOverwrites.edit(guild.id, {
        Connect: true,
      });
      channelData.locked = false;
      return interaction.reply({ content: '🔓 Your VC is now **unlocked**.', ephemeral: true });
    }

    // ✏️ RENAME
    if (action === 'rename') {
      const lang = LANGUAGES.find((l) => l.code === channelData.language);
      const modal = new ModalBuilder()
        .setCustomId(`modal_rename_${channelId}`)
        .setTitle('Rename Your Voice Channel');

      const nameInput = new TextInputBuilder()
        .setCustomId('new_name')
        .setLabel('New channel name')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder(`e.g. Chill Zone`)
        .setMaxLength(80)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
      return interaction.showModal(modal);
    }

    // 👥 SET LIMIT
    if (action === 'limit') {
      const modal = new ModalBuilder()
        .setCustomId(`modal_limit_${channelId}`)
        .setTitle('Set User Limit');

      const limitInput = new TextInputBuilder()
        .setCustomId('user_limit')
        .setLabel('Max users (0 = unlimited, max 99)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 5')
        .setMaxLength(2)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(limitInput));
      return interaction.showModal(modal);
    }

    // 👢 KICK USER
    if (action === 'kick') {
      const row = new ActionRowBuilder().addComponents(
        new UserSelectMenuBuilder()
          .setCustomId(`userselect_kick_${channelId}`)
          .setPlaceholder('Select user to kick from VC')
          .setMinValues(1)
          .setMaxValues(1)
      );
      return interaction.reply({ content: 'Select who to kick:', components: [row], ephemeral: true });
    }
  }

  // ── User Select (kick) ────────────────────────────────────────────────────
  if (interaction.isUserSelectMenu() && interaction.customId.startsWith('userselect_kick_')) {
    const channelId = interaction.customId.replace('userselect_kick_', '');
    const channelData = activeChannels.get(channelId);

    if (!channelData || channelData.ownerId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Not authorized.', ephemeral: true });
    }

    const guild = client.guilds.cache.get(channelData.guildId);
    const targetId = interaction.values[0];
    const targetMember = guild?.members.cache.get(targetId);

    if (!targetMember) return interaction.reply({ content: '❌ User not found.', ephemeral: true });
    if (targetId === interaction.user.id) return interaction.reply({ content: "❌ You can't kick yourself.", ephemeral: true });

    const voiceState = guild.voiceStates.cache.get(targetId);
    if (voiceState?.channelId !== channelId) {
      return interaction.reply({ content: '❌ That user is not in your VC.', ephemeral: true });
    }

    await targetMember.voice.disconnect();
    // Temporarily block rejoin
    const guildChannel = guild.channels.cache.get(channelId);
    await guildChannel.permissionOverwrites.edit(targetId, { Connect: false });
    setTimeout(() => {
      guildChannel.permissionOverwrites.delete(targetId).catch(() => {});
    }, 60_000);

    return interaction.update({ content: `👢 Kicked **${targetMember.displayName}** from your VC (blocked for 60s).`, components: [] });
  }

  // ── Modals ────────────────────────────────────────────────────────────────
  if (interaction.isModalSubmit()) {
    const [, type, channelId] = interaction.customId.split('_');
    const channelData = activeChannels.get(channelId);

    if (!channelData || channelData.ownerId !== interaction.user.id) {
      return interaction.reply({ content: '❌ Not authorized.', ephemeral: true });
    }

    const guild = client.guilds.cache.get(channelData.guildId);
    const guildChannel = guild?.channels.cache.get(channelId);

    if (!guildChannel) return interaction.reply({ content: '❌ Channel gone.', ephemeral: true });

    // Rename modal
    if (type === 'rename') {
      const rawName = interaction.fields.getTextInputValue('new_name').trim();
      const lang = LANGUAGES.find((l) => l.code === channelData.language);
      const newName = `${lang.prefix} ${rawName}`;

      await guildChannel.setName(newName);
      return interaction.reply({ content: `✅ Channel renamed to **${newName}**`, ephemeral: true });
    }

    // Limit modal
    if (type === 'limit') {
      const limitStr = interaction.fields.getTextInputValue('user_limit').trim();
      const limit = parseInt(limitStr);

      if (isNaN(limit) || limit < 0 || limit > 99) {
        return interaction.reply({ content: '❌ Invalid number. Use 0–99.', ephemeral: true });
      }

      await guildChannel.setUserLimit(limit);
      return interaction.reply({
        content: limit === 0 ? '✅ User limit removed (unlimited).' : `✅ User limit set to **${limit}**.`,
        ephemeral: true,
      });
    }
  }
}

module.exports = { handleInteraction };
