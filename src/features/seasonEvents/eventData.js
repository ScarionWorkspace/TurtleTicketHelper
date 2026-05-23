const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterFirebase = require('../rosterFirebase/rosterFirebaseReadClient');
const { normalizeEventType } = require('./constants');
const {
    buildLocalSeasonEventLeaderboard
} = require('./leaderboardScoring');

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned.replace(/O/g, '0');
}

function getEventId(event) {
    return event?.eventId || event?.id || event?.eventID || event?.key || null;
}

function getEventSeasonId(event) {
    return event?.seasonId || event?.season?.id || event?.seasonKey || null;
}

function getEventType(event) {
    return normalizeEventType(event?.type || event?.eventType || event?.kind);
}

function asArray(value) {
    if (!value) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.filter(Boolean);
    }

    if (typeof value === 'object') {
        return Object.values(value).filter(Boolean);
    }

    return [];
}

function pointerToEventId(pointer) {
    if (!pointer) {
        return null;
    }

    if (typeof pointer === 'string') {
        return pointer;
    }

    return pointer.eventId || pointer.currentEventId || pointer.id || null;
}

async function readCurrentEventFromFirebase(type, options = {}) {
    const eventType = normalizeEventType(type);
    const pointer = await rosterFirebase.readCurrentSeasonEventPointer(eventType);
    const eventId = pointerToEventId(pointer);

    if (!eventId) {
        return null;
    }

    const event = await rosterFirebase.readSeasonEventById(eventId, {
        includeParticipantsByDiscordId: options.includeParticipantsByDiscordId === true
    });

    if (!event) {
        return null;
    }

    return {
        ...pointer,
        ...event,
        eventId: getEventId(event) || eventId,
        type: getEventType(event) || eventType
    };
}

