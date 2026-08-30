'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');

function regularEvent(id, at, clanTag, stats) {
    return { eventId: id, warKey: id, finalizedAt: at, clanTag, stats };
}

function contextualRegularEvent(id, options = {}) {
    const stars = options.stars ?? 2;
    const destruction = options.destruction ?? 80;
    const playerTownHallLevel = options.playerTownHallLevel ?? 15;
    const playerMapPosition = options.playerMapPosition ?? 5;
    const mirrorStarsBefore = options.mirrorStarsBefore ?? (options.forcedHardTarget ? 3 : 0);
    const targetTownHallLevel = options.targetTownHallLevel ?? (options.forcedHardTarget ? playerTownHallLevel + 2 : playerTownHallLevel);
    const hitMirror = options.hitMirror ?? !options.forcedHardTarget;
    const ownAttackOrdinal = options.ownAttackOrdinal ?? 2;
    const maxOwnAttacks = options.maxOwnAttacks ?? 20;
    return {
        id,
        legacyIds: [],
        label: id,
        at: options.at || `2026-08-${String(options.day ?? 1).padStart(2, '0')}T00:00:00.000Z`,
        clanTag: '#MAIN',
        stats: {
            warCount: 1,
            possibleAttacks: 2,
            usedAttacks: 1,
            missedAttacks: 0,
            countedAttacks: 1,
            starsTotal: stars,
            totalDestruction: destruction,
            threeStarCount: stars === 3 ? 1 : 0,
            hitUpCount: targetTownHallLevel > playerTownHallLevel ? 1 : 0,
            sameThHitCount: targetTownHallLevel === playerTownHallLevel ? 1 : 0,
            hitDownCount: targetTownHallLevel < playerTownHallLevel ? 1 : 0
        },
        context: {
            schemaVersion: 1,
            teamSize: 10,
            attacksPerMember: 2,
            playerMapPosition,
            playerTownHallLevel,
            mirrorTownHallLevel: playerTownHallLevel,
            lineupMedianTownHall: options.lineupMedianTownHall ?? playerTownHallLevel,
            totalOwnAttacksMade: maxOwnAttacks,
            maxOwnAttacks,
            attacks: [{
                attackNumber: 1,
                order: ownAttackOrdinal,
                ownAttackOrdinal,
                targetMapPosition: hitMirror ? playerMapPosition : Math.max(1, playerMapPosition - 2),
                targetTownHallLevel,
                mapUp: hitMirror ? 0 : 2,
                townHallDelta: targetTownHallLevel - playerTownHallLevel,
                mirrorStarsBefore,
                targetStarsBefore: 0,
                reasonableTargetsAvailable: options.forcedHardTarget ? 0 : 2,
                stars,
                destruction,
                newStars: stars,
                formEligible: true,
                mirrorResolved: true,
                targetResolved: true,
                hitMirror,
                forcedHardTarget: options.forcedHardTarget === true
            }]
        }
    };
}

