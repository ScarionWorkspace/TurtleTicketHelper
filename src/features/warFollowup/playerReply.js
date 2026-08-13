'use strict';

const workflow = require('./workflow');
const service = require('./service');
const { isPlayerReplyCaptureEnabled, warFollowupStateStore } = require('./stateStore');
const { resolveConfiguredChannel } = require('./dashboard');

const DISCORD_USER_ID_PATTERN = /^\d{17,20}$/;
const MAX_RESPONSE_LENGTH = 2000;

function text(value) {
    return value == null ? '' : String(value);
}

function cleanInline(value, maxLength = 120) {
    return text(value)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanMessage(value, maxLength = 700) {
    return text(value)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, maxLength);
}

function conversationExcerpt(caseValue) {
    const messages = Array.isArray(caseValue?.conversation) ? caseValue.conversation.slice(-4) : [];
    if (!messages.length) return `**Player replied**\n${cleanMessage(caseValue?.playerResponse, 1200)}`;
    return messages.map(message => {
        const staff = message?.direction === 'staff';
        const label = staff ? `Sent by ${cleanInline(message?.actor || 'Staff')}` : 'Player replied';
        const when = workflow.formatDate(message?.at);
        return `**${label}${when ? ` · ${when}` : ''}**\n${cleanMessage(message?.text)}`;
    }).join('\n\n').slice(0, 3000);
}

function responseText(message) {
    const content = text(message?.content).trim();
    const attachments = message?.attachments?.values
        ? Array.from(message.attachments.values())
            .map(attachment => cleanInline(attachment?.name || 'attachment', 160))
            .filter(Boolean)
        : [];
    const attachmentNote = attachments.length
        ? `[Player sent ${attachments.length === 1 ? 'an attachment' : `${attachments.length} attachments`}: ${attachments.join(', ')}]`
        : '';
    return [content, attachmentNote].filter(Boolean).join('\n\n').slice(0, MAX_RESPONSE_LENGTH);
}

function isDirectMessage(message) {
    return Boolean(message && !message.guildId && message.author?.bot !== true);
}

function matchingCases(workspace, discordId, referencedMessageId = '') {
    const nowMs = Date.now();
    const referencedId = text(referencedMessageId).trim();
    const candidates = (workspace?.work?.items || [])
        .filter(item => {
            const itemId = text(item?.player?.discordId || item?.case?.discordId).trim();
            const exactReply = Boolean(referencedId && text(item.case?.dmMessageId).trim() === referencedId);
            const captureWindowOpen = workflow.parseMs(item.case?.replyCaptureUntil) >= nowMs;
            const captureState = item.status === 'waiting' || (item.status === 'needs_review' && (captureWindowOpen || exactReply));
            return itemId === discordId &&
                captureState &&
                item.case?.contactPurpose === 'general' &&
                item.case?.dmDeliveryMode === 'bot' &&
                DISCORD_USER_ID_PATTERN.test(text(item.case?.dmMessageId).trim()) &&
                workflow.parseMs(item.case?.dmSentAt) > 0;
        })
        .sort((left, right) => workflow.parseMs(right.case?.dmSentAt) - workflow.parseMs(left.case?.dmSentAt));
    return referencedId
        ? candidates.filter(item => text(item.case?.dmMessageId).trim() === referencedId)
        : candidates;
}

function notificationDestinations(preference) {
    const mode = text(preference?.notificationMode).trim().toLowerCase();
    if (mode === 'dm') return ['dm'];
    if (mode === 'both') return ['channel', 'dm'];
    return ['channel'];
}

function normalizeDisplayName(value) {
    return text(value).replace(/\s+/g, ' ').trim().toLocaleLowerCase('en');
}

