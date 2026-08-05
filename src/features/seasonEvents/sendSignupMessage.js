const { ChannelType } = require('discord.js');
const { isSeasonEventAdmin } = require('./permissions');
const { loadEventForRendering } = require('./eventData');
const { buildSignupMessage } = require('./renderSignupMessage');
const { getEventTypeConfig, normalizeEventType } = require('./constants');
const { buildInteractionSource } = require('./interactionSource');

async function sendSeasonEventSignupMessage(interaction, type, options = {}) {
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
    const { event, leaderboard, rollover } = await loadEventForRendering(eventType, {
        rosterId: options.rosterId || null,
        forceNewEvent: options.forceNewEvent === true,
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

    const rosterTitle = event?.cwl?.target?.rosterTitle || event?.cwl?.target?.rosterId || '';
    const rolloverNotice = rollover?.supersededEventId
        ? ` The previous event was archived and a fresh event was started${rollover.forced ? ' by request' : ' automatically for the new CWL cycle'}.`
        : '';
    await interaction.editReply({
        content: `${typeConfig.title}${rosterTitle ? ` for ${rosterTitle}` : ''} signup message sent: ${message.url}${rolloverNotice}`
    });
}

module.exports = {
    sendSeasonEventSignupMessage
};
