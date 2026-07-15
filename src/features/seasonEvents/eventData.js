const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const { normalizeEventType } = require('./constants');
const {
    buildLocalSeasonEventLeaderboard
} = require('./leaderboardScoring');

const CURRENT_EVENT_BACKEND_TIMEOUT_MS = 15_000;

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

function getCwlEventTarget(event) {
    const target = event?.cwl?.target && typeof event.cwl.target === 'object'
        ? event.cwl.target
        : {};
    const status = String(target.status || '').trim().toLowerCase();

    return target.resolved === true || status === 'resolved' ? target : null;
}

function isCwlEventTargetResolved(event) {
    return !!getCwlEventTarget(event);
}

function isLegacyCompletedTargetlessCwlEvent(event) {
    const state = String(event?.cwlTrackingState || event?.cwlStatus || '').trim().toLowerCase();
    return getEventType(event) === 'cwl' && state === 'completed' && !isCwlEventTargetResolved(event);
}

function getCwlEventEligibleTagSet(event) {
    const target = getCwlEventTarget(event);

    if (!target) {
        return null;
    }

    return new Set(
        (Array.isArray(target.eligibleAccountTags) ? target.eligibleAccountTags : [])
            .map(normalizePlayerTag)
            .filter(Boolean)
    );
}

function filterAccountsForCwlEventTarget(event, accounts) {
    const rows = Array.isArray(accounts) ? accounts : [];
    const eligibleTags = getCwlEventEligibleTagSet(event);

    if (!eligibleTags) {
        return isLegacyCompletedTargetlessCwlEvent(event) ? rows : [];
    }

    return rows.filter(account => eligibleTags.has(normalizePlayerTag(account?.tag || account?.playerTag)));
}

