'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const automated = require('../src/features/warFollowup/automatedCases');

const TAG = '#P0LYGQ';
const BASE = Date.parse('2026-08-01T00:00:00.000Z');
const at = day => new Date(BASE + day * 24 * 60 * 60 * 1000).toISOString();
const event = (day, stats, clanTag = '#TRAIN') => ({
    id: `war-${day}`,
    eventId: `war-${day}`,
    warKey: `war-${day}`,
    at: at(day),
    finalizedAt: at(day),
    clanTag,
    stats: { warCount: 1, possibleAttacks: 2, usedAttacks: 2, missedAttacks: 0,
        countedAttacks: 2, starsTotal: 4, totalDestruction: 160, ...stats }
});

test('long confirmed attendance raises the missed-attack case threshold without counting current wars', () => {
    const history = Array.from({ length: 30 }, (_, index) => event(index + 1, {}, '#MAIN'));
    const rosterData = { playerWarPerformance: { byTag: { [TAG]: {
        regular: { warCount: 30, possibleAttacks: 60, usedAttacks: 58, missedAttacks: 2 },
        recentRegularWarForm: history
    } } } };
    const recent = { regular: { warCount: 8, possibleAttacks: 16, usedAttacks: 14, missedAttacks: 2 },
        regularEvents: history.slice(-8).map(entry => ({ ...entry, id: entry.warKey })) };
    const profile = workflow.buildReliabilityProfile(rosterData, TAG, recent, workflow.sanitizeSettings(null));
    assert.equal(profile.priorWars, 22);
    assert.equal(profile.credit, 2);
    assert.equal(profile.regularMissedThreshold, workflow.sanitizeSettings(null).regularMissedThreshold + 2);
});

test('automatic DMs require explicit configuration and a prior check-in before a warning', () => {
    const item = { tag: TAG, player: { discordId: '444444444444444444' }, case: {} };
    const workspace = { work: { items: [item] } };
    const enabled = { features: { directMessages: true, autoCaseDms: true } };
    assert.equal(automated.canSendAutomaticDm(item, workspace, { features: { directMessages: true } }), false);
    assert.equal(automated.canSendAutomaticDm(item, workspace, enabled), true);
    assert.equal(automated.canSendAutomaticDm(item, workspace, enabled, at(40), 'warning'), false);
    item.case.automationLastDmAt = at(1);
    assert.equal(automated.canSendAutomaticDm(item, workspace, enabled, at(2), 'warning'), true);
    assert.equal(automated.canSendAutomaticDm(item, workspace, enabled, at(2), 'checkin'), false);
});

test('attendance failure in a performance case ends observation for leader review', () => {
    const item = {
        tag: TAG,
        player: { automaticEligible: true },
        case: { automationCategory: 'regular_performance', automationStage: 'checkin', automationWindowStartAt: at(0) },
        currentEvidence: { regularEvents: [event(1, { usedAttacks: 0, missedAttacks: 2, countedAttacks: 0 }),
            event(2, { usedAttacks: 0, missedAttacks: 2, countedAttacks: 0 })] }
    };
    const progress = automated.progressForItem(item, { work: { settings: workflow.sanitizeSettings(null) } });
    assert.equal(progress.ready, true);
    assert.equal(progress.attendanceFailure, true);
    assert.equal(progress.fullMisses, 2);
});

test('new recovery requires eligible clean wars and six attacks meeting result targets', () => {
    const caseValue = { tag: TAG, recoveryPolicyVersion: 1, recoveryCategory: 'regular_performance',
        recoveryStartedAt: at(0), recoveryWarTarget: 3, targetClanTag: '#TRAIN',
        recoveryAverageStarsThreshold: 1.8, recoveryAverageDestructionThreshold: 70, recoveryContextMode: 'off' };
    const settings = workflow.sanitizeSettings(null);
    const clean = [event(1, {}), event(2, {}), event(3, {})];
    const evidence = { regularEvents: [event(4, {}, '#MAIN'), event(0, {}), ...clean] };
    const ready = workflow.buildRecoveryProgress(caseValue, evidence, settings);
    assert.equal(ready.ready, true);
    assert.equal(ready.totalWars, 3);
    assert.equal(ready.countedAttacks, 6);
    const poor = workflow.buildRecoveryProgress(caseValue, { regularEvents: clean.map(entry =>
        ({ ...entry, stats: { ...entry.stats, starsTotal: 2, totalDestruction: 100 } })) }, settings);
    assert.equal(poor.ready, false);
    assert.equal(poor.performanceMet, false);
    const missed = workflow.buildRecoveryProgress(caseValue, { regularEvents: [
        ...clean, event(5, { usedAttacks: 1, missedAttacks: 1 })
    ] }, settings);
    assert.equal(missed.completedWars, 0);
});