function evidenceFromRegularEvents(events) {
    const regular = events.reduce((total, event) => {
        for (const key of Object.keys(event.stats)) {
            if (key === 'warCount') continue;
            total[key] = (total[key] || 0) + Number(event.stats[key] || 0);
        }
        return total;
    }, { warCount: events.length });
    return { regular, cwl: {}, regularEvents: events, cwlEvents: [] };
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

test('Discord context modes explain by default and only discount validated forced hard targets in assist mode', () => {
    const events = [
        contextualRegularEvent('forced-1', { day: 1, stars: 0, destruction: 20, forcedHardTarget: true }),
        contextualRegularEvent('forced-2', { day: 2, stars: 0, destruction: 20, forcedHardTarget: true }),
        ...Array.from({ length: 4 }, (_, index) => contextualRegularEvent(`normal-${index}`, {
            day: index + 3,
            stars: 2,
            destruction: 80
        }))
    ];
    const evidence = evidenceFromRegularEvents(events);
    const settings = {
        regularMinimumAttacks: 4,
        regularMissedThreshold: 16,
        regularPerformanceEnabled: true,
        regularAverageStarsThreshold: 1.8,
        regularAverageDestructionThreshold: 75,
        cwlPerformanceEnabled: false
    };

    assert.equal(workflow.sanitizeSettings({}).regularContextMode, 'explain');
    assert.equal(workflow.buildSignals(evidence, settings).some(signal => signal.reasonCode === 'regular_performance'), true);
    assert.equal(workflow.buildSignals(evidence, { ...settings, regularContextMode: 'assist' }).some(signal => signal.reasonCode === 'regular_performance'), false);

    const analysis = workflow.analyzeRegularContext(events, evidence.regular);
    assert.equal(analysis.forcedHardAttackCount, 2);
    assert.equal(analysis.adjustedStats.countedAttacks, 4);
    assert.equal(analysis.adjustedStats.averageStars, 2);
    assert.equal(analysis.adjustedStats.averageDestruction, 80);

    const legacyEvidence = structuredClone(evidence);
    for (const event of legacyEvidence.regularEvents) delete event.context;
    assert.equal(
        workflow.buildSignals(legacyEvidence, { ...settings, regularContextMode: 'assist' }).some(signal => signal.reasonCode === 'regular_performance'),
        true,
        'old records without exact context must keep their existing performance behavior'
    );
});

test('Discord automatic context mode requires repeated mirror and consequential late low-TH patterns', () => {
    const baseSettings = {
        regularContextMode: 'automatic',
        regularMissedThreshold: 16,
        regularPerformanceEnabled: false,
        cwlPerformanceEnabled: false
    };
    const mirrorEvents = Array.from({ length: 5 }, (_, index) => contextualRegularEvent(`mirror-${index}`, {
        day: index + 1,
        hitMirror: index >= 3
    }));
    assert.deepEqual(
        workflow.buildSignals(evidenceFromRegularEvents(mirrorEvents.slice(0, 4)), baseSettings).map(signal => signal.reasonCode),
        []
    );
    assert.deepEqual(
        workflow.buildSignals(evidenceFromRegularEvents(mirrorEvents), baseSettings).map(signal => signal.reasonCode),
        ['regular_mirror_pattern']
    );

    const timingEvents = [
        contextualRegularEvent('late-forced-1', { day: 1, forcedHardTarget: true, playerTownHallLevel: 14, lineupMedianTownHall: 15, ownAttackOrdinal: 16 }),
        contextualRegularEvent('late-forced-2', { day: 2, forcedHardTarget: true, playerTownHallLevel: 14, lineupMedianTownHall: 15, ownAttackOrdinal: 18 }),
        contextualRegularEvent('late-normal', { day: 3, playerTownHallLevel: 14, lineupMedianTownHall: 15, ownAttackOrdinal: 15 }),
        contextualRegularEvent('early-1', { day: 4, playerTownHallLevel: 14, lineupMedianTownHall: 15, ownAttackOrdinal: 3 }),
        contextualRegularEvent('early-2', { day: 5, playerTownHallLevel: 14, lineupMedianTownHall: 15, ownAttackOrdinal: 5 })
    ];
    assert.deepEqual(
        workflow.buildSignals(evidenceFromRegularEvents(timingEvents), baseSettings).map(signal => signal.reasonCode),
        ['regular_timing_pattern']
    );
});

test('Discord follow-up keeps post-max loot attacks as used but excludes them from performance cases', () => {
    const rosterData = buildRosterData();
    delete rosterData.playerWarPerformance;
    rosterData.rosters[0].warPerformance = {
        lastRefreshedAt: '2026-08-12T18:02:00.000Z',
        regularWarHistoryByKey: {
            'rw-post-max': {
                warKey: 'rw-post-max',
                authoritative: true,
                finalizedAt: '2026-08-12T18:02:00.000Z',
                statsByTag: {
                    '#P0LYGQ': {
                        possibleAttacks: 2,
                        usedAttacks: 2,
                        attacksMade: 2,
                        attacksMissed: 0,
                        countedAttacks: 2,
                        starsTotal: 2,
                        totalDestruction: 80
                    }
                },
                formStatsByTag: {
                    '#P0LYGQ': {
                        possibleAttacks: 2,
                        usedAttacks: 2,
                        attacksMade: 2,
                        attacksMissed: 0,
                        countedAttacks: 0,
                        formEligibleAttacks: 0,
                        starsTotal: 0,
                        totalDestruction: 0
                    }
                }
            }
        }
    };
    const settings = {
        regularLookbackWars: 1,
        regularMissedThreshold: 1,
        regularPerformanceEnabled: true,
        regularMinimumAttacks: 1,
        regularAverageStarsThreshold: 1.8,
        regularAverageDestructionThreshold: 75,
        cwlPerformanceEnabled: false
    };

    const evidence = workflow.buildEvidenceForTag(rosterData, '#P0LYGQ', settings);
    assert.equal(evidence.regular.possibleAttacks, 2);
    assert.equal(evidence.regular.usedAttacks, 2);
    assert.equal(evidence.regular.missedAttacks, 0);
    assert.equal(evidence.regular.countedAttacks, 0);
    assert.equal(evidence.regular.starsTotal, 0);
    assert.deepEqual(workflow.buildSignals(evidence, settings), []);

    const rawOnly = structuredClone(rosterData);
    delete rawOnly.rosters[0].warPerformance.regularWarHistoryByKey['rw-post-max'].formStatsByTag;
    const unfilteredEvidence = workflow.buildEvidenceForTag(rawOnly, '#P0LYGQ', settings);
    assert.equal(
        workflow.buildSignals(unfilteredEvidence, settings).some(signal => signal.reasonCode === 'regular_performance'),
        true,
        'the fixture must prove that form filtering, rather than thresholds, prevents the case'
    );
});

test('Discord merges canonical and per-roster regular-war evidence without double-counting promoted wars', () => {
    const rosterData = buildRosterData();
    const duplicate = rosterData.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm[0];
    rosterData.rosters[0].warPerformance = {
        lastRefreshedAt: '2026-08-03T00:00:00.000Z',
        regularWarHistoryByKey: {
            [duplicate.warKey]: {
                warKey: duplicate.warKey,
                authoritative: true,
                finalizedAt: duplicate.finalizedAt,
                statsByTag: { '#P0LYGQ': structuredClone(duplicate.stats) },
                formStatsByTag: { '#P0LYGQ': structuredClone(duplicate.stats) }
            },
            'rw-local-only': {
                warKey: 'rw-local-only',
                authoritative: true,
                finalizedAt: '2026-08-03T00:00:00.000Z',
                statsByTag: {
                    '#P0LYGQ': { possibleAttacks: 2, usedAttacks: 0, attacksMade: 0, attacksMissed: 2 }
                },
                formStatsByTag: {
                    '#P0LYGQ': { possibleAttacks: 2, usedAttacks: 0, attacksMade: 0, attacksMissed: 2 }
                }
            }
        }
    };
    const settings = {
        regularLookbackWars: 8,
        regularMissedThreshold: 3,
        regularPerformanceEnabled: false,
        cwlMissedThreshold: 8,
        cwlPerformanceEnabled: false
    };

    const evidence = workflow.buildEvidenceForTag(rosterData, '#P0LYGQ', settings);

    assert.deepEqual(evidence.regularEvents.map(event => event.id), ['rw-local-only', 'rw-2', 'rw-1']);
    assert.equal(evidence.regular.possibleAttacks, 6);
    assert.equal(evidence.regular.missedAttacks, 4);
    assert.deepEqual(workflow.buildSignals(evidence, settings).map(signal => signal.reasonCode), ['regular_missed']);
});

test('full player war history is independent from moderation lookback limits', () => {
    const rosterData = buildRosterData();
    rosterData.rosters[0].warPerformance = {
        lastRefreshedAt: '2026-08-20T00:00:00.000Z',
        regularWarHistoryByKey: Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
            const day = String(index + 1).padStart(2, '0');
            const id = `history-${day}`;
            return [id, {
                warKey: id,
                authoritative: true,
                finalizedAt: `2026-08-${day}T00:00:00.000Z`,
                statsByTag: {
                    '#P0LYGQ': { possibleAttacks: 2, usedAttacks: 2, countedAttacks: 2, starsTotal: 5, totalDestruction: 180 }
                },
                formStatsByTag: {
                    '#P0LYGQ': { possibleAttacks: 2, usedAttacks: 2, countedAttacks: 2, starsTotal: 5, totalDestruction: 180 }
                }
            }];
        }))
    };
    rosterData.playerWarPerformance.byTag['#P0LYGQ'].cwlSeasonContext.bySeason = Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => {
            const month = String(index + 1).padStart(2, '0');
            return [`2026-${month}`, {
                finalizedEventIds: [`cwl-${month}`],
                lastEventAt: `2026-${month}-07T00:00:00.000Z`,
                stats: { possibleAttacks: 1, usedAttacks: 1, countedAttacks: 1, starsTotal: 2, totalDestruction: 80 }
            }];
        })
    );
    const settings = { regularLookbackWars: 3, cwlLookbackSeasons: 2 };

    const moderationEvidence = workflow.buildEvidenceForTag(rosterData, '#P0LYGQ', settings);
    const fullHistory = workflow.buildWarHistoryForTag(rosterData, '#P0LYGQ');

    assert.equal(moderationEvidence.regularEvents.length, 3);
    assert.equal(moderationEvidence.cwlEvents.length, 2);
    assert.equal(fullHistory.regularEvents.length, 14);
    assert.equal(fullHistory.cwlEvents.length, 8);
    assert.equal(fullHistory.regular.possibleAttacks, 28);
    assert.equal(fullHistory.cwl.possibleAttacks, 8);
});