function filterLinkedAccountsForEvent(event, linkedAccounts) {
    if (getEventType(event) !== 'cwl') {
        return Array.isArray(linkedAccounts) ? linkedAccounts : [];
    }

    return filterAccountsForCwlEventTarget(event, linkedAccounts);
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

async function mergeDonationRefreshOverlayForEvent(event, metricsByTag, options = {}) {
    const seasonId = String(getEventSeasonId(event) || '').trim();

    if (getEventType(event) !== 'donation' || !seasonId) {
        return metricsByTag;
    }

    try {
        const overlay = await rosterPublicData.readDonationRefreshSeasonOverlay(seasonId, options);
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

async function readCurrentEventFromPublicData(type, options = {}) {
    const eventType = normalizeEventType(type);
    const readOptions = {
        cacheTtlMs: options.cacheTtlMs,
        timeoutMs: options.timeoutMs
    };
    const pointer = eventType === 'cwl'
        ? await rosterPublicData.readCurrentCwlSeasonEventPointer(readOptions)
        : await rosterPublicData.readCurrentSeasonEventPointer(eventType, readOptions);
    const eventId = pointerToEventId(pointer);

    if (!eventId) {
        return null;
    }

    const event = await rosterPublicData.readSeasonEventById(eventId, {
        ...readOptions,
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

function normalizeBackendEvent(event, eventType) {
    if (!event || typeof event !== 'object') {
        return null;
    }

    return {
        ...event,
        eventId: getEventId(event),
        type: getEventType(event) || eventType
    };
}

function getEventFromCurrentBackendResult(result, eventType) {
    if (!result || typeof result !== 'object') {
        return null;
    }

    const event = result.events && typeof result.events === 'object'
        ? result.events[eventType]
        : eventType === 'cwl'
            ? result.event
            : null;

    return normalizeBackendEvent(event, eventType);
}

async function readCurrentEventFromBackend(type, options = {}) {
    const eventType = normalizeEventType(type);

    if (!eventType || !rosterBackend.isRosterBackendConfigured?.()) {
        return {
            event: null,
            attempted: false,
            failed: false
        };
    }

    try {
        const requestOptions = {
            timeoutMs: options.currentEventTimeoutMs ?? CURRENT_EVENT_BACKEND_TIMEOUT_MS
        };
        const result = eventType === 'cwl' && typeof rosterBackend.getCurrentCwlSeasonEvent === 'function'
            ? await rosterBackend.getCurrentCwlSeasonEvent({
                source: options.source || {}
            }, requestOptions)
            : await rosterBackend.getCurrentSeasonEvents({
                now: options.nowIso,
                nowIso: options.nowIso,
                source: options.source || {}
            }, requestOptions);

        return {
            event: getEventFromCurrentBackendResult(result, eventType),
            attempted: true,
            failed: false
        };
    } catch (error) {
        console.warn('Current season event backend read unavailable; falling back to Cloudflare public data.', {
            eventType,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });

        return {
            event: null,
            attempted: true,
            failed: true
        };
    }
}

async function readPublicEventByKnownId(event, eventType, options = {}) {
    const eventId = getEventId(event);

    if (!eventId) {
        return null;
    }

    const publicEvent = await rosterPublicData.readSeasonEventById(eventId, {
        cacheTtlMs: options.cacheTtlMs,
        timeoutMs: options.timeoutMs,
        includeParticipantsByDiscordId: options.includeParticipantsByDiscordId === true
    });

    if (!publicEvent || typeof publicEvent !== 'object') {
        return null;
    }

    return {
        ...publicEvent,
        eventId: getEventId(publicEvent) || eventId,
        type: getEventType(publicEvent) || eventType
    };
}

function mergeEventRefreshResult(storedEvent, refreshedEvent, eventType) {
    if (!refreshedEvent || typeof refreshedEvent !== 'object') {
        return storedEvent;
    }

    if (!storedEvent || typeof storedEvent !== 'object') {
        return {
            ...refreshedEvent,
            eventId: getEventId(refreshedEvent),
            type: getEventType(refreshedEvent) || eventType
        };
    }

    const storedEventId = getEventId(storedEvent);
    const refreshedEventId = getEventId(refreshedEvent);

    if (storedEventId && refreshedEventId && storedEventId !== refreshedEventId) {
        return {
            ...refreshedEvent,
            eventId: refreshedEventId,
            type: getEventType(refreshedEvent) || eventType
        };
    }

    return {
        ...storedEvent,
        ...refreshedEvent,
        eventId: refreshedEventId || storedEventId,
        type: getEventType(refreshedEvent) || getEventType(storedEvent) || eventType
    };
}

async function refreshCurrentCwlEventForRendering(options = {}) {
    if (typeof rosterBackend.refreshCurrentCwlSeasonEvent !== 'function') {
        return null;
    }

    try {
        const refreshed = await rosterBackend.refreshCurrentCwlSeasonEvent({
            source: options.source || {}
        });

        return refreshed?.event && typeof refreshed.event === 'object'
            ? refreshed.event
            : null;
    } catch (error) {
        console.warn('CWL season event refresh unavailable; using current stored event.', {
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });

        return null;
    }
}

function getCwlDefenseStarsConceded(stats) {
    const value = Number(stats?.defenseStarsConceded ?? stats?.bestStarsConceded ?? 0);

    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function getCwlOffenseStars(stats) {
    const value = Number(stats?.starsTotal ?? 0);

    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function compareCwlAggregateTags(byTag, leftTag, rightTag) {
    const leftStats = byTag[leftTag] && typeof byTag[leftTag] === 'object' ? byTag[leftTag] : {};
    const rightStats = byTag[rightTag] && typeof byTag[rightTag] === 'object' ? byTag[rightTag] : {};
    const starDiff = getCwlOffenseStars(rightStats) - getCwlOffenseStars(leftStats);

    if (starDiff !== 0) {
        return starDiff;
    }

    const defenseStarDiff = getCwlDefenseStarsConceded(leftStats) - getCwlDefenseStarsConceded(rightStats);

    if (defenseStarDiff !== 0) {
        return defenseStarDiff;
    }

    return leftTag.localeCompare(rightTag);
}

function hasCwlAggregateParticipation(stats) {
    return getCwlOffenseStars(stats) > 0 ||
        Number(stats?.attacksMade || 0) > 0 ||
        Number(stats?.missedAttacks || 0) > 0 ||
        Number(stats?.currentWarAttackPending || 0) > 0 ||
        Number(stats?.defenseAttacksReceived || 0) > 0 ||
        Number(stats?.attackedDefenseDays || 0) > 0 ||
        Number(stats?.unattackedDefenseDays || 0) > 0;
}

function compareCwlLeaderboardRows(left, right) {
    const leftStats = left?.cwlStats && typeof left.cwlStats === 'object' ? left.cwlStats : {};
    const rightStats = right?.cwlStats && typeof right.cwlStats === 'object' ? right.cwlStats : {};
    const leftParticipated = hasCwlAggregateParticipation(leftStats);
    const rightParticipated = hasCwlAggregateParticipation(rightStats);

    if (leftParticipated !== rightParticipated) {
        return leftParticipated ? -1 : 1;
    }

    const starDiff = getCwlOffenseStars(rightStats) - getCwlOffenseStars(leftStats);

    if (starDiff !== 0) {
        return starDiff;
    }

    const defenseStarDiff = getCwlDefenseStarsConceded(leftStats) - getCwlDefenseStarsConceded(rightStats);

    if (defenseStarDiff !== 0) {
        return defenseStarDiff;
    }

    const leftName = String(left?.displayName || '').trim().toLowerCase();
    const rightName = String(right?.displayName || '').trim().toLowerCase();

    if (leftName !== rightName) {
        return leftName < rightName ? -1 : 1;
    }

    return String(left?.tag || '').localeCompare(String(right?.tag || ''));
}

function getRegisteredCwlAccountRows(event) {
    const rows = [];
    const seen = new Set();
    const eligibleTags = getCwlEventEligibleTagSet(event);

    if (!eligibleTags && !isLegacyCompletedTargetlessCwlEvent(event)) {
        return rows;
    }

    for (const participant of getActiveParticipants(event)) {
        for (const account of getAccountRowsForParticipant(participant)) {
            const tag = normalizePlayerTag(account?.tag || account?.playerTag);

            if (!tag || seen.has(tag) || (eligibleTags && !eligibleTags.has(tag))) {
                continue;
            }

            seen.add(tag);
            rows.push({
                participant,
                account: {
                    ...account,
                    tag,
                    playerTag: tag
                },
                tag
            });
        }
    }

    return rows;
}

function shouldUseCwlAggregateRankedTags(rankedTags, registeredTags) {
    if (!Array.isArray(rankedTags) || rankedTags.length === 0 || !registeredTags.length) {
        return false;
    }

    const rankedSet = new Set(rankedTags.map(normalizePlayerTag).filter(Boolean));

    return registeredTags.every(tag => rankedSet.has(tag));
}

async function buildCwlAggregateLeaderboardFallback(event) {
    const eventId = getEventId(event);
    const state = String(event?.cwlTrackingState || event?.cwlStatus || '').trim().toLowerCase();
    const kind = state === 'completed' ? 'final' : 'live';
    const eligibleTags = getCwlEventEligibleTagSet(event);

    if (!eligibleTags && !isLegacyCompletedTargetlessCwlEvent(event)) {
        return {
            ok: true,
            status: 'cwl-target-unresolved',
            event,
            leaderboard: [],
            aggregate: null
        };
    }
    const aggregate = eventId
        ? await rosterPublicData.readCwlSeasonEventAggregate(eventId, kind)
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
    const aggregateTags = Object.keys(byTag)
        .map(normalizePlayerTag)
        .filter(tag => tag && (!eligibleTags || eligibleTags.has(tag)));
    const registeredAccounts = getRegisteredCwlAccountRows(event);
    const rankedTags = Array.isArray(aggregate.rankedTags)
        ? aggregate.rankedTags.map(normalizePlayerTag).filter(Boolean)
        : [];
    const sourceRows = registeredAccounts.length > 0
        ? registeredAccounts
        : aggregateTags.sort((leftTag, rightTag) => compareCwlAggregateTags(byTag, leftTag, rightTag)).map(tag => ({
            participant: {},
            account: { tag, playerTag: tag, name: tag },
            tag
        }));
    const rows = sourceRows.map(({ participant, account, tag }) => {
        const stats = byTag[tag] && typeof byTag[tag] === 'object' ? byTag[tag] : {};
        const offenseStars = getCwlOffenseStars(stats);
        const defenseStarsConceded = getCwlDefenseStarsConceded(stats);
        const displayName = account?.name || getParticipantDisplayName(participant) || tag;

        return {
            rank: 0,
            tag,
            playerTag: tag,
            displayName,
            accounts: [{ ...account, tag, name: displayName, cwlStats: stats }],
            score: offenseStars,
            scoreLabel: `${offenseStars} stars, ${defenseStarsConceded} defense stars`,
            metric: 'cwl',
            coverage: byTag[tag] ? 'full' : 'no-cwl-participation',
            cwlStats: {
                ...stats,
                defenseStarsConceded,
                bestStarsConceded: defenseStarsConceded
            }
        };
    });
    if (registeredAccounts.length > 0 && shouldUseCwlAggregateRankedTags(rankedTags, registeredAccounts.map(row => row.tag))) {
        const rankIndex = new Map();
        rankedTags.forEach((tag, index) => {
            if (!rankIndex.has(tag)) {
                rankIndex.set(tag, index);
            }
        });
        rows.sort((left, right) => (rankIndex.get(left.tag) ?? Number.MAX_SAFE_INTEGER) - (rankIndex.get(right.tag) ?? Number.MAX_SAFE_INTEGER));
    } else if (registeredAccounts.length > 0) {
        rows.sort(compareCwlLeaderboardRows);
    }
    rows.forEach((row, index) => {
        row.rank = index + 1;
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

function getCwlEligibleActiveParticipants(event) {
    if (getEventType(event) !== 'cwl' || isLegacyCompletedTargetlessCwlEvent(event)) {
        return getActiveParticipants(event);
    }

    return getActiveParticipants(event)
        .map(participant => ({
            ...participant,
            accounts: filterAccountsForCwlEventTarget(event, getAccountRowsForParticipant(participant))
        }))
        .filter(participant => participant.accounts.length > 0);
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
        console.warn('Season event backend leaderboard unavailable; falling back to Cloudflare public-data scoring.', {
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

    let authoritativeEvent = options.seedEvent && typeof options.seedEvent === 'object'
        ? normalizeBackendEvent(options.seedEvent, eventType)
        : null;
    let authoritativeSource = authoritativeEvent ? 'mutation-result' : 'missing';
    let ensuredCwlEvent = null;
    let refreshedCwlEvent = null;
    if (eventType === 'cwl' && options.ensureCurrent) {
        const ensured = await rosterBackend.ensureCurrentCwlSeasonEvent({
            source: options.source || {}
        });
        ensuredCwlEvent = ensured?.event && typeof ensured.event === 'object' ? ensured.event : null;
        refreshedCwlEvent = await refreshCurrentCwlEventForRendering(options);
        authoritativeEvent = mergeEventRefreshResult(
            authoritativeEvent || ensuredCwlEvent,
            refreshedCwlEvent || (authoritativeEvent ? null : ensuredCwlEvent),
            eventType
        );
        if (authoritativeEvent) {
            authoritativeSource = 'backend';
        }
    } else if (options.reconcile && eventType !== 'cwl') {
        const reconciled = await rosterBackend.reconcileCurrentSeasonEvents({
            forceRefresh: false,
            source: options.source || {}
        });
        const reconciledEvent = getEventFromCurrentBackendResult(reconciled, eventType);

        if (reconciledEvent) {
            authoritativeEvent = mergeEventRefreshResult(authoritativeEvent, reconciledEvent, eventType);
            authoritativeSource = 'backend-reconcile';
        }
    }

    let backendCurrentReadFailed = false;
    if (!authoritativeEvent) {
        const backendCurrentRead = await readCurrentEventFromBackend(eventType, options);
        authoritativeEvent = backendCurrentRead.event;
        backendCurrentReadFailed = backendCurrentRead.failed;
        if (authoritativeEvent) {
            authoritativeSource = 'backend-current';
        }
    }

    const publicReadOptions = {
        includeParticipantsByDiscordId: true,
        cacheTtlMs: options.reconcile || options.ensureCurrent ? 0 : options.cacheTtlMs,
        timeoutMs: options.timeoutMs
    };
    let event = authoritativeEvent;

    if (!event) {
        event = await readCurrentEventFromPublicData(eventType, publicReadOptions);
    }

    let leaderboard = null;
    let source = event
        ? (authoritativeEvent ? authoritativeSource : 'cloudflare-public')
        : 'missing';

    if (event) {
        const backendResult = backendCurrentReadFailed
            ? null
            : await readBackendLeaderboardForEvent(event, eventType, options);

        if (backendResult) {
            event = backendResult.event;
            leaderboard = backendResult.leaderboard;
            source = 'backend';
        } else {
            if (authoritativeEvent && !options.seedEvent) {
                const publicEvent = await readPublicEventByKnownId(authoritativeEvent, eventType, publicReadOptions);
                event = mergeEventRefreshResult(publicEvent, authoritativeEvent, eventType);
            }

            if (eventType === 'cwl') {
                leaderboard = await buildCwlAggregateLeaderboardFallback(event);
                source = 'cloudflare-cwl-aggregate';
            } else {
                const metricsByTag = await rosterPublicData.readAllActivePlayerMetricsByTag(publicReadOptions);
                const scoringMetricsByTag = await mergeDonationRefreshOverlayForEvent(event, metricsByTag, publicReadOptions);
                leaderboard = buildLocalSeasonEventLeaderboard(event, scoringMetricsByTag, {
                    type: eventType,
                    limit: options.limit,
                    nowIso: options.nowIso
                });
            }
        }
    }

    return {
        event,
        leaderboard,
        source
    };
}

async function loadSeasonEventMutationContext(type, discordUser, options = {}) {
    const eventType = normalizeEventType(type);
    if (!eventType) return { event: null, participant: null, linkedAccounts: [], eligibleAccounts: [] };
    const result = await rosterBackend.getSeasonEventMutationContext({
        eventType,
        eventId: options.eventId || null,
        discordUser: discordUser || {},
        source: options.source || {}
    });
    return {
        event: result?.event || null,
        participant: result?.participant || null,
        linkedAccounts: Array.isArray(result?.linkedAccounts) ? result.linkedAccounts : [],
        eligibleAccounts: Array.isArray(result?.eligibleAccounts) ? result.eligibleAccounts : []
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
        const refreshedEvent = await refreshCurrentCwlEventForRendering(options);
        const ensuredEvent = ensured?.event && typeof ensured.event === 'object' ? ensured.event : null;
        if (refreshedEvent || ensuredEvent) {
            return mergeEventRefreshResult(ensuredEvent, refreshedEvent, eventType);
        }
    } else if (options.reconcile && eventType !== 'cwl') {
        const reconciled = await rosterBackend.reconcileCurrentSeasonEvents({
            forceRefresh: false,
            source: options.source || {}
        });
        const reconciledEvent = getEventFromCurrentBackendResult(reconciled, eventType);

        if (reconciledEvent) {
            return reconciledEvent;
        }
    }

    const backendCurrentRead = await readCurrentEventFromBackend(eventType, options);
    const backendEvent = backendCurrentRead.event;

    if (backendEvent) {
        return backendEvent;
    }

    return readCurrentEventFromPublicData(eventType, {
        cacheTtlMs: options.reconcile || options.ensureCurrent ? 0 : options.cacheTtlMs,
        timeoutMs: options.timeoutMs
    });
}

async function readParticipantByDiscordId(eventId, discordId) {
    return rosterPublicData.readSeasonEventParticipantByDiscordId(eventId, discordId);
}

async function readLinkedAccountsForDiscordUser(discordUser) {
    return rosterPublicData.readLinkedAccountsForDiscordUser(discordUser);
}

module.exports = {
    normalizePlayerTag,
    getEventId,
    getEventSeasonId,
    getEventType,
    getCwlEventTarget,
    isCwlEventTargetResolved,
    isLegacyCompletedTargetlessCwlEvent,
    getCwlEventEligibleTagSet,
    filterAccountsForCwlEventTarget,
    filterLinkedAccountsForEvent,
    asArray,
    getActiveParticipants,
    getCwlEligibleActiveParticipants,
    normalizeAccount,
    getAccountRowsForParticipant,
    getLeaderboardRowsByTag,
    extractLeaderboardRows,
    getEventAvailabilityStatus,
    loadEventForRendering,
    loadSeasonEventMutationContext,
    resolveCurrentSeasonEvent,
    readParticipantByDiscordId,
    readLinkedAccountsForDiscordUser
};
