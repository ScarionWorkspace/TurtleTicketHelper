const { ChannelType } = require('discord.js');
const { isSeasonEventAdmin } = require('./permissions');
const { loadEventForRendering } = require('./eventData');
const { buildSignupMessage } = require('./renderSignupMessage');
const { getEventTypeConfig, normalizeEventType } = require('./constants');
const { buildInteractionSource } = require('./interactionSource');

async function sendSeasonEventSignupMessage(interaction, type) {
    const eventType = normalizeEventType(type);
    const typeConfig = getEventTypeConfig(eventType);

    if (!eventType || !typeConfig) {
        await interaction.reply({
            content: 'Unknown season event type.',
            flags: 64
        });
        return;
    }

    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This command is staff only.',
            flags: 64
        });
        return;
    }

    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || typeof channel.send !== 'function') {
        await interaction.reply({
            content: 'Use this command in the text channel where the signup message should be posted.',
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });

    const source = buildInteractionSource(interaction, eventType, null, 'discord-admin');
    const { event, leaderboard } = await loadEventForRendering(eventType, {
        reconcile: eventType !== 'cwl',
        ensureCurrent: eventType === 'cwl',
        source
    });

    if (!event) {
        await interaction.editReply({
            content: `No current ${typeConfig.title} record was found after reconciliation.`
        });
        return;
    }

    const message = await channel.send(buildSignupMessage(eventType, event, leaderboard));

    await interaction.editReply({
        content: `${typeConfig.title} signup message sent: ${message.url}`
    });
}

module.exports = {
    sendSeasonEventSignupMessage
};
