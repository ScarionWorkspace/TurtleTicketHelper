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
    reconcileCurrentSeasonEvents: rosterBackend.reconcileCurrentSeasonEvents
};
const originalFirebase = {
    readCurrentSeasonEventPointer: rosterFirebase.readCurrentSeasonEventPointer,
    readSeasonEventById: rosterFirebase.readSeasonEventById,
    readAllActivePlayerMetricsByTag: rosterFirebase.readAllActivePlayerMetricsByTag
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
