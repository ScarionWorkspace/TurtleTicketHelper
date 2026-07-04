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

function getDonationLedgerLastSeenMs(ledger) {
    const lastSeenMs = Date.parse(ledger?.lastSeenAt || '');
    if (Number.isFinite(lastSeenMs)) {
        return lastSeenMs;
    }

    const firstSeenMs = Date.parse(ledger?.firstSeenAt || '');
    return Number.isFinite(firstSeenMs) ? firstSeenMs : 0;
}

function mergeDonationRefreshOverlayIntoMetrics(event, metricsByTag, overlay) {
    const seasonId = String(getEventSeasonId(event) || '').trim();

    if (getEventType(event) !== 'donation' || !seasonId) {
        return metricsByTag;
    }

    const byTag = overlay?.byTag && typeof overlay.byTag === 'object' ? overlay.byTag : null;

    if (!byTag) {
        return metricsByTag;
    }

    const merged = { ...(metricsByTag && typeof metricsByTag === 'object' ? metricsByTag : {}) };

    for (const [rawTag, entry] of Object.entries(byTag)) {
        const tag = normalizePlayerTag(rawTag || entry?.tag || entry?.identity?.tag);
        const overlayLedger = entry?.donationCycle || entry?.ledger || entry?.donationCycles?.[seasonId];

        if (!tag || !overlayLedger || typeof overlayLedger !== 'object') {
            continue;
        }

        const current = merged[tag] && typeof merged[tag] === 'object' ? merged[tag] : {};
        const currentLedger = current?.donationCycles?.[seasonId] || null;

        if (currentLedger && getDonationLedgerLastSeenMs(currentLedger) > getDonationLedgerLastSeenMs(overlayLedger)) {
            continue;
        }

        merged[tag] = {
            ...current,
            identity: {
                ...(current.identity && typeof current.identity === 'object' ? current.identity : {}),
                tag,
                name: current.identity?.name || entry?.name || tag
            },
            donationCycles: {
                ...(current.donationCycles && typeof current.donationCycles === 'object' ? current.donationCycles : {}),
                [seasonId]: overlayLedger
            }
        };
    }

    return merged;
}

