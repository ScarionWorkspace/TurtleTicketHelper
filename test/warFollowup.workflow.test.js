'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');

function regularEvent(id, at, clanTag, stats) {
    return { eventId: id, warKey: id, finalizedAt: at, clanTag, stats };
}

function buildRosterData() {
    return {
        lastUpdatedAt: '2026-08-01T00:00:00.000Z',
        rosters: [{
            id: 'main',
            title: 'Main clan',
            connectedClanTag: '#MAIN',
            trackingMode: 'regularWar',
            main: [
                { tag: '#P0LYGQ', name: 'Player One', discord: 'player-one', th: 17 },
                { tag: '#P0LYGJ', name: 'Discord Gap', discord: '', th: 16 }
            ],
            subs: [],
            missing: [{ tag: '#P0LYGR', name: 'Missing row', discord: '', th: 15 }]
        }, {
            id: 'training',
            title: 'Hero-down clan',
            connectedClanTag: '#TRAIN',
            trackingMode: 'regularWar',
            main: [],
            subs: [],
            missing: [],
            regularWar: {
                currentWar: { state: 'inWar', endTime: '20260803T20:30:45.000Z' }
            }
        }],
        playerMetrics: {
            byTag: {
                '#P0LYGQ': { identity: { discordId: '111111111111111111', discordUsername: 'player-one' } }
            }
        },
        playerWarPerformance: {
            updatedAt: '2026-08-01T00:00:00.000Z',
            byTag: {
                '#P0LYGQ': {
                    recentRegularWarForm: [
                        regularEvent('rw-2', '2026-07-31T00:00:00.000Z', '#MAIN', {
                            possibleAttacks: 2,
                            usedAttacks: 1,
                            attacksMissed: 1,
                            countedAttacks: 1,
                            starsTotal: 1,
                            totalDestruction: 55
                        }),
                        regularEvent('rw-1', '2026-07-28T00:00:00.000Z', '#MAIN', {
                            possibleAttacks: 2,
                            usedAttacks: 1,
                            attacksMissed: 1,
                            countedAttacks: 1,
                            starsTotal: 1,
                            totalDestruction: 60
                        })
                    ],
                    cwlSeasonContext: {
                        bySeason: {
                            '2026-07': {
                                finalizedEventIds: ['cwl-1'],
                                stats: {
                                    possibleAttacks: 2,
                                    usedAttacks: 1,
                                    attacksMissed: 1,
                                    countedAttacks: 1,
                                    starsTotal: 1,
                                    totalDestruction: 60
                                }
                            }
                        }
                    }
                }
            }
        }
    };
}

test('Discord workflow derives the same conservative automatic signals as the admin panel', () => {
    const work = workflow.buildWorkItems(buildRosterData(), {
        settings: {
            regularMinimumAttacks: 2,
            regularMissedThreshold: 2,
            cwlMissedThreshold: 1,
            cwlMinimumAttacks: 2
        },
        cases: []
    });
    const item = work.items.find(entry => entry.tag === '#P0LYGQ');
    assert.ok(item);
    assert.deepEqual(
        item.signals.map(signal => signal.reasonCode).sort(),
        ['cwl_missed', 'regular_missed', 'regular_performance']
    );
    assert.equal(work.items.some(entry => entry.tag === '#P0LYGR'), false);
    assert.equal(item.player.discordId, '111111111111111111');
});

test('dismissed evidence stays closed until the evidence revision changes', () => {
    const data = buildRosterData();
    const first = workflow.buildWorkItems(data, { settings: {}, cases: [] });
    const initial = first.items.find(item => item.tag === '#P0LYGQ');
    const dismissedCase = {
        tag: initial.tag,
        status: 'dismissed',
        outcome: 'no_action',
        dismissedSignalIds: initial.signalIds,
        updatedAt: '2026-08-01T01:00:00.000Z'
    };
    const closed = workflow.buildWorkItems(data, { settings: {}, cases: [dismissedCase] });
    assert.equal(closed.items.find(item => item.tag === initial.tag).status, 'closed');

    data.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm.unshift(
        regularEvent('rw-3', '2026-08-02T00:00:00.000Z', '#MAIN', {
            possibleAttacks: 2,
            usedAttacks: 0,
            attacksMissed: 2
        })
    );
    const reopened = workflow.buildWorkItems(data, { settings: {}, cases: [dismissedCase] });
    assert.equal(reopened.items.find(item => item.tag === initial.tag).status, 'needs_review');
});

