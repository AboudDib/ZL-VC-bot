const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  UserSelectMenuBuilder,
} = require('discord.js');

const { activeChannels, pendingCreation } = require('./store');
const { finalizeChannel } = require('./voiceHandler');
const { LANGUAGES } = require('./config');

const EPH = { flags: MessageFlags.Ephemeral };

async function fetchChannel(guild, channelId) {
  try {
    return await guild.channels.fetch(channelId);
  } catch {
    return null;
  }
}

async function handleInteraction(client, interaction) {
  try {

    // ── Language Select ─────────────────────────────────────────────────────
    if (
      interaction.isStringSelectMenu() &&
      interaction.customId.startsWith('select_language_')
    ) {
      const channelId = interaction.customId.replace('select_language_', '');
      const languageCode = interaction.values[0];
      const userId = interaction.user.id;

      const pending = pendingCreation.get(channelId);

      if (!pending) {
        return interaction.reply({
          content: '❌ This selection already expired.',
          ...EPH,
        });
      }

      if (pending.ownerId !== userId) {
        return interaction.reply({
          content: '❌ Only the VC owner can pick the language.',
          ...EPH,
        });
      }

      const guild = client.guilds.cache.get(pending.guildId);

      if (!guild) {
        return interaction.reply({
          content: '❌ Guild not found.',
          ...EPH,
        });
      }

      const channel = await fetchChannel(guild, channelId);

      const member =
        guild.members.cache.get(userId) ||
        await guild.members.fetch(userId).catch(() => null);

      if (!channel || !member) {
        return interaction.reply({
          content: '❌ Channel or member not found.',
          ...EPH,
        });
      }

      await interaction.reply({
        content: '✅ Setting up your VC...',
        ...EPH,
      });

      await finalizeChannel(
        client,
        member,
        guild,
        channel,
        languageCode,
        pending.promptMsg,
        pending.timeout
      );

      return;
    }

    // ── Buttons ────────────────────────────────────────────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split('_');

      const action = parts[1];
      const channelId = parts.slice(2).join('_');

      const channelData = activeChannels.get(channelId);

      if (!channelData) {
        return interaction.reply({
          content: '❌ This VC no longer exists.',
          ...EPH,
        });
      }

      if (channelData.ownerId !== interaction.user.id) {
        return interaction.reply({
          content: '❌ Only the VC owner can use these buttons.',
          ...EPH,
        });
      }

      const guild = client.guilds.cache.get(channelData.guildId);

      if (!guild) {
        return interaction.reply({
          content: '❌ Guild not found.',
          ...EPH,
        });
      }

      const guildChannel = await fetchChannel(guild, channelId);

      if (!guildChannel) {
        activeChannels.delete(channelId);

        return interaction.reply({
          content: '❌ Channel not found.',
          ...EPH,
        });
      }

      // LOCK
      if (action === 'lock') {
        await guildChannel.permissionOverwrites.edit(guild.id, {
          Connect: false,
        });

        channelData.locked = true;

        return interaction.reply({
          content: '🔒 VC locked.',
          ...EPH,
        });
      }

      // UNLOCK
      if (action === 'unlock') {
        await guildChannel.permissionOverwrites.edit(guild.id, {
          Connect: true,
        });

        channelData.locked = false;

        return interaction.reply({
          content: '🔓 VC unlocked.',
          ...EPH,
        });
      }

      // RENAME
      if (action === 'rename') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_rename_${channelId}`)
          .setTitle('Rename Your Voice Channel');

        const nameInput = new TextInputBuilder()
          .setCustomId('new_name')
          .setLabel('New name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Chill Zone')
          .setRequired(true)
          .setMaxLength(80);

        modal.addComponents(
          new ActionRowBuilder().addComponents(nameInput)
        );

        return interaction.showModal(modal);
      }

      // LIMIT
      if (action === 'limit') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_limit_${channelId}`)
          .setTitle('Set User Limit');

        const limitInput = new TextInputBuilder()
          .setCustomId('user_limit')
          .setLabel('0–99 users')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 5')
          .setRequired(true)
          .setMaxLength(2);

        modal.addComponents(
          new ActionRowBuilder().addComponents(limitInput)
        );

        return interaction.showModal(modal);
      }

      // KICK
      if (action === 'kick') {
        const row = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`userselect_kick_${channelId}`)
            .setPlaceholder('Select user to kick')
            .setMinValues(1)
            .setMaxValues(1)
        );

        return interaction.reply({
          content: 'Select someone to kick:',
          components: [row],
          ...EPH,
        });
      }
    }

    // ── Kick Select ────────────────────────────────────────────────────────
    if (
      interaction.isUserSelectMenu() &&
      interaction.customId.startsWith('userselect_kick_')
    ) {
      const channelId = interaction.customId.replace(
        'userselect_kick_',
        ''
      );

      const channelData = activeChannels.get(channelId);

      if (!channelData || channelData.ownerId !== interaction.user.id) {
        return interaction.reply({
          content: '❌ Not authorized.',
          ...EPH,
        });
      }

      const guild = client.guilds.cache.get(channelData.guildId);

      if (!guild) {
        return interaction.reply({
          content: '❌ Guild not found.',
          ...EPH,
        });
      }

      const guildChannel = await fetchChannel(guild, channelId);

      if (!guildChannel) {
        return interaction.reply({
          content: '❌ Channel not found.',
          ...EPH,
        });
      }

      const targetId = interaction.values[0];

      if (targetId === interaction.user.id) {
        return interaction.reply({
          content: "❌ You can't kick yourself.",
          ...EPH,
        });
      }

      const targetMember =
        guild.members.cache.get(targetId) ||
        await guild.members.fetch(targetId).catch(() => null);

      if (!targetMember) {
        return interaction.reply({
          content: '❌ User not found.',
          ...EPH,
        });
      }

      const voiceState = guild.voiceStates.cache.get(targetId);

      if (voiceState?.channelId !== channelId) {
        return interaction.reply({
          content: '❌ User is not in your VC.',
          ...EPH,
        });
      }

      await targetMember.voice.disconnect().catch(() => {});

      await guildChannel.permissionOverwrites.edit(targetId, {
        Connect: false,
      });

      setTimeout(() => {
        guildChannel.permissionOverwrites
          .delete(targetId)
          .catch(() => {});
      }, 60_000);

      return interaction.update({
        content: `👢 Kicked ${targetMember.displayName} from the VC.`,
        components: [],
      });
    }

    // ── Modals ─────────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split('_');

      const type = parts[1];
      const channelId = parts.slice(2).join('_');

      const channelData = activeChannels.get(channelId);

      if (!channelData || channelData.ownerId !== interaction.user.id) {
        return interaction.reply({
          content: '❌ Not authorized.',
          ...EPH,
        });
      }

      const guild = client.guilds.cache.get(channelData.guildId);

      if (!guild) {
        return interaction.reply({
          content: '❌ Guild not found.',
          ...EPH,
        });
      }

      const guildChannel = await fetchChannel(guild, channelId);

      if (!guildChannel) {
        activeChannels.delete(channelId);

        return interaction.reply({
          content: '❌ Channel no longer exists.',
          ...EPH,
        });
      }

      // RENAME MODAL
      if (type === 'rename') {
        const rawName = interaction.fields
          .getTextInputValue('new_name')
          .trim();

        const lang = LANGUAGES.find(
          (l) => l.code === channelData.language
        );

        const prefix = lang ? `${lang.prefix} ` : '';

        const newName = `${prefix}${rawName}`;

        await guildChannel.setName(newName).catch(() => {});

        return interaction.reply({
          content: `✅ Renamed to **${newName}**`,
          ...EPH,
        });
      }

      // LIMIT MODAL
      if (type === 'limit') {
        const limit = parseInt(
          interaction.fields
            .getTextInputValue('user_limit')
            .trim()
        );

        if (isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.reply({
            content: '❌ Enter a valid number from 0–99.',
            ...EPH,
          });
        }

        await guildChannel.setUserLimit(limit).catch(() => {});

        return interaction.reply({
          content:
            limit === 0
              ? '✅ User limit removed.'
              : `✅ User limit set to ${limit}.`,
          ...EPH,
        });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);

    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({
        content: '❌ Something went wrong.',
        ...EPH,
      }).catch(() => {});
    }
  }
}

module.exports = { handleInteraction };
