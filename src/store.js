/**
 * activeChannels: channelId → {
 *   ownerId,
 *   guildId,
 *   language,      // null until finalized
 *   locked,
 *   finalized,     // false = still in language-pick limbo
 *   timeoutRef,    // the 60s cleanup timer (cleared on finalize)
 *   promptMsgId,   // id of the language-prompt message (so we can delete it)
 * }
 *
 * Everything is keyed by channelId. No secondary maps for lookup.
 * pendingCreation is gone — state lives here.
 */
const activeChannels = new Map();

module.exports = { activeChannels };
