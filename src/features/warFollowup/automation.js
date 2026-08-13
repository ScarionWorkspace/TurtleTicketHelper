'use strict';

const service = require('./service');
const workflow = require('./workflow');
const { replaceCase } = require('./moderation');
const { CONTACT_REMINDER_TEXT, prepareContactMessage } = require('./contactMessages');

const MAX_PLAYER_DMS_PER_TICK = 4;

function text(value) {
    return value == null ? '' : String(value);
}

function moderatorSyncKey(preference) {
    return `moderator-directory:${text(preference?.discordId).trim()}:${workflow.stableRevision(JSON.stringify({
        displayName: preference?.displayName || '',
        clanTags: preference?.clanTags || [],
        notificationMode: preference?.notificationMode || 'channel',
        accepting: preference?.accepting === true,
        updatedAt: preference?.updatedAt || ''
    }))}`;
}

async function syncModeratorDirectory(guildId, store) {
    const record = store.getGuild(guildId);
    const results = [];
    for (const preference of Object.values(record.moderators || {})) {
        const key = moderatorSyncKey(preference);
        if (store.hasDelivery(guildId, key)) continue;
        try {
            await service.syncModeratorPreference(guildId, preference);
            store.recordDeliveries(guildId, key, { disposition: 'moderator-synced' });
            results.push({ discordId: preference.discordId, synced: true });
        } catch (error) {
            results.push({ discordId: preference.discordId, synced: false, error });
        }
    }
    return results;
}

async function sendPlayerDm(client, discordIdRaw, content) {
    const discordId = text(discordIdRaw).trim();
    if (!/^\d{17,20}$/.test(discordId)) throw new Error('This player has no linked Discord account.');
    const user = await client.users.fetch(discordId);
    if (!user || typeof user.send !== 'function') throw new Error('The linked Discord user could not be reached.');
    return user.send({ content, allowedMentions: { parse: [] } });
}

function deliveryState(store, guildId, key) {
    return typeof store.getDelivery === 'function'
        ? store.getDelivery(guildId, key)
        : store.getGuild(guildId)?.deliveries?.[key] || null;
}

async function mutateAndReplace(workspace, item, action, patch, seed, actor = 'War Follow Up') {
    const updated = await service.mutateCase(item, action, patch, { actor, seed });
    replaceCase(workspace, updated);
    return workspace.work.items.find(candidate => candidate.tag === item.tag) || null;
}

async function processQueuedDiscordDms(client, guildId, workspace, store, config) {
    const queued = (workspace?.work?.items || [])
        .filter(item => item.status === 'needs_dm' && text(item.case?.dmQueueId).trim())
        .slice(0, MAX_PLAYER_DMS_PER_TICK);
    const results = [];

    for (const originalItem of queued) {
        let item = workspace.work.items.find(candidate => candidate.tag === originalItem.tag) || originalItem;
        const queueId = text(item.case?.dmQueueId).trim();
        const key = `queued-player-dm:${guildId}:${item.tag}:${queueId}`;
        let delivery = deliveryState(store, guildId, key);
        try {
            if (config?.features?.directMessages !== true) {
                item = await mutateAndReplace(workspace, item, 'dm_delivery_failed', {
                    dmQueueId: queueId,
                    dmDeliveryFailureReason: 'Discord direct messages are currently disabled for this server.'
                }, `scheduler:queued-dm-disabled:${item.tag}:${queueId}`);
                results.push({ tag: item.tag, action: 'dm_delivery_failed' });
                continue;
            }
            if (!delivery) {
                store.recordDeliveries(guildId, key, { disposition: 'queued-dm-pending' });
                try {
                    const message = prepareContactMessage(item.case?.dmText, item.case?.contactPurpose);
                    const sent = await sendPlayerDm(client, item.player?.discordId || item.case?.discordId, message);
                    store.recordDeliveries(guildId, key, {
                        disposition: 'queued-dm-sent',
                        messageId: sent?.id
                    });
                    delivery = deliveryState(store, guildId, key);
                    item.case.dmText = message;
                } catch (error) {
                    store.recordDeliveries(guildId, key, { disposition: 'queued-dm-failed' });
                    delivery = deliveryState(store, guildId, key);
                }
            }
            if (delivery?.disposition === 'queued-dm-failed' || !delivery?.messageId) {
                const failureReason = delivery?.disposition === 'queued-dm-pending'
                    ? 'Discord delivery could not be confirmed after an interrupted attempt. Check with the player before retrying.'
                    : 'Discord could not deliver the queued message.';
                item = await mutateAndReplace(workspace, item, 'dm_delivery_failed', {
                    dmQueueId: queueId,
                    dmDeliveryFailureReason: failureReason
                }, `scheduler:queued-dm-failed:${item.tag}:${queueId}`);
                results.push({ tag: item.tag, action: 'dm_delivery_failed' });
                continue;
            }
            item = await mutateAndReplace(workspace, item, 'mark_dm_sent', {
                dmQueueId: queueId,
                dmText: prepareContactMessage(item.case?.dmText, item.case?.contactPurpose),
                dmDeliveryMode: 'bot',
                dmMessageId: delivery.messageId,
                dmSentByDiscordId: item.case?.dmQueuedByDiscordId || '',
                dmSentByName: item.case?.dmQueuedByName || 'Website moderator'
            }, `scheduler:queued-dm-commit:${item.tag}:${queueId}`, item.case?.dmQueuedByName || 'Website moderator');
            results.push({ tag: item.tag, action: 'mark_dm_sent' });
        } catch (error) {
            results.push({ tag: item.tag, action: 'error', error });
        }
    }
    return results;
}