function legacyDmSenderId(item, guildRecord) {
    const explicitId = text(item.case?.dmSentByDiscordId).trim();
    if (DISCORD_USER_ID_PATTERN.test(explicitId)) return explicitId;
    const activity = Array.isArray(item.case?.activity) ? item.case.activity : [];
    const dmActivity = [...activity].reverse().find(entry => entry?.type === 'dm_sent');
    const senderName = normalizeDisplayName(item.case?.dmSentByName || dmActivity?.actor);
    if (!senderName) return '';
    const matches = Object.values(guildRecord?.moderators || {}).filter(moderator =>
        DISCORD_USER_ID_PATTERN.test(text(moderator?.discordId).trim()) &&
        normalizeDisplayName(moderator?.displayName) === senderName
    );
    return matches.length === 1 ? text(matches[0].discordId).trim() : '';
}

function replyNotificationPlan(item, guildRecord) {
    const plans = new Map();
    const ownerId = text(item.case?.assignedModeratorId).trim();
    const senderId = legacyDmSenderId(item, guildRecord);
    if (DISCORD_USER_ID_PATTERN.test(ownerId)) {
        const preference = guildRecord?.moderators?.[ownerId] || {};
        for (const destination of notificationDestinations(preference)) {
            plans.set(`${ownerId}:${destination}`, { recipientId: ownerId, destination, role: 'owner' });
        }
    } else {
        plans.set('leadership:channel', { recipientId: '', destination: 'channel', role: 'leadership' });
    }
    if (DISCORD_USER_ID_PATTERN.test(senderId)) {
        plans.set(`${senderId}:dm`, { recipientId: senderId, destination: 'dm', role: 'sender' });
    }
    return Array.from(plans.values());
}

function responseNotification(item, plan, staffRoleId) {
    const caseValue = item.case || {};
    const recipientId = text(plan?.recipientId).trim();
    const hasRecipient = DISCORD_USER_ID_PATTERN.test(recipientId);
    const destination = plan?.destination === 'dm' ? 'dm' : 'channel';
    const name = cleanInline(item.player?.name || caseValue.name || item.tag);
    const tag = workflow.normalizeTag(item.tag);
    const mention = hasRecipient ? `<@${recipientId}>` : (DISCORD_USER_ID_PATTERN.test(staffRoleId) ? `<@&${staffRoleId}>` : '');
    const replyContext = plan?.role === 'sender'
        ? 'The player replied to a contact DM you sent.'
        : 'The player replied to the contact DM.';
    const privateDescription = [
        `**${name}** · \`${tag}\``,
        replyContext,
        '',
        '**Recent conversation**',
        conversationExcerpt(caseValue),
        '',
        'Open War Follow Up to review and decide how to proceed.'
    ].join('\n');
    const publicDescription = [
        `**${name}** · \`${tag}\``,
        'The player replied to the contact DM. Open War Follow Up to read the private response and review it.'
    ].join('\n');
    return {
        content: mention,
        embeds: [{
            color: 0x5865f2,
            title: 'Player response received',
            description: destination === 'dm' ? privateDescription : publicDescription,
            timestamp: caseValue.playerResponseAt || undefined,
            footer: { text: 'No automatic decision was made.' }
        }],
        allowedMentions: destination === 'channel'
            ? {
                users: hasRecipient ? [recipientId] : [],
                roles: !hasRecipient && DISCORD_USER_ID_PATTERN.test(staffRoleId) ? [staffRoleId] : []
            }
            : { parse: [] },
    };
}

async function sendReplyNotification(client, guildState, item, message, plan) {
    const guildId = guildState.guildId;
    const record = warFollowupStateStore.getGuild(guildId);
    const recipientKey = text(plan?.recipientId).trim() || 'leadership';
    const destination = plan?.destination === 'dm' ? 'dm' : 'channel';
    const key = `player-response:${guildId}:${text(message.id).trim()}:${recipientKey}:${destination}`;
    if (warFollowupStateStore.hasDelivery(guildId, key)) return false;
    warFollowupStateStore.recordDeliveries(guildId, key, { disposition: 'player-response-pending' });
    try {
        const payload = responseNotification(item, plan, record.config.staffRoleId);
        if (destination === 'dm') {
            const moderatorId = text(plan?.recipientId).trim();
            if (!DISCORD_USER_ID_PATTERN.test(moderatorId)) throw new Error('The response notification has no reachable moderator.');
            const moderator = await client.users.fetch(moderatorId);
            if (!moderator || typeof moderator.send !== 'function') throw new Error('The assigned moderator could not be reached by DM.');
            await moderator.send(payload);
        } else {
            const channel = await resolveConfiguredChannel(client, guildId, record.config.channelId);
            await channel.send(payload);
        }
        warFollowupStateStore.recordDeliveries(guildId, key, { disposition: 'sent' });
        return true;
    } catch (error) {
        warFollowupStateStore.removeDeliveries(guildId, key);
        throw error;
    }
}