test('monitoring is cleanly separated from active cases and triggers only on post-watch problems', () => {
    const data = buildRosterData();
    const settings = {
        regularMissedThreshold: 2,
        regularPerformanceEnabled: false,
        cwlMissedThreshold: 8,
        cwlPerformanceEnabled: false
    };
    const initial = workflow.buildWorkItems(data, { settings, cases: [] });
    const initialItem = initial.items.find(item => item.tag === '#P0LYGQ');
    const monitoringCase = {
        tag: '#P0LYGQ',
        status: 'watching',
        watchStartedAt: '2026-08-01T00:00:00.000Z',
        watchWarTarget: 1,
        dismissedSignalIds: initialItem.signalIds,
        assignedModeratorId: '',
        handledBy: ''
    };
    data.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm.unshift(
        regularEvent('rw-clean', '2026-08-02T00:00:00.000Z', '#MAIN', {
            possibleAttacks: 2,
            usedAttacks: 2,
            countedAttacks: 2,
            starsTotal: 5,
            totalDestruction: 180
        })
    );
    const clean = workflow.buildWorkItems(data, { settings, cases: [monitoringCase] });
    assert.equal(clean.items.find(item => item.tag === '#P0LYGQ').status, 'closed');

    data.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm.unshift(
        regularEvent('rw-problem', '2026-08-03T00:00:00.000Z', '#MAIN', {
            possibleAttacks: 2,
            usedAttacks: 0,
            attacksMissed: 2
        })
    );
    const problem = workflow.buildWorkItems(data, { settings, cases: [monitoringCase] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(problem.status, 'needs_review');
    assert.equal(problem.watching.triggered, true);
    assert.deepEqual(problem.signals.map(signal => signal.reasonCode), ['regular_missed']);
});

test('confirmed removal cases retain linked identity and reopen when the player rejoins', () => {
    const data = buildRosterData();
    data.rosters[0].main = data.rosters[0].main.filter(player => player.tag !== '#P0LYGQ');
    const removalCase = {
        tag: '#P0LYGQ',
        name: 'Player One',
        discordId: '111111111111111111',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main clan',
        sourceClanTag: '#MAIN',
        status: 'removed',
        outcome: 'removed',
        contactPurpose: 'removal',
        removalAbsentObservedAt: '2026-08-02T00:00:00.000Z'
    };
    const absent = workflow.buildWorkItems(data, { settings: {}, cases: [removalCase] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(absent.status, 'closed');
    assert.equal(absent.player.discordId, '111111111111111111');

    data.rosters[1].main.push({ tag: '#P0LYGQ', name: 'Player One', th: 17 });
    const rejoined = workflow.buildWorkItems(data, { settings: {}, cases: [removalCase] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(rejoined.status, 'needs_review');
});

test('trusted accounts are excluded from work and Discord gaps', () => {
    const work = workflow.buildWorkItems(buildRosterData(), {
        settings: { trustedPlayerTags: ['#P0LYGQ', '#P0LYGJ'] },
        cases: [{ tag: '#P0LYGQ', status: 'needs_review' }]
    });
    assert.equal(work.items.some(item => item.tag === '#P0LYGQ'), false);
    assert.equal(work.directory.byTag['#P0LYGJ'].trusted, true);
});

test('hero-down recovery requires consecutive clean wars in the selected clan', () => {
    const recovery = workflow.buildRecoveryProgress({
        tag: '#P0LYGQ',
        status: 'hero_down',
        recoveryStartedAt: '2026-08-01T00:00:00.000Z',
        targetClanTag: '#TRAIN',
        recoveryWarTarget: 2,
        requireNoMisses: true
    }, {
        regularEvents: [
            { id: 'a', at: '2026-08-02T00:00:00.000Z', clanTag: '#TRAIN', stats: { possibleAttacks: 2, usedAttacks: 2 } },
            { id: 'b', at: '2026-08-03T00:00:00.000Z', clanTag: '#TRAIN', stats: { possibleAttacks: 2, usedAttacks: 1, attacksMissed: 1 } },
            { id: 'c', at: '2026-08-04T00:00:00.000Z', clanTag: '#TRAIN', stats: { possibleAttacks: 2, usedAttacks: 2 } },
            { id: 'other', at: '2026-08-05T00:00:00.000Z', clanTag: '#MAIN', stats: { possibleAttacks: 2, usedAttacks: 2 } }
        ]
    });
    assert.equal(recovery.completedWars, 1);
    assert.equal(recovery.ready, false);
    assert.equal(recovery.totalWars, 3);
});

test('decision DM includes exact evidence, target link, timing, and recovery requirement', () => {
    const message = workflow.buildDmText({
        playerName: 'Player One',
        sourceClan: 'Main clan',
        targetClan: 'Hero-down clan',
        targetClanTag: '#TRAIN',
        nextWarStartAt: '20260803T203045.000Z',
        recoveryWars: 3,
        reasonCodes: ['regular_missed'],
        evidence: { regular: { possibleAttacks: 6, missedAttacks: 2 } }
    });
    assert.match(message, /2 of 6 available attacks/);
    assert.match(message, /3 consecutive wars/);
    assert.match(message, /<t:\d+:R>/);
    assert.match(message, /OpenClanProfile/);
});
