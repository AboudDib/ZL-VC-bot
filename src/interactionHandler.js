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

// ── Action Locks (timeout-based so dismissed modals don't lock forever) ──────
const actionLocks = new Map();

function isLocked(channelId, action) {
  return !!actionLocks.get(`${channelId}_${action}`);
}

function lock(channelId, action, timeoutMs = 30_000) {
  const key = `${channelId}_${action}`;
  const existing = actionLocks.get(key);
  if (existing?.timeout) clearTimeout(existing.timeout);
  const timeout = setTimeout(() => actionLocks.delete(key), timeoutMs);
  actionLocks.set(key, { locked: true, timeout });
}

function unlock(channelId, action) {
  const key = `${channelId}_${action}`;
  const existing = actionLocks.get(key);
  if (existing?.timeout) clearTimeout(existing.timeout);
  actionLocks.delete(key);
}


async function handleInteraction(client, interaction) {
  try {

    // ── Language Select (posted in VC text chat) ──────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_language_')) {
      const channelId = interaction.customId.replace('select_language_', '');
      const languageCode = interaction.values[0];
      const userId = interaction.user.id;

      const pending = pendingCreation.get(channelId);
      if (!pending) {
        return interaction.reply({ content: '❌ This selection already expired.', ...EPH });
      }
      if (pending.ownerId !== userId) {
        return interaction.reply({ content: '❌ Only the VC owner can pick the language.', ...EPH });
      }

      const guild = client.guilds.cache.get(pending.guildId);
      const channel = await guild?.channels.fetch(channelId).catch(() => null);
      const member = guild?.members.cache.get(userId) || await guild?.members.fetch(userId).catch(() => null);

      if (!channel || !member) {
        return interaction.reply({ content: '❌ Channel or member not found.', ...EPH });
      }

      await interaction.reply({ content: '✅ Setting up your VC...', ...EPH });
      await finalizeChannel(client, member, guild, channel, languageCode, pending.promptMsg, pending.timeout);
      return;
    }

    // ── Buttons (in VC text chat) ─────────────────────────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split('_');
      const action = parts[1];
      const channelId = parts[2];

      const channelData = activeChannels.get(channelId);
      if (!channelData) {
        return interaction.reply({ content: '❌ This VC no longer exists.', ...EPH });
      }
      if (channelData.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Only the VC owner can use these buttons.', ...EPH });
      }

      const guild = client.guilds.cache.get(channelData.guildId);
      const guildChannel = await guild?.channels.fetch(channelId).catch(() => null);
      if (!guildChannel) {
        return interaction.reply({ content: '❌ Channel not found.', ...EPH });
      }

      if (action === 'rename') {
        if (isLocked(channelId, 'rename')) {
          return interaction.reply({ content: '⏳ Please wait before renaming again.', ...EPH });
        }

        lock(channelId, 'rename', 30_000);

        const modal = new ModalBuilder()
          .setCustomId(`modal_rename_${channelId}`)
          .setTitle('Rename Your Voice Channel');

        const nameInput = new TextInputBuilder()
          .setCustomId('new_name')
          .setLabel('New name (language prefix auto-added)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Chill Zone')
          .setMaxLength(80)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return interaction.showModal(modal);
      }

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

      if (action === 'kick') {
        const row = new ActionRowBuilder().addComponents(
          new UserSelectMenuBuilder()
            .setCustomId(`userselect_kick_${channelId}`)
            .setPlaceholder('Select user to kick from VC')
            .setMinValues(1)
            .setMaxValues(1)
        );
        return interaction.reply({ content: 'Select who to kick:', components: [row], ...EPH });
      }
    }

    // ── User Select (kick) ────────────────────────────────────────────────
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('userselect_kick_')) {
      const channelId = interaction.customId.replace('userselect_kick_', '');
      const channelData = activeChannels.get(channelId);

      if (!channelData || channelData.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Not authorized.', ...EPH });
      }

      const guild = client.guilds.cache.get(channelData.guildId);
      const targetId = interaction.values[0];
      const targetMember = guild?.members.cache.get(targetId) || await guild?.members.fetch(targetId).catch(() => null);

      if (!targetMember) return interaction.reply({ content: '❌ User not found.', ...EPH });
      if (targetId === interaction.user.id) return interaction.reply({ content: "❌ You can't kick yourself.", ...EPH });

      const voiceState = guild.voiceStates.cache.get(targetId);
      if (voiceState?.channelId !== channelId) {
        return interaction.reply({ content: '❌ That user is not in your VC.', ...EPH });
      }

      await targetMember.voice.disconnect();
      const guildChannel = await guild.channels.fetch(channelId).catch(() => null);
      if (!guildChannel) return interaction.reply({ content: '❌ Channel not found.', ...EPH });
      await guildChannel.permissionOverwrites.edit(targetId, { Connect: false });
      setTimeout(() => guildChannel.permissionOverwrites.delete(targetId).catch(() => {}), 60_000);

      return interaction.update({
        content: `👢 Kicked **${targetMember.displayName}** from your VC (blocked for 60s).`,
        components: [],
      });
    }

    // ── Modals ────────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split('_');
      const type = parts[1];
      const channelId = parts[2];

      // Always re-read from store at submit time — not a stale snapshot from button click
      const channelData = activeChannels.get(channelId);
      if (!channelData || channelData.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Not authorized.', ...EPH });
      }

      const guild = client.guilds.cache.get(channelData.guildId);

      if (type === 'rename') {
        try {
          const rawName = interaction.fields.getTextInputValue('new_name').trim();

          // Guard: language must be set (finalize should have written it)
          const lang = LANGUAGES.find((l) => l.code === channelData.language);
          if (!lang) {
            return interaction.reply({ content: '❌ Could not determine VC language. Please re-create your VC.', ...EPH });
          }

          const newName = `${lang.prefix} ${rawName}`;

          const freshChannel = await guild.channels.fetch(channelId).catch(() => null);
          if (!freshChannel) {
            return interaction.reply({ content: '❌ Channel no longer exists.', ...EPH });
          }

          await freshChannel.setName(newName);

          // Spread the current store record (re-read above), not a stale button-time snapshot
          activeChannels.set(channelId, {
            ...channelData,
            lastName: newName,
            updatedAt: Date.now(),
          });

          return interaction.reply({ content: `✅ Renamed to **${newName}**`, ...EPH });

        } finally {
          unlock(channelId, 'rename');
        }
      }

      if (type === 'limit') {
        const limit = parseInt(interaction.fields.getTextInputValue('user_limit').trim());
        if (isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.reply({ content: '❌ Invalid number. Enter 0–99.', ...EPH });
        }

        const freshChannel = await guild.channels.fetch(channelId).catch(() => null);
        if (!freshChannel) return interaction.reply({ content: '❌ Channel no longer exists.', ...EPH });

        await freshChannel.setUserLimit(limit);
        return interaction.reply({
          content: limit === 0 ? '✅ User limit removed (unlimited).' : `✅ User limit set to **${limit}**.`,
          ...EPH,
        });
      }
    }

  } catch (err) {
    console.error('Interaction error:', err);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '❌ Something went wrong.', ...EPH }).catch(() => {});
    }
  }
}

module.exports = { handleInteraction };