function normalizeParticipantStatus(status) {
    return String(status || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
}

function isActiveParticipant(participant) {
    return normalizeParticipantStatus(participant?.status) === 'signed_up';
}

function getParticipants(event) {
    if (!event || typeof event !== 'object') {
        return [];
    }

    return [
        ...asArray(event.participants),
        ...asArray(event.participantsByDiscordId)
    ];
}

function getActiveParticipants(event) {
    return getParticipants(event).filter(isActiveParticipant);
}

function getParticipantDisplayName(participant) {
    return participant?.discordDisplayName ||
        participant?.discordGlobalName ||
        participant?.discordUsername ||
        participant?.displayName ||
        participant?.playerName ||
        participant?.accountName ||
        'Unknown';
}

function normalizeAccount(account, participant = {}) {
    if (typeof account === 'string') {
        const tag = normalizePlayerTag(account);

        return {
            tag,
            playerTag: tag,
            name: tag,
            townHall: null,
            townHallLevel: null,
            trophies: null,
            leagueName: null
        };
    }

    const tag = normalizePlayerTag(
        account?.playerTag ||
        account?.tag ||
        account?.accountTag ||
        account?.clashTag ||
        ''
    );

    return {
        tag,
        playerTag: tag,
        name:
            account?.playerName ||
            account?.name ||
            account?.accountName ||
            participant?.playerName ||
            participant?.accountName ||
            getParticipantDisplayName(participant),
        townHall:
            account?.townHallLevel ||
            account?.townHall ||
            account?.th ||
            account?.thLevel ||
            participant?.townHallLevel ||
            participant?.townHall ||
            null,
        townHallLevel:
            account?.townHallLevel ||
            account?.townHall ||
            account?.th ||
            account?.thLevel ||
            null,
        trophies: account?.trophies ?? null,
        leagueName: account?.leagueName || account?.league?.name || account?.leagueTier?.name || null
    };
}

function getAccountRowsForParticipant(participant) {
    const accountSources = [
        ...asArray(participant?.accounts),
        ...asArray(participant?.selectedAccounts),
        ...asArray(participant?.players)
    ];

    if (accountSources.length === 0) {
        for (const tag of [
            ...asArray(participant?.playerTags),
            ...asArray(participant?.accountTags)
        ]) {
            accountSources.push({ playerTag: tag });
        }
    }

    return accountSources.map(account => ({
        ...normalizeAccount(account, participant),
        participant
    }));
}

function extractLeaderboardRows(leaderboard) {
    if (!leaderboard) {
        return [];
    }

    if (Array.isArray(leaderboard)) {
        return leaderboard.filter(Boolean);
    }

    if (typeof leaderboard !== 'object') {
        return [];
    }

    return asArray(
        leaderboard.leaderboard ||
        leaderboard.rows ||
        leaderboard.entries ||
        leaderboard.items
    );
}

function getLeaderboardRowsByTag(leaderboard) {
    const rowsByTag = new Map();

    for (const row of extractLeaderboardRows(leaderboard)) {
        const rowTags = [
            row?.playerTag,
            row?.tag,
            row?.accountTag,
            row?.account?.tag,
            ...asArray(row?.accounts).map(account => account?.tag || account?.playerTag)
        ]
            .map(normalizePlayerTag)
            .filter(Boolean);

        for (const account of asArray(row?.accounts)) {
            const tag = normalizePlayerTag(account?.tag || account?.playerTag);

            if (tag) {
                rowsByTag.set(tag, {
                    ...account,
                    scoreLabel: account.scoreLabel || row.scoreLabel,
                    score: account.score ?? row.score,
                    metric: row.metric
                });
            }
        }

        for (const tag of rowTags) {
            if (!rowsByTag.has(tag)) {
                rowsByTag.set(tag, row);
            }
        }
    }

    return rowsByTag;
}

function getEventAvailabilityStatus(event, now = new Date()) {
    if (!event) {
        return 'event-not-found';
    }

    const status = String(event.status || '').toLowerCase();

    if (status === 'closed' || status === 'archived') {
        return 'event-closed';
    }

    if (status !== 'open') {
        return 'event-not-open';
    }

    if (event.signupsOpen !== true) {
        return 'signups-closed';
    }

    const nowMs = now.getTime();
    const startsAtMs = event.startsAt ? Date.parse(event.startsAt) : null;
    const endsAtMs = event.endsAt ? Date.parse(event.endsAt) : null;

    if (Number.isFinite(startsAtMs) && nowMs < startsAtMs) {
        return 'event-not-open';
    }

    if (Number.isFinite(endsAtMs) && nowMs > endsAtMs) {
        return 'event-closed';
    }

    return null;
}

async function loadEventForRendering(type, options = {}) {
    const eventType = normalizeEventType(type);

    if (!eventType) {
        return {
            event: null,
            leaderboard: null,
            source: 'none'
        };
    }

    if (options.reconcile) {
        await rosterBackend.reconcileCurrentSeasonEvents({
            forceRefresh: false,
            source: options.source || {}
        });
    }

    const event = await readCurrentEventFromFirebase(eventType, {
        includeParticipantsByDiscordId: true
    });
    const metricsByTag = event
        ? await rosterFirebase.readAllActivePlayerMetricsByTag()
        : null;
    const leaderboard = event
        ? buildLocalSeasonEventLeaderboard(event, metricsByTag, {
            type: eventType,
            limit: options.limit,
            nowIso: options.nowIso
        })
        : null;

    return {
        event,
        leaderboard,
        source: event ? 'firebase' : 'missing'
    };
}

async function resolveCurrentSeasonEvent(type, options = {}) {
    const eventType = normalizeEventType(type);

    if (!eventType) {
        return null;
    }

    if (options.reconcile) {
        await rosterBackend.reconcileCurrentSeasonEvents({
            forceRefresh: false,
            source: options.source || {}
        });
    }

    return readCurrentEventFromFirebase(eventType);
}

async function readParticipantByDiscordId(eventId, discordId) {
    return rosterFirebase.readSeasonEventParticipantByDiscordId(eventId, discordId);
}

async function readLinkedAccountsForDiscordUser(discordUser) {
    return rosterFirebase.readLinkedAccountsForDiscordUser(discordUser);
}

module.exports = {
    normalizePlayerTag,
    getEventId,
    getEventSeasonId,
    getEventType,
    asArray,
    getActiveParticipants,
    normalizeAccount,
    getAccountRowsForParticipant,
    getLeaderboardRowsByTag,
    extractLeaderboardRows,
    getEventAvailabilityStatus,
    loadEventForRendering,
    resolveCurrentSeasonEvent,
    readParticipantByDiscordId,
    readLinkedAccountsForDiscordUser
};
