const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const {
    loadEventForRendering,
    resolveCurrentSeasonEvent
} = require('../src/features/seasonEvents/eventData');
const { buildSignupMessage } = require('../src/features/seasonEvents/renderSignupMessage');

const originalBackend = {
    isRosterBackendConfigured: rosterBackend.isRosterBackendConfigured,
    getSeasonEventLeaderboard: rosterBackend.getSeasonEventLeaderboard,
    reconcileCurrentSeasonEvents: rosterBackend.reconcileCurrentSeasonEvents,
    getCurrentSeasonEvents: rosterBackend.getCurrentSeasonEvents,
    getCurrentCwlSeasonEvent: rosterBackend.getCurrentCwlSeasonEvent,
    ensureCurrentCwlSeasonEvent: rosterBackend.ensureCurrentCwlSeasonEvent,
    refreshCurrentCwlSeasonEvent: rosterBackend.refreshCurrentCwlSeasonEvent
};
const originalPublicData = {
    readCurrentSeasonEventPointer: rosterPublicData.readCurrentSeasonEventPointer,
    readCurrentCwlSeasonEventPointer: rosterPublicData.readCurrentCwlSeasonEventPointer,
    readSeasonEventById: rosterPublicData.readSeasonEventById,
    readCwlSeasonEventAggregate: rosterPublicData.readCwlSeasonEventAggregate,
    readAllActivePlayerMetricsByTag: rosterPublicData.readAllActivePlayerMetricsByTag,
    readDonationRefreshSeasonOverlay: rosterPublicData.readDonationRefreshSeasonOverlay
};

afterEach(() => {
    Object.assign(rosterBackend, originalBackend);
    Object.assign(rosterPublicData, originalPublicData);
});

test('loadEventForRendering uses backend leaderboard before local Cloudflare public-data scoring', async () => {
    let backendPayload = null;
    let metricsRead = false;
    let publicPointerRead = false;
    let publicEventRead = false;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getCurrentSeasonEvents = async () => ({
        events: {
            push: {
                eventId: 'push-ranked-legend-i-2026-05-18',
                type: 'push',
                seasonId: 'ranked-legend-i-2026-05-18',
                status: 'open',
                signupsOpen: true,
                startsAt: '2026-05-18T05:00:00.000Z',
                endsAt: '2026-06-15T05:00:00.000Z',
                participantCount: 2,
                activeParticipantCount: 1,
                accountCount: 1
            }
        }
    });
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
    rosterPublicData.readCurrentSeasonEventPointer = async () => {
        publicPointerRead = true;
        throw new Error('Cloudflare current pointer should not be required');
    };
    rosterPublicData.readSeasonEventById = async () => {
        publicEventRead = true;
        throw new Error('Cloudflare event should not be required');
    };
    rosterPublicData.readAllActivePlayerMetricsByTag = async () => {
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
    assert.equal(publicPointerRead, false);
    assert.equal(publicEventRead, false);
    assert.equal(backendPayload.eventId, 'push-ranked-legend-i-2026-05-18');
    assert.equal(backendPayload.limit, 10);
    assert.equal(backendPayload.nowIso, '2026-05-20T12:00:00.000Z');
    assert.deepEqual(backendPayload.source, { type: 'test' });
    assert.equal(result.event.activeParticipantCount, 1);
    assert.equal(result.leaderboard.leaderboard[0].scoreLabel, 'Legends II - 5800 trophies');
});

test('loadEventForRendering uses the reconciled donation event before queued Cloudflare publication', async () => {
    let requestedEventId = null;
    let currentBackendRead = false;
    let publicPointerRead = false;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.reconcileCurrentSeasonEvents = async () => ({
        events: {
            donation: {
                eventId: 'donation-current-season',
                type: 'donation',
                seasonId: 'current-season',
                status: 'open',
                signupsOpen: true,
                participantCount: 1,
                activeParticipantCount: 1,
                accountCount: 1
            }
        },
        cloudflarePublish: {
            ok: true,
            pending: true
        }
    });
    rosterBackend.getCurrentSeasonEvents = async () => {
        currentBackendRead = true;
        throw new Error('reconciliation result should already be authoritative');
    };
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        requestedEventId = payload.eventId;
        return {
            event: {
                eventId: 'donation-current-season',
                type: 'donation',
                seasonId: 'current-season',
                status: 'open',
                signupsOpen: true,
                participantCount: 1,
                activeParticipantCount: 1,
                accountCount: 1
            },
            leaderboard: [{
                rank: 1,
                displayName: 'Current Player',
                score: 120,
                accounts: [{ tag: '#CURRENT', name: 'Current Player', score: 120 }]
            }]
        };
    };
    rosterPublicData.readCurrentSeasonEventPointer = async () => {
        publicPointerRead = true;
        return { eventId: 'donation-old-season' };
    };

    const result = await loadEventForRendering('donation', {
        reconcile: true,
        source: { type: 'test-reconcile' }
    });

    assert.equal(requestedEventId, 'donation-current-season');
    assert.equal(currentBackendRead, false);
    assert.equal(publicPointerRead, false);
    assert.equal(result.source, 'backend');
    assert.equal(result.event.eventId, 'donation-current-season');
    assert.equal(result.leaderboard.leaderboard[0].displayName, 'Current Player');

    const message = buildSignupMessage('donation', result.event, result.leaderboard);
    const confirmedField = message.embeds[0].toJSON().fields.find(field => field.name.startsWith('Confirmed Signups'));
    assert.match(confirmedField.value, /Current Player/);
    assert.match(confirmedField.value, /120/);
});

