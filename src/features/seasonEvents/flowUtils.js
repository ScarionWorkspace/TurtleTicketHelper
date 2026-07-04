const { buildInteractionSource } = require('./interactionSource');
const {
    getEventId,
    loadEventForRendering,
    resolveCurrentSeasonEvent
} = require('./eventData');
const { buildSignupMessage } = require('./renderSignupMessage');
const { normalizeResponseStatus } = require('./statusMessages');

const EPHEMERAL = 64;

function getResultStatus(result, fallback = null) {
    return normalizeResponseStatus(
        result?.status ||
        result?.code ||
        result?.errorCode ||
        result?.reason ||
        fallback
    );
}

function buildDiscordUser(interaction) {
    return {
        id: interaction.user?.id || null,
        username: interaction.user?.username || null,
        globalName: interaction.user?.globalName || null,
        displayName:
            interaction.member?.displayName ||
            interaction.user?.globalName ||
            interaction.user?.username ||
            null
    };
}

function getSourceMessageId(interaction, parsed = null) {
    return parsed?.messageId || interaction.message?.id || null;
}

async function getSourceMessage(interaction, messageId) {
    if (messageId && interaction.channel?.messages?.fetch) {
        const fetched = await interaction.channel.messages.fetch(messageId).catch(() => null);

        if (fetched) {
            return fetched;
        }
    }

    return typeof interaction.message?.edit === 'function'
        ? interaction.message
        : null;
}

async function refreshSignupMessage(interaction, type, options = {}) {
    const messageId = options.messageId || interaction.message?.id || null;
    const source = buildInteractionSource(
        interaction,
        type,
        messageId,
        options.sourceType || 'discord-refresh'
    );
    const { event, leaderboard } = await loadEventForRendering(type, {
        reconcile: options.reconcile === true && type !== 'cwl',
        ensureCurrent: type === 'cwl' && options.ensureCurrent === true,
        source
    });
    const message = await getSourceMessage(interaction, messageId);

    if (!message) {
        return false;
    }

    await message.edit(buildSignupMessage(type, event, leaderboard));
    return true;
}

async function resolveEventForMutation(
    interaction,
    type,
    messageId,
    sourceType = 'discord-button'
) {
    const source = buildInteractionSource(interaction, type, messageId, sourceType);
    const event = await resolveCurrentSeasonEvent(type, { source });

    return {
        event,
        eventId: getEventId(event),
        source
    };
}

module.exports = {
    EPHEMERAL,
    buildDiscordUser,
    getResultStatus,
    getSourceMessageId,
    refreshSignupMessage,
    resolveEventForMutation
};