function isDue(item, nowMs) {
    const dueMs = workflow.parseMs(item?.case?.waitingUntil);
    return item?.status === 'waiting' && dueMs > 0 && dueMs <= nowMs;
}

function isBotManagedContact(item) {
    return Boolean(
        item?.case?.contactPurpose === 'general' &&
        item.case?.dmDeliveryMode === 'bot' &&
        item.case?.dmMessageId
    );
}

async function processContactAutomations(client, guildId, workspace, store, config, nowRaw = new Date()) {
    const now = nowRaw instanceof Date ? nowRaw : new Date(nowRaw);
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const dueItems = (workspace?.work?.items || []).filter(item => isDue(item, nowMs) && isBotManagedContact(item));
    const results = [];
    let sentCount = 0;

    for (const originalItem of dueItems) {
        let item = workspace.work.items.find(candidate => candidate.tag === originalItem.tag) || originalItem;
        try {
            if (item.case?.contactReminderSentAt || item.case?.contactAutomaticReminderAllowed === false) {
                const responseAnchor = item.case?.contactReminderSentAt || item.case?.dmMessageId || item.case?.dmSentAt;
                item = await mutateAndReplace(
                    workspace,
                    item,
                    'contact_no_response',
                    {},
                    `scheduler:contact-no-response:${item.tag}:${responseAnchor}`
                );
                results.push({ tag: item.tag, action: 'contact_no_response' });
                continue;
            }
            const key = `contact-reminder:${guildId}:${item.tag}:${item.case?.dmMessageId}`;
            let delivery = deliveryState(store, guildId, key);
            if (config?.features?.directMessages !== true || config?.features?.playerReplies !== true) {
                store.recordDeliveries(guildId, key, { disposition: 'contact-reminder-failed' });
                delivery = deliveryState(store, guildId, key);
            } else if (!delivery && sentCount < MAX_PLAYER_DMS_PER_TICK) {
                store.recordDeliveries(guildId, key, { disposition: 'contact-reminder-pending' });
                try {
                    const sent = await sendPlayerDm(
                        client,
                        item.player?.discordId || item.case?.discordId,
                        CONTACT_REMINDER_TEXT
                    );
                    store.recordDeliveries(guildId, key, {
                        disposition: 'contact-reminder-sent',
                        messageId: sent?.id
                    });
                    sentCount += 1;
                } catch (error) {
                    store.recordDeliveries(guildId, key, { disposition: 'contact-reminder-failed' });
                }
                delivery = deliveryState(store, guildId, key);
            }
            if (!delivery) continue;
            if (delivery.disposition === 'contact-reminder-failed' || !delivery.messageId) {
                const interrupted = delivery.disposition === 'contact-reminder-pending';
                item = await mutateAndReplace(workspace, item, 'contact_reminder_failed', {
                    contactReminderFailureReason: config?.features?.directMessages !== true
                        ? 'Automatic Discord reminders are disabled for this server.'
                        : (interrupted
                            ? 'Reminder delivery could not be confirmed after an interrupted attempt. Do not resend automatically.'
                            : 'Discord could not deliver the automatic reminder.')
                }, `scheduler:contact-reminder-failed:${item.tag}:${item.case?.dmMessageId}`);
                results.push({ tag: item.tag, action: 'contact_reminder_failed' });
                continue;
            }
            item = await mutateAndReplace(workspace, item, 'contact_reminder_sent', {
                contactReminderText: CONTACT_REMINDER_TEXT,
                contactReminderMessageId: delivery.messageId
            }, `scheduler:contact-reminder-sent:${item.tag}:${item.case?.dmMessageId}`);
            results.push({ tag: item.tag, action: 'contact_reminder_sent' });
        } catch (error) {
            results.push({ tag: item.tag, action: 'error', error });
        }
    }
    return results;
}

module.exports = {
    MAX_PLAYER_DMS_PER_TICK,
    moderatorSyncKey,
    syncModeratorDirectory,
    sendPlayerDm,
    processQueuedDiscordDms,
    isBotManagedContact,
    processContactAutomations
};