for (const eventType of ['push', 'donation']) {
    test(`loadEventForRendering falls back to Cloudflare when ${eventType} reconciliation needs backend reauthorization`, async () => {
        let backendCurrentRead = false;
        let backendLeaderboardRead = false;
        const originalWarn = console.warn;

        rosterBackend.isRosterBackendConfigured = () => true;
        rosterBackend.reconcileCurrentSeasonEvents = async () => {
            const error = new Error('Apps Script owner authorization is required');
            error.code = 'BACKEND_AUTHORIZATION_REQUIRED';
            error.status = 403;
            throw error;
        };
        rosterBackend.getCurrentSeasonEvents = async () => {
            backendCurrentRead = true;
            throw new Error('failed reconciliation must suppress another backend current-event call');
        };
        rosterBackend.getSeasonEventLeaderboard = async () => {
            backendLeaderboardRead = true;
            throw new Error('failed reconciliation must suppress another backend leaderboard call');
        };
        rosterPublicData.readCurrentSeasonEventPointer = async type => {
            assert.equal(type, eventType);
            return { eventId: `${eventType}-cloudflare-current` };
        };
        rosterPublicData.readSeasonEventById = async eventId => ({
            eventId,
            type: eventType,
            seasonId: 'fallback-season',
            status: 'open',
            signupsOpen: true,
            participantsByDiscordId: {}
        });
        rosterPublicData.readAllActivePlayerMetricsByTag = async () => ({});
        rosterPublicData.readDonationRefreshSeasonOverlay = async () => null;

        console.warn = () => {};
        try {
            const result = await loadEventForRendering(eventType, {
                reconcile: true,
                source: { type: 'discord-admin' }
            });

            assert.equal(result.event.eventId, `${eventType}-cloudflare-current`);
            assert.equal(result.source, 'cloudflare-public');
            assert.equal(backendCurrentRead, false);
            assert.equal(backendLeaderboardRead, false);
        } finally {
            console.warn = originalWarn;
        }
    });
}

test('loadEventForRendering prefers the authoritative backend current event over a stale Cloudflare pointer', async () => {
    let requestedEventId = null;
    let publicPointerRead = false;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getCurrentSeasonEvents = async () => ({
        events: {
            donation: {
                eventId: 'donation-new-season',
                type: 'donation',
                seasonId: 'new-season',
                status: 'open',
                signupsOpen: true,
                participantCount: 2,
                activeParticipantCount: 2,
                accountCount: 2
            }
        }
    });
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        requestedEventId = payload.eventId;
        return {
            event: {
                eventId: payload.eventId,
                type: 'donation',
                activeParticipantCount: 2,
                accountCount: 2
            },
            leaderboard: [{
                rank: 1,
                displayName: 'Fresh Player',
                score: 80,
                accounts: [{ tag: '#FRESH', name: 'Fresh Player', score: 80 }]
            }]
        };
    };
    rosterPublicData.readCurrentSeasonEventPointer = async () => {
        publicPointerRead = true;
        return { eventId: 'donation-old-season' };
    };

    const result = await loadEventForRendering('donation');

    assert.equal(requestedEventId, 'donation-new-season');
    assert.equal(publicPointerRead, false);
    assert.equal(result.event.eventId, 'donation-new-season');
    assert.equal(result.leaderboard.leaderboard.length, 1);
});

