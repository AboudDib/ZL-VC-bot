const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  MessageFlags,
  UserSelectMenuBuilder,
} = require('discord.js');
const { activeChannels } = require('./store');  // single import, no pendingCreation
const { finalizeChannel } = require('./voiceHandler');
const { LANGUAGES } = require('./config');

const EPH = { flags: MessageFlags.Ephemeral };

async function handleInteraction(client, interaction) {
  try {

    // ── Language Select (posted in VC text chat) ────────────────────────────
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('select_language_')) {
      const channelId = interaction.customId.replace('select_language_', '');
      const languageCode = interaction.values[0];
      const userId = interaction.user.id;

      // Look up entirely from activeChannels — no pendingCreation needed
      const data = activeChannels.get(channelId);

      if (!data) {
        return interaction.reply({ content: '❌ This selection already expired.', ...EPH });
      }

      if (data.finalized) {
        return interaction.reply({ content: '❌ Language was already picked.', ...EPH });
      }

      if (data.ownerId !== userId) {
        return interaction.reply({ content: '❌ Only the VC owner can pick the language.', ...EPH });
      }

      const guild = client.guilds.cache.get(data.guildId);
      const channel = guild?.channels.cache.get(channelId);
      const member = guild?.members.cache.get(userId) || await guild?.members.fetch(userId).catch(() => null);

      if (!channel || !member) {
        return interaction.reply({ content: '❌ Channel or member not found.', ...EPH });
      }

      // Ack immediately so Discord doesn't time out
      await interaction.reply({ content: '✅ Setting up your VC...', ...EPH });

      // finalizeChannel no longer needs promptMsg or timeout passed in —
      // it reads them from the store via channel.id
      await finalizeChannel(client, member, guild, channel, languageCode);
      return;
    }

    // ── Buttons (in VC text chat) ───────────────────────────────────────────
    if (interaction.isButton()) {
      const parts = interaction.customId.split('_');
      const action = parts[1];
      const channelId = parts[2];

      const data = activeChannels.get(channelId);

      if (!data) {
        return interaction.reply({ content: '❌ This VC no longer exists.', ...EPH });
      }

      if (!data.finalized) {
        return interaction.reply({ content: '❌ VC setup is not complete yet.', ...EPH });
      }

      if (data.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Only the VC owner can use these buttons.', ...EPH });
      }

      const guild = client.guilds.cache.get(data.guildId);
      const guildChannel = guild?.channels.cache.get(channelId);  // fetched by ID, name doesn't matter

      if (!guildChannel) {
        return interaction.reply({ content: '❌ Channel not found.', ...EPH });
      }

      if (action === 'lock') {
        await guildChannel.permissionOverwrites.edit(guild.id, { Connect: false });
        data.locked = true;
        return interaction.reply({ content: '🔒 VC **locked**. No one new can join.', ...EPH });
      }

      if (action === 'unlock') {
        await guildChannel.permissionOverwrites.edit(guild.id, { Connect: true });
        data.locked = false;
        return interaction.reply({ content: '🔓 VC **unlocked**. Everyone can join.', ...EPH });
      }

      if (action === 'rename') {
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

    // ── User Select (kick) ──────────────────────────────────────────────────
    if (interaction.isUserSelectMenu() && interaction.customId.startsWith('userselect_kick_')) {
      const channelId = interaction.customId.replace('userselect_kick_', '');
      const data = activeChannels.get(channelId);

      if (!data || data.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Not authorized.', ...EPH });
      }

      const guild = client.guilds.cache.get(data.guildId);
      const targetId = interaction.values[0];
      const targetMember = guild?.members.cache.get(targetId) || await guild?.members.fetch(targetId).catch(() => null);

      if (!targetMember) return interaction.reply({ content: '❌ User not found.', ...EPH });
      if (targetId === interaction.user.id) return interaction.reply({ content: "❌ You can't kick yourself.", ...EPH });

      const voiceState = guild.voiceStates.cache.get(targetId);
      if (voiceState?.channelId !== channelId) {
        return interaction.reply({ content: '❌ That user is not in your VC.', ...EPH });
      }

      await targetMember.voice.disconnect();
      const guildChannel = guild.channels.cache.get(channelId);
      await guildChannel.permissionOverwrites.edit(targetId, { Connect: false });
      setTimeout(() => guildChannel.permissionOverwrites.delete(targetId).catch(() => {}), 60_000);

      return interaction.update({
        content: `👢 Kicked **${targetMember.displayName}** from your VC (blocked for 60s).`,
        components: [],
      });
    }

    // ── Modals ──────────────────────────────────────────────────────────────
    if (interaction.isModalSubmit()) {
      const parts = interaction.customId.split('_');
      const type = parts[1];
      const channelId = parts[2];

      const data = activeChannels.get(channelId);
      if (!data || data.ownerId !== interaction.user.id) {
        return interaction.reply({ content: '❌ Not authorized.', ...EPH });
      }

      const guild = client.guilds.cache.get(data.guildId);
      const guildChannel = guild?.channels.cache.get(channelId);  // ID lookup, always works post-rename
      if (!guildChannel) return interaction.reply({ content: '❌ Channel no longer exists.', ...EPH });

      if (type === 'rename') {
        const rawName = interaction.fields.getTextInputValue('new_name').trim();
        const lang = LANGUAGES.find((l) => l.code === data.language);
        const newName = `${lang.prefix} ${rawName}`;
        await guildChannel.setName(newName);
        // No store update needed — we track by ID, name is just cosmetic
        return interaction.reply({ content: `✅ Renamed to **${newName}**`, ...EPH });
      }

      if (type === 'limit') {
        const limit = parseInt(interaction.fields.getTextInputValue('user_limit').trim());
        if (isNaN(limit) || limit < 0 || limit > 99) {
          return interaction.reply({ content: '❌ Invalid number. Enter 0–99.', ...EPH });
        }
        await guildChannel.setUserLimit(limit);
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
