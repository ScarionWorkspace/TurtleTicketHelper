function buildInteractionSource(
    interaction,
    eventType,
    messageIdOverride = null,
    sourceType = 'discord-bot'
) {
    return {
        type: sourceType,
        eventType,
        guildId: interaction.guildId || null,
        channelId: interaction.channelId || interaction.channel?.id || null,
        messageId: messageIdOverride || interaction.message?.id || null,
        interactionId: interaction.id || null,
        userId: interaction.user?.id || null
    };
}

module.exports = {
    buildInteractionSource
};