async function handleWarFollowupPlayerReply(message, client) {
    if (!isDirectMessage(message)) return { handled: false, captured: false };
    const discordId = text(message.author?.id).trim();
    const reply = responseText(message);
    if (!DISCORD_USER_ID_PATTERN.test(discordId) || !reply) return { handled: true, captured: false };

    const guilds = warFollowupStateStore.listEnabledGuilds()
        .filter(guildState => isPlayerReplyCaptureEnabled(guildState.config));
    if (!guilds.length) return { handled: true, captured: false };

    let workspace;
    try {
        workspace = await service.loadWorkspace({ forcePrivate: true });
    } catch (error) {
        console.error('War Follow Up could not read cases for a player DM reply:', error?.message || String(error));
        return { handled: true, captured: false };
    }

    let captured = false;
    for (const guildState of guilds) {
        const candidates = matchingCases(workspace, discordId, message.reference?.messageId);
        if (candidates.length !== 1) {
            if (candidates.length > 1) console.warn('War Follow Up received an ambiguous player DM reply:', { discordId, guildId: guildState.guildId });
            continue;
        }
        const item = candidates[0];
        try {
            const updated = await service.recordPlayerResponse(
                item,
                reply,
                message.id,
                {
                    seed: `player-response:${guildState.guildId}:${message.id}`,
                    responseToMessageId: message.reference?.messageId || ''
                }
            );
            captured = true;
            console.info('War Follow Up captured a player DM reply:', {
                guildId: guildState.guildId,
                discordId,
                tag: item.tag,
                messageId: text(message.id).trim()
            });
            const updatedItem = {
                ...item,
                status: updated?.status || item.status,
                case: updated || item.case
            };
            const freshGuildRecord = warFollowupStateStore.getGuild(guildState.guildId);
            const plans = replyNotificationPlan(updatedItem, freshGuildRecord);
            for (const plan of plans) {
                try {
                    await sendReplyNotification(client, guildState, updatedItem, message, plan);
                } catch (error) {
                    console.error('War Follow Up player response notification failed:', {
                        guildId: guildState.guildId,
                        destination: plan.destination,
                        recipientId: plan.recipientId || '',
                        error: error?.message || String(error)
                    });
                    if (plan.role === 'sender' && plan.destination === 'dm') {
                        try {
                            await sendReplyNotification(client, guildState, updatedItem, message, {
                                recipientId: plan.recipientId,
                                destination: 'channel',
                                role: 'sender-fallback'
                            });
                        } catch (fallbackError) {
                            console.error('War Follow Up player response sender fallback failed:', {
                                guildId: guildState.guildId,
                                recipientId: plan.recipientId,
                                error: fallbackError?.message || String(fallbackError)
                            });
                        }
                    }
                }
            }
            break;
        } catch (error) {
            if (!/not currently awaiting|changed since it was opened|mutation ID was already used/i.test(String(error?.message || error))) {
                console.error('War Follow Up could not record a player DM reply:', error?.message || String(error));
            }
        }
    }

    if (captured && typeof message.channel?.send === 'function') {
        await message.channel.send({
            content: 'Thanks — your response was forwarded to the moderation team.',
            allowedMentions: { parse: [] }
        }).catch(error => console.error('War Follow Up could not acknowledge a player DM reply:', error?.message || String(error)));
    }
    return { handled: true, captured };
}

module.exports = {
    handleWarFollowupPlayerReply,
    responseText,
    matchingCases,
    legacyDmSenderId,
    replyNotificationPlan
};
