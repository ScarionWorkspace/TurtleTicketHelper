const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterFirebase = require('../src/features/rosterFirebase/rosterFirebaseReadClient');
const {
    loadEventForRendering
} = require('../src/features/seasonEvents/eventData');

const originalBackend = {
    isRosterBackendConfigured: rosterBackend.isRosterBackendConfigured,
    getSeasonEventLeaderboard: rosterBackend.getSeasonEventLeaderboard,
    reconcileCurrentSeasonEvents: rosterBackend.reconcileCurrentSeasonEvents,
    ensureCurrentCwlSeasonEvent: rosterBackend.ensureCurrentCwlSeasonEvent,
    refreshCurrentCwlSeasonEvent: rosterBackend.refreshCurrentCwlSeasonEvent
};
const originalFirebase = {
    readCurrentSeasonEventPointer: rosterFirebase.readCurrentSeasonEventPointer,
    readCurrentCwlSeasonEventPointer: rosterFirebase.readCurrentCwlSeasonEventPointer,
    readSeasonEventById: rosterFirebase.readSeasonEventById,
    readCwlSeasonEventAggregate: rosterFirebase.readCwlSeasonEventAggregate,
    readAllActivePlayerMetricsByTag: rosterFirebase.readAllActivePlayerMetricsByTag,
    readDonationRefreshSeasonOverlay: rosterFirebase.readDonationRefreshSeasonOverlay
};

afterEach(() => {
    Object.assign(rosterBackend, originalBackend);
    Object.assign(rosterFirebase, originalFirebase);
});

test('loadEventForRendering uses backend leaderboard before local Firebase scoring', async () => {
    let backendPayload = null;
    let metricsRead = false;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        backendPayload = payload;

        return {
            event: {
                eventId: 'push-ranked-legend-i-2026-05-18',
                type: 'push',
                seasonId: 'ranked-legend-i-2026-05-18',
                participantCount: 2,
                activeParticipantCount: 1,
                accountCount: 1
            },
            leaderboard: [{
                rank: 1,
                displayName: 'Demoted Player',
                score: 5800,
                scoreLabel: 'Legends II - 5800 trophies',
                currentLeagueName: 'Legends II',
                currentTrophies: 5800,
                accounts: [{
                    tag: '#AAA111',
                    name: 'Demoted Player',
                    score: 5800,
                    scoreLabel: 'Legends II - 5800 trophies',
                    currentLeagueName: 'Legends II',
                    currentTrophies: 5800
                }]
            }]
        };
    };
    rosterFirebase.readCurrentSeasonEventPointer = async () => ({
        eventId: 'push-ranked-legend-i-2026-05-18',
        seasonId: 'ranked-legend-i-2026-05-18'
    });
    rosterFirebase.readSeasonEventById = async () => ({
        eventId: 'push-ranked-legend-i-2026-05-18',
        type: 'push',
        seasonId: 'ranked-legend-i-2026-05-18',
        status: 'open',
        signupsOpen: true,
        startsAt: '2026-05-18T05:00:00.000Z',
        endsAt: '2026-06-15T05:00:00.000Z',
        participantsByDiscordId: {
            user1: {
                discordId: 'user1',
                discordUsername: 'demoted',
                status: 'signed_up',
                accounts: [{ tag: '#AAA111', name: 'Demoted Player' }]
            }
        }
    });
    rosterFirebase.readAllActivePlayerMetricsByTag = async () => {
        metricsRead = true;
        throw new Error('local metrics should not be read when backend leaderboard succeeds');
    };

    const result = await loadEventForRendering('push', {
        limit: 10,
        nowIso: '2026-05-20T12:00:00.000Z',
        source: { type: 'test' }
    });

    assert.equal(result.source, 'backend');
    assert.equal(metricsRead, false);
    assert.equal(backendPayload.eventId, 'push-ranked-legend-i-2026-05-18');
    assert.equal(backendPayload.limit, 10);
    assert.equal(backendPayload.nowIso, '2026-05-20T12:00:00.000Z');
    assert.deepEqual(backendPayload.source, { type: 'test' });
    assert.equal(result.event.activeParticipantCount, 1);
    assert.equal(result.event.participantsByDiscordId.user1.accounts[0].tag, '#AAA111');
    assert.equal(result.leaderboard.leaderboard[0].scoreLabel, 'Legends II - 5800 trophies');
});