async function mergeDonationRefreshOverlayForEvent(event, metricsByTag) {
    const seasonId = String(getEventSeasonId(event) || '').trim();

    if (getEventType(event) !== 'donation' || !seasonId) {
        return metricsByTag;
    }

    try {
        const overlay = await rosterFirebase.readDonationRefreshSeasonOverlay(seasonId);
        return mergeDonationRefreshOverlayIntoMetrics(event, metricsByTag, overlay);
    } catch (error) {
        console.warn('Season event donation overlay unavailable; using active metrics only.', {
            seasonId,
            errorName: error?.name || null,
            errorMessage: error?.message || null
        });
        return metricsByTag;
    }
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
    const pointer = eventType === 'cwl'
        ? await rosterFirebase.readCurrentCwlSeasonEventPointer()
        : await rosterFirebase.readCurrentSeasonEventPointer(eventType);
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

async function buildCwlAggregateLeaderboardFallback(event) {
    const eventId = getEventId(event);
    const state = String(event?.cwlTrackingState || event?.cwlStatus || '').trim().toLowerCase();
    const kind = state === 'completed' ? 'final' : 'live';
    const aggregate = eventId
        ? await rosterFirebase.readCwlSeasonEventAggregate(eventId, kind)
        : null;

    if (!aggregate || typeof aggregate !== 'object') {
        return {
            ok: true,
            event,
            leaderboard: [],
            aggregate: null
        };
    }

    const byTag = aggregate.byTag && typeof aggregate.byTag === 'object' ? aggregate.byTag : {};
    const rankedTags = Array.isArray(aggregate.rankedTags)
        ? aggregate.rankedTags.map(normalizePlayerTag).filter(Boolean)
        : Object.keys(byTag).map(normalizePlayerTag).filter(Boolean).sort();
    const rows = rankedTags.map((tag, index) => {
        const stats = byTag[tag] && typeof byTag[tag] === 'object' ? byTag[tag] : {};
        return {
            rank: index + 1,
            tag,
            playerTag: tag,
            displayName: tag,
            accounts: [{ tag, name: tag, cwlStats: stats }],
            score: Number(stats.starsTotal) || 0,
            scoreLabel: `${Number(stats.starsTotal) || 0} stars, ${Number(stats.defenseHolds) || 0} holds`,
            metric: 'cwl',
            coverage: byTag[tag] ? 'full' : 'no-cwl-participation',
            cwlStats: stats
        };
    });

    return {
        ok: true,
        event,
        leaderboard: rows,
        aggregate: {
            kind,
            stale: aggregate.stale === true,
            lastSuccessfulRefreshAt: aggregate.lastSuccessfulRefreshAt || ''
        }
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
                const hasAccountScore =
                    account.score !== undefined ||
                    account.currentValue !== undefined ||
                    account.delta !== undefined ||
                    account.donations !== undefined ||
                    account.total !== undefined;
                const accountScore =
                    account.score ??
                    account.currentValue ??
                    account.delta ??
                    account.donations ??
                    account.total ??
                    row.score;
                rowsByTag.set(tag, {
                    ...row,
                    ...account,
                    scoreLabel: account.scoreLabel || row.scoreLabel,
                    score: accountScore,
                    metric: account.metric || row.metric,
                    rank: row.rank,
                    hasAccountScore,
                    leagueName: account.leagueName || row.leagueName,
                    leagueLabel: account.leagueLabel || row.leagueLabel,
                    currentLeagueName: account.currentLeagueName || row.currentLeagueName,
                    currentLeagueLabel: account.currentLeagueLabel || row.currentLeagueLabel,
                    currentTrophies: account.currentTrophies ?? row.currentTrophies,
                    currentCapturedMs: account.currentCapturedMs ?? row.currentCapturedMs,
                    leagueBucket: account.leagueBucket ?? row.leagueBucket,
                    hasPushRank: account.hasPushRank ?? row.hasPushRank
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

async function readBackendLeaderboardForEvent(event, eventType, options = {}) {
    if (!event || !rosterBackend.isRosterBackendConfigured?.()) {
        return null;
    }

    const eventId = getEventId(event);

    if (!eventId) {
        return null;
    }

    try {
        const leaderboard = await rosterBackend.getSeasonEventLeaderboard({
            eventId,
            limit: options.limit,
            now: options.nowIso,
            nowIso: options.nowIso,
            source: options.source || {}
        });

        if (!leaderboard || typeof leaderboard !== 'object') {
            return null;
        }

        const summaryEvent = leaderboard.event && typeof leaderboard.event === 'object'
            ? leaderboard.event
            : {};

        return {
            event: {
                ...event,
                ...summaryEvent,
                eventId: getEventId(summaryEvent) || eventId,
                type: getEventType(summaryEvent) || eventType
            },
            leaderboard
        };
    } catch (error) {
        console.warn('Season event backend leaderboard unavailable; falling back to Firebase scoring.', {
            eventId,
            eventType,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });

        return null;
    }
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

    let ensuredCwlEvent = null;
    if (eventType === 'cwl' && options.ensureCurrent) {
        const ensured = await rosterBackend.ensureCurrentCwlSeasonEvent({
            source: options.source || {}
        });
        ensuredCwlEvent = ensured?.event && typeof ensured.event === 'object' ? ensured.event : null;
    } else if (options.reconcile && eventType !== 'cwl') {
        await rosterBackend.reconcileCurrentSeasonEvents({
            forceRefresh: false,
            source: options.source || {}
        });
    }

    let event = await readCurrentEventFromFirebase(eventType, {
        includeParticipantsByDiscordId: true
    });
    if (!event && ensuredCwlEvent) {
        event = ensuredCwlEvent;
    }

    let leaderboard = null;
    let source = event ? 'firebase' : 'missing';

    if (event) {
        const backendResult = await readBackendLeaderboardForEvent(event, eventType, options);

        if (backendResult) {
            event = backendResult.event;
            leaderboard = backendResult.leaderboard;
            source = 'backend';
        } else if (eventType === 'cwl') {
            leaderboard = await buildCwlAggregateLeaderboardFallback(event);
            source = 'firebase-cwl-aggregate';
        } else {
            const metricsByTag = await rosterFirebase.readAllActivePlayerMetricsByTag();
            const scoringMetricsByTag = await mergeDonationRefreshOverlayForEvent(event, metricsByTag);
            leaderboard = buildLocalSeasonEventLeaderboard(event, scoringMetricsByTag, {
                type: eventType,
                limit: options.limit,
                nowIso: options.nowIso
            });
        }
    }

    return {
        event,
        leaderboard,
        source
    };
}

async function resolveCurrentSeasonEvent(type, options = {}) {
    const eventType = normalizeEventType(type);

    if (!eventType) {
        return null;
    }

    if (eventType === 'cwl' && options.ensureCurrent) {
        const ensured = await rosterBackend.ensureCurrentCwlSeasonEvent({
            source: options.source || {}
        });
        if (ensured?.event) {
            return ensured.event;
        }
    } else if (options.reconcile && eventType !== 'cwl') {
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