test('loadEventForRendering falls back to Cloudflare scoring without retrying a failed backend read', async () => {
    let leaderboardBackendRead = false;
    const originalWarn = console.warn;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getCurrentSeasonEvents = async () => {
        throw new Error('temporary backend read failure');
    };
    rosterBackend.getSeasonEventLeaderboard = async () => {
        leaderboardBackendRead = true;
        throw new Error('the failed backend should not be retried during the same render');
    };
    rosterPublicData.readCurrentSeasonEventPointer = async () => ({
        eventId: 'donation-cloudflare-fallback'
    });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'donation-cloudflare-fallback',
        type: 'donation',
        seasonId: 'fallback-season',
        status: 'open',
        signupsOpen: true,
        startsAt: '2026-07-01T00:00:00.000Z',
        endsAt: '2026-08-01T00:00:00.000Z',
        participantsByDiscordId: {
            fallbackUser: {
                discordId: 'fallbackUser',
                discordUsername: 'fallback-player',
                status: 'signed_up',
                accounts: [{ tag: '#FALLBACK', name: 'Fallback Player' }]
            }
        }
    });
    rosterPublicData.readAllActivePlayerMetricsByTag = async () => ({
        '#FALLBACK': {
            identity: {
                tag: '#FALLBACK',
                name: 'Fallback Player'
            },
            donationCycles: {
                'fallback-season': {
                    startsAt: '2026-07-01T00:00:00.000Z',
                    endsAt: '2026-08-01T00:00:00.000Z',
                    cycleTotalDonations: 44
                }
            }
        }
    });
    rosterPublicData.readDonationRefreshSeasonOverlay = async () => null;

    console.warn = () => {};
    try {
        const result = await loadEventForRendering('donation', {
            nowIso: '2026-07-12T12:00:00.000Z'
        });

        assert.equal(leaderboardBackendRead, false);
        assert.equal(result.source, 'cloudflare-public');
        assert.equal(result.event.eventId, 'donation-cloudflare-fallback');
        assert.equal(result.leaderboard.leaderboard.length, 1);
        assert.equal(result.leaderboard.leaderboard[0].score, 44);
    } finally {
        console.warn = originalWarn;
    }
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
                scoreLabel: '15 stars, 4 defense stars',
                accounts: [{ tag: '#AAA111', name: 'Alpha' }]
            }]
        };
    };
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => ({
        eventId: waitingEvent.eventId
    });
    rosterPublicData.readSeasonEventById = async () => waitingEvent;

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
    assert.equal(result.leaderboard.leaderboard[0].scoreLabel, '15 stars, 4 defense stars');
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
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => null;
    rosterPublicData.readCwlSeasonEventAggregate = async () => null;

    const result = await loadEventForRendering('cwl', {
        ensureCurrent: true,
        source: { type: 'test-cwl-signup' }
    });

    assert.equal(result.event.eventId, 'cwl-waiting');
    assert.equal(result.event.cwlTrackingState, 'waiting');
    assert.equal(result.source, 'cloudflare-cwl-aggregate');
    assert.deepEqual(result.leaderboard.leaderboard, []);
});

test('loadEventForRendering still reads a healthy backend leaderboard after a Clash-only CWL refresh failure', async () => {
    const originalWarn = console.warn;
    let leaderboardReads = 0;
    const waitingEvent = {
        eventId: 'cwl-waiting-with-stored-scores',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'waiting',
        participantsByDiscordId: {}
    };

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.ensureCurrentCwlSeasonEvent = async () => ({ event: waitingEvent });
    rosterBackend.refreshCurrentCwlSeasonEvent = async () => {
        const error = new Error('temporary Clash API failure');
        error.code = 'CLASH_API_UNAVAILABLE';
        throw error;
    };
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        leaderboardReads += 1;
        assert.equal(payload.eventId, waitingEvent.eventId);
        return {
            event: waitingEvent,
            leaderboard: [{
                rank: 1,
                displayName: 'Stored player',
                score: 12,
                accounts: []
            }]
        };
    };

    console.warn = () => {};
    try {
        const result = await loadEventForRendering('cwl', {
            ensureCurrent: true,
            source: { type: 'test-cwl-signup' }
        });

        assert.equal(leaderboardReads, 1);
        assert.equal(result.source, 'backend');
        assert.equal(result.event.eventId, waitingEvent.eventId);
        assert.equal(result.leaderboard.leaderboard[0].score, 12);
    } finally {
        console.warn = originalWarn;
    }
});