test('loadEventForRendering refreshes ensured CWL event before rendering signup message', async () => {
    const calls = [];
    const source = { type: 'test-cwl-signup' };
    const waitingEvent = {
        eventId: 'cwl-2026-07-04',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'waiting',
        participantsByDiscordId: {
            user1: {
                discordId: 'user1',
                discordUsername: 'alpha',
                status: 'signed_up',
                accounts: [{ tag: '#AAA111', name: 'Alpha' }]
            }
        }
    };
    const activeEvent = {
        eventId: 'cwl-2026-07-04',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'active',
        startsAt: '2026-07-04T03:20:17.000Z',
        endsAt: '2026-07-06T08:01:20.000Z'
    };

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.ensureCurrentCwlSeasonEvent = async payload => {
        calls.push({ method: 'ensure', payload });
        return { event: waitingEvent };
    };
    rosterBackend.refreshCurrentCwlSeasonEvent = async payload => {
        calls.push({ method: 'refresh', payload });
        return { event: activeEvent };
    };
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        calls.push({ method: 'leaderboard', payload });
        return {
            event: {
                eventId: activeEvent.eventId,
                type: 'cwl',
                cwlTrackingState: 'active',
                startsAt: activeEvent.startsAt,
                endsAt: activeEvent.endsAt
            },
            leaderboard: [{
                rank: 1,
                displayName: 'Alpha',
                score: 15,
                scoreLabel: '15 stars, 2 holds',
                accounts: [{ tag: '#AAA111', name: 'Alpha' }]
            }]
        };
    };
    rosterFirebase.readCurrentCwlSeasonEventPointer = async () => ({
        eventId: waitingEvent.eventId
    });
    rosterFirebase.readSeasonEventById = async () => waitingEvent;

    const result = await loadEventForRendering('cwl', {
        ensureCurrent: true,
        source
    });

    assert.deepEqual(calls.map(call => call.method), ['ensure', 'refresh', 'leaderboard']);
    assert.deepEqual(calls[0].payload.source, source);
    assert.deepEqual(calls[1].payload.source, source);
    assert.equal(calls[2].payload.eventId, activeEvent.eventId);
    assert.equal(result.source, 'backend');
    assert.equal(result.event.cwlTrackingState, 'active');
    assert.equal(result.event.startsAt, activeEvent.startsAt);
    assert.equal(result.event.participantsByDiscordId.user1.accounts[0].tag, '#AAA111');
    assert.equal(result.leaderboard.leaderboard[0].scoreLabel, '15 stars, 2 holds');
});

test('loadEventForRendering keeps CWL signup usable when immediate refresh fails', async () => {
    rosterBackend.isRosterBackendConfigured = () => false;
    rosterBackend.ensureCurrentCwlSeasonEvent = async () => ({
        event: {
            eventId: 'cwl-waiting',
            type: 'cwl',
            status: 'open',
            signupsOpen: true,
            cwlTrackingState: 'waiting'
        }
    });
    rosterBackend.refreshCurrentCwlSeasonEvent = async () => {
        const error = new Error('temporary Clash API failure');
        error.code = 'CLASH_API_UNAVAILABLE';
        throw error;
    };
    rosterBackend.getSeasonEventLeaderboard = async () => {
        throw new Error('backend leaderboard should not be requested when backend is disabled');
    };
    rosterFirebase.readCurrentCwlSeasonEventPointer = async () => null;
    rosterFirebase.readCwlSeasonEventAggregate = async () => null;

    const result = await loadEventForRendering('cwl', {
        ensureCurrent: true,
        source: { type: 'test-cwl-signup' }
    });

    assert.equal(result.event.eventId, 'cwl-waiting');
    assert.equal(result.event.cwlTrackingState, 'waiting');
    assert.equal(result.source, 'firebase-cwl-aggregate');
    assert.deepEqual(result.leaderboard.leaderboard, []);
});

test('loadEventForRendering merges donation overlay into local Firebase fallback scoring', async () => {
    rosterBackend.isRosterBackendConfigured = () => false;
    rosterFirebase.readCurrentSeasonEventPointer = async () => ({
        eventId: 'donation-ranked-legend-i-2026-05-18',
        seasonId: 'ranked-legend-i-2026-05-18'
    });
    rosterFirebase.readSeasonEventById = async () => ({
        eventId: 'donation-ranked-legend-i-2026-05-18',
        type: 'donation',
        seasonId: 'ranked-legend-i-2026-05-18',
        status: 'open',
        signupsOpen: true,
        startsAt: '2026-05-18T05:00:00.000Z',
        endsAt: '2026-06-15T05:00:00.000Z',
        participantsByDiscordId: {
            user1: {
                discordId: 'user1',
                discordUsername: 'alpha',
                discordDisplayName: 'Alpha',
                status: 'signed_up',
                accounts: [{ tag: '#AAA111', name: 'Alpha' }]
            }
        }
    });
    rosterFirebase.readAllActivePlayerMetricsByTag = async () => ({
        '#AAA111': {
            identity: { tag: '#AAA111', name: 'Alpha' },
            donationCycles: {
                'ranked-legend-i-2026-05-18': {
                    startsAt: '2026-05-18T05:00:00.000Z',
                    endsAt: '2026-06-15T05:00:00.000Z',
                    cycleTotalDonations: 10,
                    lastSeenAt: '2026-05-20T00:00:00.000Z'
                }
            }
        }
    });
    rosterFirebase.readDonationRefreshSeasonOverlay = async seasonId => {
        assert.equal(seasonId, 'ranked-legend-i-2026-05-18');

        return {
            byTag: {
                '#AAA111': {
                    tag: '#AAA111',
                    name: 'Alpha',
                    donationCycle: {
                        startsAt: '2026-05-18T05:00:00.000Z',
                        endsAt: '2026-06-15T05:00:00.000Z',
                        cycleTotalDonations: 55,
                        lastSeenAt: '2026-05-25T00:00:00.000Z'
                    }
                }
            }
        };
    };

    const result = await loadEventForRendering('donation', {
        limit: 10,
        nowIso: '2026-05-25T12:00:00.000Z'
    });

    assert.equal(result.source, 'firebase');
    assert.equal(result.leaderboard.leaderboard[0].displayName, 'Alpha');
    assert.equal(result.leaderboard.leaderboard[0].score, 55);
});