test('Discord keeps the more complete same-season CWL snapshot', () => {
    const rosterData = buildRosterData();
    rosterData.rosters[0].cwlStats = {
        season: '2026-07',
        lastRefreshedAt: '2026-07-28T00:00:00.000Z',
        byTag: {
            '#P0LYGQ': {
                resolvedWarDays: 3,
                possibleAttacks: 3,
                usedAttacks: 1,
                attacksMade: 1,
                missedAttacks: 2,
                countedAttacks: 1,
                starsTotal: 1,
                totalDestruction: 62
            }
        }
    };

    const evidence = workflow.buildEvidenceForTag(rosterData, '#P0LYGQ', { cwlLookbackSeasons: 1 });

    assert.equal(evidence.cwlEvents.length, 1);
    assert.equal(evidence.cwl.warCount, 3);
    assert.equal(evidence.cwl.possibleAttacks, 3);
    assert.equal(evidence.cwl.missedAttacks, 2);
    assert.equal(evidence.cwlEvents[0].at, '2026-07-28T00:00:00.000Z');
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

test('a closed case ignores clean post-close evidence and reopens only for a new violation', () => {
    const data = buildRosterData();
    const settings = {
        regularMissedThreshold: 2,
        regularPerformanceEnabled: false,
        cwlMissedThreshold: 8,
        cwlPerformanceEnabled: false
    };
    const initial = workflow.buildWorkItems(data, { settings, cases: [] });
    const initialItem = initial.items.find(item => item.tag === '#P0LYGQ');
    const closedCase = {
        tag: '#P0LYGQ',
        status: 'dismissed',
        outcome: 'no_action',
        dismissedSignalIds: initialItem.signalIds,
        closedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
    };

    data.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm.unshift(
        regularEvent('rw-clean-after-close', '2026-08-02T00:00:00.000Z', '#MAIN', {
            possibleAttacks: 2,
            usedAttacks: 2,
            countedAttacks: 2,
            starsTotal: 6,
            totalDestruction: 200
        })
    );
    const clean = workflow.buildWorkItems(data, { settings, cases: [closedCase] });
    assert.equal(clean.items.find(item => item.tag === '#P0LYGQ').status, 'closed');

    data.playerWarPerformance.byTag['#P0LYGQ'].recentRegularWarForm.unshift(
        regularEvent('rw-missed-after-close', '2026-08-03T00:00:00.000Z', '#MAIN', {
            possibleAttacks: 2,
            usedAttacks: 0,
            attacksMissed: 2
        })
    );
    const reopened = workflow.buildWorkItems(data, { settings, cases: [closedCase] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(reopened.status, 'needs_review');
    assert.deepEqual(reopened.signals.map(signal => signal.reasonCode), ['regular_missed']);
    assert.deepEqual(reopened.evidence.regularEvents.map(event => event.id), ['rw-missed-after-close', 'rw-clean-after-close']);
});

test('a closed case evaluates only the new CWL delta within the same season', () => {
    const data = buildRosterData();
    const settings = {
        regularMissedThreshold: 16,
        regularPerformanceEnabled: false,
        cwlMissedThreshold: 1,
        cwlPerformanceEnabled: false
    };
    const initial = workflow.buildWorkItems(data, { settings, cases: [] });
    const initialItem = initial.items.find(item => item.tag === '#P0LYGQ');
    const closedCase = {
        tag: '#P0LYGQ',
        status: 'dismissed',
        outcome: 'no_action',
        dismissedSignalIds: initialItem.signalIds,
        evidence: structuredClone(initialItem.evidence),
        closedAt: '2026-08-01T12:00:00.000Z'
    };
    const season = data.playerWarPerformance.byTag['#P0LYGQ'].cwlSeasonContext.bySeason['2026-07'];

    season.finalizedEventIds.push('cwl-clean');
    Object.assign(season.stats, {
        possibleAttacks: 3,
        usedAttacks: 2,
        attacksMissed: 1,
        countedAttacks: 2,
        starsTotal: 4,
        totalDestruction: 160
    });
    const clean = workflow.buildWorkItems(data, { settings, cases: [closedCase] });
    assert.equal(clean.items.find(item => item.tag === '#P0LYGQ').status, 'closed');

    season.finalizedEventIds.push('cwl-missed');
    Object.assign(season.stats, {
        possibleAttacks: 4,
        usedAttacks: 2,
        attacksMissed: 2
    });
    const reopened = workflow.buildWorkItems(data, { settings, cases: [closedCase] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(reopened.status, 'needs_review');
    assert.deepEqual(reopened.signals.map(signal => signal.reasonCode), ['cwl_missed']);
    assert.equal(reopened.evidence.cwl.missedAttacks, 1);
});

test('closing a reopened Discord CWL case keeps a full baseline for the next review cycle', () => {
    const data = buildRosterData();
    const settings = {
        regularMissedThreshold: 16,
        regularPerformanceEnabled: false,
        cwlMissedThreshold: 1,
        cwlPerformanceEnabled: false
    };
    const initialItem = workflow.buildWorkItems(data, { settings, cases: [] })
        .items.find(item => item.tag === '#P0LYGQ');
    const firstClosed = {
        tag: '#P0LYGQ',
        status: 'closed',
        outcome: 'no_action',
        evidence: structuredClone(initialItem.evidence),
        closedAt: '2026-08-01T00:00:00.000Z'
    };
    const season = data.playerWarPerformance.byTag['#P0LYGQ'].cwlSeasonContext.bySeason['2026-07'];
    season.lastEventAt = '2026-08-02T00:00:00.000Z';
    season.finalizedEventIds.push('cwl-war-2');
    Object.assign(season.stats, { possibleAttacks: 3, usedAttacks: 1, attacksMissed: 2 });

    const firstReopen = workflow.buildWorkItems(data, { settings, cases: [firstClosed] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(firstReopen.evidence.cwl.missedAttacks, 1);
    assert.equal(firstReopen.currentEvidence.cwl.missedAttacks, 2);

    const secondClosed = {
        ...firstClosed,
        evidence: structuredClone(firstReopen.currentEvidence),
        closedAt: '2026-08-03T00:00:00.000Z'
    };
    assert.equal(
        workflow.buildWorkItems(data, { settings, cases: [secondClosed] })
            .items.find(item => item.tag === '#P0LYGQ').status,
        'closed'
    );

    season.lastEventAt = '2026-08-04T00:00:00.000Z';
    season.finalizedEventIds.push('cwl-war-3');
    Object.assign(season.stats, { possibleAttacks: 4, usedAttacks: 1, attacksMissed: 3 });
    const secondReopen = workflow.buildWorkItems(data, { settings, cases: [secondClosed] })
        .items.find(item => item.tag === '#P0LYGQ');
    assert.equal(secondReopen.status, 'needs_review');
    assert.equal(secondReopen.evidence.cwl.missedAttacks, 1);
});

test('a closed Discord case reopens for a violation in a newly observed date-based CWL season', () => {
    const data = buildRosterData();
    const settings = {
        regularMissedThreshold: 16,
        regularPerformanceEnabled: false,
        cwlLookbackSeasons: 2,
        cwlMissedThreshold: 1,
        cwlPerformanceEnabled: false
    };
    const initialItem = workflow.buildWorkItems(data, { settings, cases: [] })
        .items.find(item => item.tag === '#P0LYGQ');
    const closedCase = {
        tag: '#P0LYGQ',
        status: 'closed',
        outcome: 'no_action',
        dismissedSignalIds: initialItem.signalIds,
        evidence: structuredClone(initialItem.evidence),
        closedAt: '2026-08-02T00:00:00.000Z'
    };

    data.playerWarPerformance.updatedAt = '2026-08-10T12:00:00.000Z';
    data.playerWarPerformance.byTag['#P0LYGQ'].cwlSeasonContext.bySeason['2026-08-03'] = {
        finalizedEventIds: ['cwl-aug-war-1'],
        stats: { possibleAttacks: 1, usedAttacks: 0, attacksMade: 0, attacksMissed: 1 }
    };
    data.rosters[0].cwlStats = {
        season: '2026-08-03',
        lastRefreshedAt: '2026-08-10T11:55:00.000Z',
        byTag: {
            '#P0LYGQ': {
                resolvedWarDays: 1,
                possibleAttacks: 1,
                usedAttacks: 0,
                attacksMade: 0,
                attacksMissed: 1
            }
        }
    };

    const currentEvidence = workflow.buildEvidenceForTag(data, '#P0LYGQ', settings);
    const currentSeason = currentEvidence.cwlEvents.find(event => event.id === 'cwl:2026-08-03');
    const reopened = workflow.buildWorkItems(data, { settings, cases: [closedCase] })
        .items.find(item => item.tag === '#P0LYGQ');

    assert.equal(currentSeason.at, '2026-08-10T11:55:00.000Z');
    assert.equal(reopened.status, 'needs_review');
    assert.deepEqual(reopened.signals.map(signal => signal.reasonCode), ['cwl_missed']);
    assert.equal(reopened.evidence.cwl.missedAttacks, 1);
});

test('expanding Discord CWL lookback does not reopen a closed case for an older season', () => {
    const data = buildRosterData();
    const initialSettings = {
        regularMissedThreshold: 16,
        regularPerformanceEnabled: false,
        cwlLookbackSeasons: 1,
        cwlMissedThreshold: 1,
        cwlPerformanceEnabled: false
    };
    const initialItem = workflow.buildWorkItems(data, { settings: initialSettings, cases: [] })
        .items.find(item => item.tag === '#P0LYGQ');
    const closedCase = {
        tag: '#P0LYGQ',
        status: 'closed',
        outcome: 'no_action',
        dismissedSignalIds: initialItem.signalIds,
        evidence: structuredClone(initialItem.evidence),
        closedAt: '2026-08-02T00:00:00.000Z'
    };
    data.playerWarPerformance.byTag['#P0LYGQ'].cwlSeasonContext.bySeason['2026-06'] = {
        finalizedEventIds: ['cwl-june-war'],
        stats: { possibleAttacks: 1, usedAttacks: 0, attacksMade: 0, attacksMissed: 1 }
    };

    const work = workflow.buildWorkItems(data, {
        settings: { ...initialSettings, cwlLookbackSeasons: 2 },
        cases: [closedCase]
    });

    assert.equal(work.items.find(item => item.tag === '#P0LYGQ').status, 'closed');
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