test('loadEventForRendering falls back to Cloudflare when CWL ensure needs backend reauthorization', async () => {
    let refreshAttempted = false;
    let backendCurrentRead = false;
    let backendLeaderboardRead = false;
    const originalWarn = console.warn;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.ensureCurrentCwlSeasonEvent = async () => {
        const error = new Error('Apps Script owner authorization is required');
        error.code = 'BACKEND_AUTHORIZATION_REQUIRED';
        error.status = 403;
        throw error;
    };
    rosterBackend.refreshCurrentCwlSeasonEvent = async () => {
        refreshAttempted = true;
        throw new Error('ensure failure must suppress the dependent refresh call');
    };
    rosterBackend.getCurrentCwlSeasonEvent = async () => {
        backendCurrentRead = true;
        throw new Error('ensure failure must suppress another backend current-event call');
    };
    rosterBackend.getSeasonEventLeaderboard = async () => {
        backendLeaderboardRead = true;
        throw new Error('ensure failure must suppress another backend leaderboard call');
    };
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => ({ eventId: 'cwl-cloudflare-current' });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'cwl-cloudflare-current',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'waiting',
        participantsByDiscordId: {}
    });
    rosterPublicData.readCwlSeasonEventAggregate = async () => null;

    console.warn = () => {};
    try {
        const result = await loadEventForRendering('cwl', {
            ensureCurrent: true,
            source: { type: 'discord-admin' }
        });

        assert.equal(result.event.eventId, 'cwl-cloudflare-current');
        assert.equal(result.source, 'cloudflare-cwl-aggregate');
        assert.equal(refreshAttempted, false);
        assert.equal(backendCurrentRead, false);
        assert.equal(backendLeaderboardRead, false);
    } finally {
        console.warn = originalWarn;
    }
});

test('resolveCurrentSeasonEvent falls back directly to Cloudflare after reconciliation authorization failure', async () => {
    let backendCurrentRead = false;
    const originalWarn = console.warn;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.reconcileCurrentSeasonEvents = async () => {
        const error = new Error('Apps Script owner authorization is required');
        error.code = 'BACKEND_AUTHORIZATION_REQUIRED';
        error.status = 403;
        throw error;
    };
    rosterBackend.getCurrentSeasonEvents = async () => {
        backendCurrentRead = true;
        throw new Error('failed reconciliation must suppress another backend read');
    };
    rosterPublicData.readCurrentSeasonEventPointer = async () => ({ eventId: 'push-cloudflare-current' });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'push-cloudflare-current',
        type: 'push',
        status: 'open',
        signupsOpen: true
    });

    console.warn = () => {};
    try {
        const event = await resolveCurrentSeasonEvent('push', {
            reconcile: true,
            source: { type: 'discord-admin' }
        });

        assert.equal(event.eventId, 'push-cloudflare-current');
        assert.equal(backendCurrentRead, false);
    } finally {
        console.warn = originalWarn;
    }
});

test('resolveCurrentSeasonEvent falls back directly to Cloudflare after CWL ensure authorization failure', async () => {
    let refreshAttempted = false;
    let backendCurrentRead = false;
    const originalWarn = console.warn;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.ensureCurrentCwlSeasonEvent = async () => {
        const error = new Error('Apps Script owner authorization is required');
        error.code = 'BACKEND_AUTHORIZATION_REQUIRED';
        error.status = 403;
        throw error;
    };
    rosterBackend.refreshCurrentCwlSeasonEvent = async () => {
        refreshAttempted = true;
        throw new Error('ensure failure must suppress the dependent refresh call');
    };
    rosterBackend.getCurrentCwlSeasonEvent = async () => {
        backendCurrentRead = true;
        throw new Error('failed ensure must suppress another backend read');
    };
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => ({ eventId: 'cwl-cloudflare-current' });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'cwl-cloudflare-current',
        type: 'cwl',
        status: 'open',
        signupsOpen: true
    });

    console.warn = () => {};
    try {
        const event = await resolveCurrentSeasonEvent('cwl', {
            ensureCurrent: true,
            source: { type: 'discord-admin' }
        });

        assert.equal(event.eventId, 'cwl-cloudflare-current');
        assert.equal(refreshAttempted, false);
        assert.equal(backendCurrentRead, false);
    } finally {
        console.warn = originalWarn;
    }
});

