'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { buildCustomId } = require('./customIds');
const views = require('./views');
const { warFollowupStateStore } = require('./stateStore');

const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;
const DISPLAY_NAME_TOKEN_PATTERN = /\{\{wfu-user:(\d{17,20})\}\}/g;
const DISPLAY_NAME_FETCH_CONCURRENCY = 4;
// The shortest token is 30 characters, so replacements can never push an
// already validated planner embed beyond Discord's per-field limits.
const MAX_EMBED_DISPLAY_NAME_LENGTH = 30;

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
    const opensFollowup = [
        'case-alert',
        'case-assignment',
        'case-inactivity-reminder',
        'case-unassigned',
        'case-escalation'
    ].includes(notification.kind) && notification.destination !== 'dm';
    const components = opensFollowup || notification.kind === 'missing-discord-digest'
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

function safeEmbedDisplayName(value, fallback = 'Unknown player') {
    const selected = String(value || fallback)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\s+/g, ' ')
        .trim() || fallback;
    return selected.length > MAX_EMBED_DISPLAY_NAME_LENGTH
        ? `${selected.slice(0, MAX_EMBED_DISPLAY_NAME_LENGTH - 1)}…`
        : selected;
}

function getNotificationDisplayIds(notification) {
    return Array.from(new Set(
        Object.keys(notification?.displayNameFallbacks || {})
            .filter(discordId => DISCORD_USER_ID_PATTERN.test(discordId))
    ));
}

async function mapWithConcurrency(items, mapper) {
    const values = Array.isArray(items) ? items : [];
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < values.length) {
            const index = nextIndex;
            nextIndex += 1;
            await mapper(values[index]);
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(DISPLAY_NAME_FETCH_CONCURRENCY, values.length) },
        () => worker()
    ));
}

async function resolveNotificationDisplayNames(channel, notification) {
    const fallbacks = notification?.displayNameFallbacks || {};
    const displayNames = Object.fromEntries(
        getNotificationDisplayIds(notification).map(discordId => [
            discordId,
            safeEmbedDisplayName(fallbacks[discordId], 'Linked player')
        ])
    );
    const guild = channel?.guild;
    if (!guild?.members || typeof guild.members.fetch !== 'function') return displayNames;

    await mapWithConcurrency(Object.keys(displayNames), async discordId => {
        try {
            // Force a per-delivery refresh: cached guild members are exactly what made
            // display names stale in these follow-up messages.
            const member = await guild.members.fetch({
                user: discordId,
                cache: false,
                force: true
            });
            displayNames[discordId] = safeEmbedDisplayName(
                member?.displayName || member?.user?.globalName || member?.user?.username,
                displayNames[discordId]
            );
        } catch {
            // A member may have left the guild or Discord may be temporarily unavailable.
            // The roster name remains a clean, non-mention fallback in that case.
        }
    });

    return displayNames;
}

function replaceDisplayNameTokens(value, displayNames) {
    return typeof value === 'string'
        ? value.replace(DISPLAY_NAME_TOKEN_PATTERN, (token, discordId) => displayNames[discordId] || 'Linked player')
        : value;
}

function hydrateNotificationEmbed(embed, displayNames) {
    if (!embed || typeof embed !== 'object') return embed;
    return {
        ...embed,
        title: replaceDisplayNameTokens(embed.title, displayNames),
        description: replaceDisplayNameTokens(embed.description, displayNames),
        footer: embed.footer && typeof embed.footer === 'object'
            ? { ...embed.footer, text: replaceDisplayNameTokens(embed.footer.text, displayNames) }
            : embed.footer,
        fields: Array.isArray(embed.fields)
            ? embed.fields.map(field => ({
                ...field,
                name: replaceDisplayNameTokens(field.name, displayNames),
                value: replaceDisplayNameTokens(field.value, displayNames)
            }))
            : embed.fields
    };
}

async function hydrateNotificationForDelivery(channel, notification) {
    const displayNames = await resolveNotificationDisplayNames(channel, notification);
    return {
        ...notification,
        embeds: (notification?.embeds || []).map(embed => hydrateNotificationEmbed(embed, displayNames))
    };
}

async function sendPlannedNotification(channel, notification) {
    const hydratedNotification = await hydrateNotificationForDelivery(channel, notification);
    return channel.send(buildNotificationPayload(hydratedNotification));
}

async function sendPlannedDirectNotification(client, guild, notification) {
    const recipientUserId = String(notification?.recipientUserId || '').trim();
    if (!DISCORD_USER_ID_PATTERN.test(recipientUserId)) {
        throw new Error('A valid assignment notification recipient is required.');
    }
    const user = await client?.users?.fetch?.(recipientUserId);
    if (!user || typeof user.send !== 'function') {
        throw new Error('The assigned moderator could not be reached by DM.');
    }
    const hydratedNotification = await hydrateNotificationForDelivery({ guild }, notification);
    return user.send(buildNotificationPayload(hydratedNotification));
}

module.exports = {
    isSendableChannel,
    resolveConfiguredChannel,
    ensureDashboard,
    retireDashboard,
    buildNotificationPayload,
    safeEmbedDisplayName,
    resolveNotificationDisplayNames,
    hydrateNotificationForDelivery,
    sendPlannedNotification,
    sendPlannedDirectNotification
};
