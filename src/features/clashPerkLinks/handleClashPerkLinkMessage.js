const appConfig = require('../../config/appConfig');
const {
    normalizePlayerTag,
    isValidPlayerTag
} = require('../joinClanApplication/fetchPlayerData');
const {
    syncDiscordIdentityForPlayerTag
} = require('../joinClanApplication/syncDiscordUsernameForPlayerTag');

const CLASHPERK_AUTHOR_NAME_PATTERN = /\bclash\s*perk\b/i;
const SUCCESSFUL_LINK_MARKER_PATTERN = /Successfully\s+linked/i;
const LINK_MESSAGE_PATTERN = /Successfully\s+linked\s+(.+?)\s+\((#[A-Z0-9]+)\)\s+to\s+(.+)$/i;
const DEFAULT_MEMBER_SEARCH_LIMIT = 1000;
const DEFAULT_FULL_MEMBER_FETCH_TIMEOUT_MS = 20_000;
const DEFAULT_MEMBER_LIST_PAGE_LIMIT = 1000;
const DEFAULT_MEMBER_LIST_MAX_PAGES = 100;
const HANDLED_MESSAGE_ID_LIMIT = 500;
const handledMessageIds = new Set();

function cleanClashPerkText(value) {
    let text = String(value || '').trim();

    while (text.startsWith('**') && text.endsWith('**') && text.length >= 4) {
        text = text.slice(2, -2).trim();
    }

    return text
        .replace(/^\*+|\*+$/g, '')
        .replace(/^`+|`+$/g, '')
        .replace(/\s+\.$/, '.')
        .replace(/\.$/, '')
        .trim();
}

function normalizeClashPerkText(value) {
    return String(value || '')
        .replace(/[\u200B-\u200D\u2060]/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')
        .replace(/[ \t]+/g, ' ')
        .trim();
}

function addTextCandidate(candidates, value) {
    const text = normalizeClashPerkText(value);

    if (!text) {
        return;
    }

    candidates.push(text);

    for (const line of text.split('\n')) {
        const normalizedLine = normalizeClashPerkText(line);

        if (normalizedLine && normalizedLine !== text) {
            candidates.push(normalizedLine);
        }
    }
}

function uniqueTextCandidates(candidates) {
    const seen = new Set();
    const unique = [];

    for (const candidate of candidates) {
        const normalized = normalizeClashPerkText(candidate);

        if (!normalized || seen.has(normalized)) {
            continue;
        }

        seen.add(normalized);
        unique.push(normalized);
    }

    return unique;
}

function getClashPerkMessageTextCandidates(message) {
    const candidates = [];

    addTextCandidate(candidates, message?.content);
    addTextCandidate(candidates, message?.cleanContent);
    addTextCandidate(candidates, message?.systemContent);

    for (const embed of message?.embeds || []) {
        addTextCandidate(candidates, embed?.title);
        addTextCandidate(candidates, embed?.description);
        addTextCandidate(candidates, embed?.footer?.text);
        addTextCandidate(candidates, embed?.author?.name);

        for (const field of embed?.fields || []) {
            addTextCandidate(candidates, field?.name);
            addTextCandidate(candidates, field?.value);
        }
    }

    return uniqueTextCandidates(candidates);
}

async function hydrateMessage(message) {
    if (!message?.partial || typeof message.fetch !== 'function') {
        return message;
    }

    try {
        return await message.fetch();
    } catch (error) {
        console.warn('Could not fetch partial ClashPerk candidate message:', {
            messageId: message?.id || null,
            channelId: message?.channel?.id || null,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });
        return message;
    }
}

function getMessageSourceIds(message) {
    return [
        message?.author?.id,
        message?.applicationId,
        message?.interaction?.applicationId,
        message?.interactionMetadata?.applicationId
    ].map(value => String(value || '').trim()).filter(Boolean);
}

function getMessageAuthorName(message) {
    return [
        message?.author?.username,
        message?.author?.globalName,
        message?.author?.displayName,
        message?.author?.tag
    ].filter(Boolean).join(' ');
}

function isAutomatedMessage(message) {
    return Boolean(
        message?.author?.bot === true ||
        message?.webhookId ||
        message?.applicationId ||
        message?.interaction?.applicationId ||
        message?.interactionMetadata?.applicationId
    );
}

function parseClashPerkLinkCandidate(candidateRaw) {
    const candidate = normalizeClashPerkText(candidateRaw);
    const markerMatch = SUCCESSFUL_LINK_MARKER_PATTERN.exec(candidate);

    if (!markerMatch) {
        return null;
    }

    const linkText = candidate.slice(markerMatch.index);
    const match = LINK_MESSAGE_PATTERN.exec(linkText);

    if (!match) {
        return null;
    }

    const playerName = cleanClashPerkText(match[1]);
    const playerTag = normalizePlayerTag(match[2]);
    const displayName = cleanClashPerkText(match[3]);
    const discordMentionId = String(match[3] || '').match(/<@!?(\d{17,20})>/)?.[1] || null;

    if (!isValidPlayerTag(playerTag) || !displayName) {
        return null;
    }

    return {
        playerName,
        playerTag,
        displayName,
        discordMentionId,
        rawText: linkText
    };
}

function parseClashPerkLinkMessage(textRaw) {
    const candidates = Array.isArray(textRaw)
        ? uniqueTextCandidates(textRaw)
        : uniqueTextCandidates([textRaw]);

    for (const candidate of candidates) {
        const parsed = parseClashPerkLinkCandidate(candidate);

        if (parsed) {
            return parsed;
        }
    }

    return null;
}

function collectionValues(collection) {
    if (!collection) {
        return [];
    }

    if (Array.isArray(collection)) {
        return collection;
    }

    if (typeof collection.values === 'function') {
        return [...collection.values()];
    }

    return [];
}

function getMemberDisplayName(member) {
    return String(
        member?.user?.globalName ||
        member?.user?.displayName ||
        member?.user?.username ||
        member?.nickname ||
        member?.displayName ||
        member?.user?.username ||
        ''
    ).trim();
}

function getMemberUsername(member) {
    return String(member?.user?.username || member?.username || '').trim();
}

function getMemberId(member) {
    return String(member?.id || member?.user?.id || '').trim();
}

function isHumanMember(member) {
    return member?.user?.bot !== true;
}

function normalizeDisplayNameForCompare(value) {
    return String(value || '')
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase();
}

function addDisplayNameMatches(matchBuckets, members, displayName) {
    const wantedExact = String(displayName || '').trim();
    const wantedNormalized = normalizeDisplayNameForCompare(wantedExact);

    if (!wantedExact || !wantedNormalized) {
        return;
    }

    for (const member of collectionValues(members)) {
        const memberId = getMemberId(member);

        if (!memberId || !isHumanMember(member)) {
            continue;
        }

        const memberDisplayName = getMemberDisplayName(member);

        if (memberDisplayName === wantedExact) {
            matchBuckets.exact.set(memberId, member);
            continue;
        }

        if (normalizeDisplayNameForCompare(memberDisplayName) === wantedNormalized) {
            matchBuckets.caseInsensitive.set(memberId, member);
        }
    }
}

function getResolvedDisplayNameMatches(matchBuckets) {
    return [
        ...(matchBuckets.exact.size > 0
            ? matchBuckets.exact.values()
            : matchBuckets.caseInsensitive.values())
    ];
}

async function fetchAllGuildMembers(guild, options = {}) {
    const members = guild?.members;

    if (!members) {
        return [];
    }

    if (typeof members.list === 'function') {
        const allMembers = new Map();
        const pageLimit = Math.min(
            DEFAULT_MEMBER_LIST_PAGE_LIMIT,
            Math.max(1, Number(options.pageLimit) || DEFAULT_MEMBER_LIST_PAGE_LIMIT)
        );
        const maxPages = Math.max(1, Number(options.maxPages) || DEFAULT_MEMBER_LIST_MAX_PAGES);
        let after = '0';

        for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
            const page = await members.list({
                after,
                limit: pageLimit,
                cache: true
            });
            const pageMembers = collectionValues(page);

            for (const member of pageMembers) {
                const memberId = getMemberId(member);

                if (memberId) {
                    allMembers.set(memberId, member);
                }
            }

            if (pageMembers.length < pageLimit) {
                break;
            }

            const lastMemberId = getMemberId(pageMembers[pageMembers.length - 1]);

            if (!lastMemberId || lastMemberId === after) {
                break;
            }

            after = lastMemberId;
        }

        return [...allMembers.values()];
    }

    if (typeof members.fetch === 'function') {
        const fetched = await members.fetch({
            withPresences: false,
            time: options.timeoutMs || DEFAULT_FULL_MEMBER_FETCH_TIMEOUT_MS
        });

        return collectionValues(fetched);
    }

    return [];
}

async function searchGuildMembersByDisplayName(guild, displayName, options = {}) {
    const matchBuckets = {
        exact: new Map(),
        caseInsensitive: new Map()
    };
    const limit = options.limit || DEFAULT_MEMBER_SEARCH_LIMIT;

    addDisplayNameMatches(matchBuckets, guild?.members?.cache, displayName);

    try {
        if (typeof guild?.members?.search === 'function') {
            const searched = await guild.members.search({
                query: displayName,
                limit,
                cache: true
            });
            addDisplayNameMatches(matchBuckets, searched, displayName);
        } else if (typeof guild?.members?.fetch === 'function') {
            const searched = await guild.members.fetch({
                query: displayName,
                limit,
                time: options.timeoutMs || 10_000
            });
            addDisplayNameMatches(matchBuckets, searched, displayName);
        }
    } catch (error) {
        console.warn('ClashPerk display name member lookup failed:', {
            displayName,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });
    }

    if (options.fetchAllMembers !== false) {
        try {
            addDisplayNameMatches(
                matchBuckets,
                await fetchAllGuildMembers(guild, options.fullMemberFetch || {}),
                displayName
            );
        } catch (error) {
            console.warn('ClashPerk full member lookup failed:', {
                displayName,
                errorName: error?.name || null,
                errorMessage: error?.message || null,
                errorCode: error?.code || null,
                status: error?.status || null
            });
        }
    }

    return getResolvedDisplayNameMatches(matchBuckets);
}

function formatConfiguredMessage(template, details) {
    return String(template || '')
        .replaceAll('{playerTag}', details.playerTag || '')
        .replaceAll('{displayName}', details.displayName || '');
}

async function sendChannelMessage(message, content) {
    if (!content || typeof message?.channel?.send !== 'function') {
        return;
    }

    try {
        await message.channel.send(content);
    } catch (error) {
        console.error('ClashPerk link sync response send failed:', {
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });
    }
}

function isConfiguredClashPerkBotMessage(message, clashPerkConfig) {
    const configuredBotId = String(clashPerkConfig?.botId || '').trim();

    if (!message?.guild || !message?.channel) {
        return false;
    }

    const ownBotId = String(message?.client?.user?.id || '').trim();

    if (ownBotId && message?.author?.id === ownBotId) {
        return false;
    }

    const sourceIds = getMessageSourceIds(message);

    if (configuredBotId && sourceIds.includes(configuredBotId)) {
        return true;
    }

    const authorName = getMessageAuthorName(message);

    return Boolean(
        isAutomatedMessage(message) &&
        CLASHPERK_AUTHOR_NAME_PATTERN.test(authorName)
    );
}

function hasHandledMessage(message) {
    const messageId = String(message?.id || '').trim();

    return Boolean(messageId && handledMessageIds.has(messageId));
}

function markMessageHandled(message) {
    const messageId = String(message?.id || '').trim();

    if (!messageId) {
        return;
    }

    handledMessageIds.add(messageId);

    if (handledMessageIds.size > HANDLED_MESSAGE_ID_LIMIT) {
        const oldestMessageId = handledMessageIds.values().next().value;
        handledMessageIds.delete(oldestMessageId);
    }
}

async function fetchGuildMemberById(guild, discordId) {
    const id = String(discordId || '').trim();

    if (!id || typeof guild?.members?.fetch !== 'function') {
        return null;
    }

    try {
        return await guild.members.fetch({
            user: id,
            cache: true,
            force: true
        });
    } catch {
        return null;
    }
}

async function handleClashPerkLinkMessage(message, options = {}) {
    const hydratedMessage = await hydrateMessage(message);
    const clashPerkConfig = options.clashPerkConfig || appConfig.clashPerk || {};
    const textCandidates = getClashPerkMessageTextCandidates(hydratedMessage);

    if (!isConfiguredClashPerkBotMessage(hydratedMessage, clashPerkConfig)) {
        return null;
    }

    if (hasHandledMessage(hydratedMessage)) {
        return null;
    }

    if (textCandidates.length === 0) {
        console.warn('ClashPerk candidate message arrived without readable message content:', {
            messageId: hydratedMessage?.id || null,
            channelId: hydratedMessage?.channel?.id || null,
            authorId: hydratedMessage?.author?.id || null,
            authorName: getMessageAuthorName(hydratedMessage) || null,
            webhookId: hydratedMessage?.webhookId || null,
            applicationId: hydratedMessage?.applicationId || null,
            interactionApplicationId: hydratedMessage?.interaction?.applicationId ||
                hydratedMessage?.interactionMetadata?.applicationId ||
                null,
            embedCount: Array.isArray(hydratedMessage?.embeds) ? hydratedMessage.embeds.length : 0,
            contentLength: typeof hydratedMessage?.content === 'string' ? hydratedMessage.content.length : null
        });
        return null;
    }

    const parsed = parseClashPerkLinkMessage(textCandidates);

    if (!parsed) {
        if (textCandidates.some(candidate => SUCCESSFUL_LINK_MARKER_PATTERN.test(candidate))) {
            console.warn('ClashPerk successful-link message was seen but could not be parsed:', {
                messageId: hydratedMessage?.id || null,
                channelId: hydratedMessage?.channel?.id || null,
                authorId: hydratedMessage?.author?.id || null,
                embedCount: Array.isArray(hydratedMessage?.embeds) ? hydratedMessage.embeds.length : 0
            });
        }

        return null;
    }

    markMessageHandled(hydratedMessage);

    console.log('ClashPerk successful-link message detected:', {
        messageId: hydratedMessage?.id || null,
        channelId: hydratedMessage?.channel?.id || null,
        authorId: hydratedMessage?.author?.id || null,
        playerTag: parsed.playerTag,
        displayName: parsed.displayName
    });

    const mentionedMember = parsed.discordMentionId
        ? await fetchGuildMemberById(hydratedMessage.guild, parsed.discordMentionId)
        : null;
    const matches = mentionedMember
        ? [mentionedMember]
        : await searchGuildMembersByDisplayName(
            hydratedMessage.guild,
            parsed.displayName,
            options.memberSearch || {}
        );

    if (matches.length !== 1) {
        const template = matches.length > 1
            ? clashPerkConfig.ambiguousDisplayNameMessage
            : clashPerkConfig.missingDisplayNameMessage;
        const fallback = matches.length > 1
            ? `Website sync did not work for ${parsed.playerTag} because the Discord display name "${parsed.displayName}" is ambiguous. Please manually create the link or sync using the import function in the admin panel.`
            : `Website sync did not work for ${parsed.playerTag} because no Discord member with display name "${parsed.displayName}" was found. Please manually create the link or sync using the import function in the admin panel.`;

        await sendChannelMessage(
            hydratedMessage,
            formatConfiguredMessage(template || fallback, parsed)
        );

        return {
            ok: false,
            reason: matches.length > 1 ? 'ambiguous-display-name' : 'display-name-not-found',
            parsed,
            matchCount: matches.length
        };
    }

    const member = matches[0];
    const syncIdentity = options.syncDiscordIdentityForPlayerTag || syncDiscordIdentityForPlayerTag;
    const result = await syncIdentity(
        parsed.playerTag,
        getMemberId(member),
        getMemberUsername(member)
    );

    if (!result || result.ok === false || result.skipped === true) {
        const fallback = `Website sync did not work for ${parsed.playerTag} because the backend sync failed. Please manually create the link or sync using the import function in the admin panel.`;
        await sendChannelMessage(
            hydratedMessage,
            formatConfiguredMessage(clashPerkConfig.backendFailureMessage || fallback, parsed)
        );

        return {
            ok: false,
            reason: 'backend-sync-failed',
            parsed,
            result
        };
    }

    await sendChannelMessage(hydratedMessage, clashPerkConfig.linkSavedMessage || 'Link Saved');

    return {
        ok: true,
        parsed,
        memberId: getMemberId(member),
        result
    };
}

module.exports = handleClashPerkLinkMessage;
module.exports.cleanClashPerkText = cleanClashPerkText;
module.exports.normalizeClashPerkText = normalizeClashPerkText;
module.exports.getClashPerkMessageTextCandidates = getClashPerkMessageTextCandidates;
module.exports.parseClashPerkLinkMessage = parseClashPerkLinkMessage;
module.exports.searchGuildMembersByDisplayName = searchGuildMembersByDisplayName;
module.exports.getMemberDisplayName = getMemberDisplayName;
module.exports.getMemberUsername = getMemberUsername;
module.exports.getMemberId = getMemberId;
module.exports.isConfiguredClashPerkBotMessage = isConfiguredClashPerkBotMessage;