test('loadEventForRendering recomputes CWL fallback rows from current registrations when ranked tags are stale', async () => {
    rosterBackend.isRosterBackendConfigured = () => false;
    rosterBackend.getSeasonEventLeaderboard = async () => {
        throw new Error('backend leaderboard should not be requested when backend is disabled');
    };
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => ({
        eventId: 'cwl-active'
    });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'cwl-active',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'active',
        cwl: {
            target: {
                resolved: true,
                status: 'resolved',
                rosterId: 'main',
                clanTag: '#CLAN',
                leagueName: 'Champion I',
                eligibleAccountTags: ['#AAA', '#BBB']
            }
        },
        participantsByDiscordId: {
            user1: {
                discordId: 'user1',
                discordDisplayName: 'Old Signup',
                status: 'signed_up',
                accounts: [{ tag: '#AAA', name: 'Old Account' }]
            },
            user2: {
                discordId: 'user2',
                discordDisplayName: 'New Signup',
                status: 'signed_up',
                accounts: [{ tag: '#BBB', name: 'New Account' }]
            }
        }
    });
    rosterPublicData.readCwlSeasonEventAggregate = async () => ({
        eventId: 'cwl-active',
        kind: 'live',
        rankedTags: ['#AAA'],
        byTag: {
            '#AAA': { starsTotal: 1, attacksMade: 1, defenseStarsConceded: 2 },
            '#BBB': { starsTotal: 3, attacksMade: 1, defenseStarsConceded: 1 }
        }
    });

    const result = await loadEventForRendering('cwl', {
        source: { type: 'test-cwl-fallback' }
    });

    assert.equal(result.source, 'cloudflare-cwl-aggregate');
    assert.deepEqual(result.leaderboard.leaderboard.map(row => row.tag), ['#BBB', '#AAA']);
    assert.equal(result.leaderboard.leaderboard[0].rank, 1);
    assert.equal(result.leaderboard.leaderboard[0].displayName, 'New Account');
    assert.equal(result.leaderboard.leaderboard[0].scoreLabel, '3 stars, 1 defense stars');
});

test('loadEventForRendering scopes CWL fallback rows to the resolved event roster', async () => {
    rosterBackend.isRosterBackendConfigured = () => false;
    rosterBackend.getSeasonEventLeaderboard = async () => null;
    rosterPublicData.readCurrentCwlSeasonEventPointer = async () => ({
        eventId: 'cwl-targeted'
    });
    rosterPublicData.readSeasonEventById = async () => ({
        eventId: 'cwl-targeted',
        type: 'cwl',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'active',
        cwl: {
            target: {
                resolved: true,
                status: 'resolved',
                rosterId: 'main',
                clanTag: '#CLAN',
                leagueName: 'Champion I',
                eligibleAccountTags: ['#AAA']
            }
        },
        participantsByDiscordId: {
            mixed: {
                discordId: 'mixed',
                discordDisplayName: 'Mixed',
                status: 'signed_up',
                accounts: [{ tag: '#AAA', name: 'Target' }, { tag: '#BBB', name: 'Dormant' }]
            },
            dormant: {
                discordId: 'dormant',
                discordDisplayName: 'Dormant',
                status: 'signed_up',
                accounts: [{ tag: '#BBB', name: 'Wrong Clan' }]
            }
        }
    });
    rosterPublicData.readCwlSeasonEventAggregate = async () => ({
        eventId: 'cwl-targeted',
        kind: 'live',
        rankedTags: ['#BBB', '#AAA'],
        byTag: {
            '#AAA': { starsTotal: 3, attacksMade: 1, defenseStarsConceded: 2 },
            '#BBB': { starsTotal: 9, attacksMade: 3, defenseStarsConceded: 1 }
        }
    });

    const result = await loadEventForRendering('cwl');

    assert.equal(result.source, 'cloudflare-cwl-aggregate');
    assert.deepEqual(result.leaderboard.leaderboard.map(row => row.tag), ['#AAA']);
    assert.equal(result.leaderboard.leaderboard[0].displayName, 'Target');
});

test('loadEventForRendering merges donation overlay into local public-data fallback scoring', async () => {
    rosterBackend.isRosterBackendConfigured = () => false;
    rosterPublicData.readCurrentSeasonEventPointer = async () => ({
        eventId: 'donation-ranked-legend-i-2026-05-18',
        seasonId: 'ranked-legend-i-2026-05-18'
    });
    rosterPublicData.readSeasonEventById = async () => ({
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
    rosterPublicData.readAllActivePlayerMetricsByTag = async () => ({
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
    rosterPublicData.readDonationRefreshSeasonOverlay = async seasonId => {
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

    assert.equal(result.source, 'cloudflare-public');
    assert.equal(result.leaderboard.leaderboard[0].displayName, 'Alpha');
    assert.equal(result.leaderboard.leaderboard[0].score, 55);
});
