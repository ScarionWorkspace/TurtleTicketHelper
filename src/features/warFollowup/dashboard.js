'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { buildCustomId } = require('./customIds');
const views = require('./views');
const { warFollowupStateStore } = require('./stateStore');

function isSendableChannel(channel) {
    return Boolean(
        channel &&
        typeof channel.send === 'function' &&
        channel.isTextBased?.() !== false &&
        !channel.isThread?.()
    );
}

async function resolveConfiguredChannel(client, guildId, channelId) {
    const cached = client?.channels?.cache?.get?.(channelId);
    const channel = cached || await client?.channels?.fetch?.(channelId).catch(() => null);
    if (!isSendableChannel(channel) || String(channel.guildId || '') !== String(guildId)) {
        throw new Error('The configured War Follow Up channel is missing or no longer writable.');
    }
    return channel;
}

async function fetchDashboardMessage(channel, messageId) {
    if (!messageId || !channel?.messages?.fetch) return null;
    try {
        return await channel.messages.fetch(messageId);
    } catch (error) {
        if (Number(error?.code) === 10008) return null;
        throw error;
    }
}

async function ensureDashboard(client, guildId, workspace, config, options = {}) {
    const channel = options.channel || await resolveConfiguredChannel(client, guildId, config.channelId);
    const store = options.store || warFollowupStateStore;
    const record = store.getGuild(guildId);
    const built = views.buildDashboardPayload(workspace, config);
    const recordedChannelId = record.dashboard.channelId || config.channelId;
    const dashboardMoved = Boolean(
        record.dashboard.messageId &&
        recordedChannelId &&
        recordedChannelId !== channel.id
    );
    let message = dashboardMoved
        ? null
        : await fetchDashboardMessage(channel, record.dashboard.messageId);
    const shouldEdit = options.force === true || record.dashboard.semanticHash !== built.semanticHash;

    if (message && shouldEdit) {
        message = await message.edit(built.payload);
    } else if (!message) {
        message = await channel.send(built.payload);
    }

    if (
        message &&
        (
            message.id !== record.dashboard.messageId ||
            channel.id !== record.dashboard.channelId ||
            record.dashboard.semanticHash !== built.semanticHash
        )
    ) {
        store.setDashboard(guildId, {
            channelId: channel.id,
            messageId: message.id,
            semanticHash: built.semanticHash
        });
    }

    return { channel, message, semanticHash: built.semanticHash };
}

async function retireDashboard(client, guildId, channelId, messageId, options = {}) {
    if (!channelId || !messageId) return false;
    try {
        const channel = await resolveConfiguredChannel(client, guildId, channelId);
        const message = await fetchDashboardMessage(channel, messageId);
        if (!message) return false;
        const destination = options.newChannelId ? ` The active dashboard is now in <#${options.newChannelId}>.` : '';
        await message.edit({
            content: '',
            embeds: [{
                color: 0x95a5a6,
                title: 'War Follow Up dashboard inactive',
                description: `${options.reason || 'The Discord integration was disabled.'}${destination}`
            }],
            components: [],
            allowedMentions: { parse: [] }
        });
        return true;
    } catch (error) {
        if (Number(error?.code) === 10008) return false;
        throw error;
    }
}

function buildNotificationPayload(notification) {
    const components = notification.kind === 'case-alert' || notification.kind === 'missing-discord-digest'
        ? [new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buildCustomId(notification.kind === 'missing-discord-digest' ? 'gaps' : 'home'))
                .setLabel(notification.kind === 'missing-discord-digest' ? 'Open Discord gaps' : 'Open follow-up queue')
                .setStyle(ButtonStyle.Primary)
        )]
        : [];
    return {
        content: notification.content || '',
        embeds: notification.embeds || [],
        components,
        allowedMentions: {
            parse: [],
            users: Array.from(new Set(notification.allowedUserIds || [])).slice(0, 100),
            roles: Array.from(new Set(notification.allowedRoleIds || [])).slice(0, 100),
            repliedUser: false
        }
    };
}

async function sendPlannedNotification(channel, notification) {
    return channel.send(buildNotificationPayload(notification));
}

module.exports = {
    isSendableChannel,
    resolveConfiguredChannel,
    ensureDashboard,
    retireDashboard,
    buildNotificationPayload,
    sendPlannedNotification
};
