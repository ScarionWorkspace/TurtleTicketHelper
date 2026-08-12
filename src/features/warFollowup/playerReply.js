'use strict';

const workflow = require('./workflow');
const service = require('./service');
const { warFollowupStateStore } = require('./stateStore');
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

function matchingCases(workspace, discordId) {
    return (workspace?.work?.items || [])
        .filter(item => {
            const itemId = text(item?.player?.discordId || item?.case?.discordId).trim();
            return itemId === discordId &&
                item.status === 'waiting' &&
                item.case?.contactPurpose === 'general' &&
                workflow.parseMs(item.case?.dmSentAt) > 0;
        })
        .sort((left, right) => workflow.parseMs(right.case?.dmSentAt) - workflow.parseMs(left.case?.dmSentAt));
}

function notificationDestinations(preference, hasOwner) {
    if (!hasOwner) return ['channel'];
    const mode = text(preference?.notificationMode).trim().toLowerCase();
    if (mode === 'dm') return ['dm'];
    if (mode === 'both') return ['channel', 'dm'];
    return ['channel'];
}

function responseNotification(item, guildRecord, destination, staffRoleId) {
    const caseValue = item.case || {};
    const moderatorId = text(caseValue.assignedModeratorId).trim();
    const owner = DISCORD_USER_ID_PATTERN.test(moderatorId);
    const preference = guildRecord?.moderators?.[moderatorId] || {};
    const response = text(caseValue.playerResponse).trim();
    const name = cleanInline(item.player?.name || caseValue.name || item.tag);
    const tag = workflow.normalizeTag(item.tag);
    const mention = owner ? `<@${moderatorId}>` : (DISCORD_USER_ID_PATTERN.test(staffRoleId) ? `<@&${staffRoleId}>` : '');
    const privateDescription = [
        `**${name}** · \`${tag}\``,
        'The player replied to the contact DM.',
        '',
        `**Player response:**\n${response}`,
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
                users: owner ? [moderatorId] : [],
                roles: !owner && DISCORD_USER_ID_PATTERN.test(staffRoleId) ? [staffRoleId] : []
            }
            : { parse: [] },
        preference
    };
}

async function sendReplyNotification(client, guildState, item, message, destination) {
    const guildId = guildState.guildId;
    const record = warFollowupStateStore.getGuild(guildId);
    const moderatorId = text(item.case?.assignedModeratorId).trim();
    const key = `player-response:${guildId}:${text(message.id).trim()}:${destination}`;
    if (warFollowupStateStore.hasDelivery(guildId, key)) return false;
    warFollowupStateStore.recordDeliveries(guildId, key, { disposition: 'player-response-pending' });
    try {
        const payload = responseNotification(item, record, destination, record.config.staffRoleId);
        if (destination === 'dm') {
            if (!DISCORD_USER_ID_PATTERN.test(moderatorId)) throw new Error('The response case has no reachable moderator.');
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
        .filter(guildState => guildState.config?.features?.playerReplies === true);
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
        const candidates = matchingCases(workspace, discordId);
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
                { seed: `player-response:${guildState.guildId}:${message.id}` }
            );
            captured = true;
            const updatedItem = {
                ...item,
                status: updated?.status || item.status,
                case: updated || item.case
            };
            const destinations = notificationDestinations(
                guildState.moderators?.[updated?.assignedModeratorId || item.case?.assignedModeratorId],
                Boolean(updated?.assignedModeratorId || item.case?.assignedModeratorId)
            );
            for (const destination of destinations) {
                try {
                    await sendReplyNotification(client, guildState, updatedItem, message, destination);
                } catch (error) {
                    console.error('War Follow Up player response notification failed:', {
                        guildId: guildState.guildId,
                        destination,
                        error: error?.message || String(error)
                    });
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
    matchingCases
};
