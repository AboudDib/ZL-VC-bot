// Map of channelId -> { ownerId, language, guildId }
const activeChannels = new Map();

// Map of userId -> pending language selection (for users in limbo)
const pendingCreation = new Map();

module.exports = { activeChannels, pendingCreation };

