'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const planner = require('../src/features/warFollowup/notificationPlanner');
const { buildNotificationPayload, sendPlannedNotification } = require('../src/features/warFollowup/dashboard');

const NOW = new Date('2026-08-10T08:30:00.000Z');

function buildRosterData() {
    return {
        lastUpdatedAt: '2026-08-10T08:25:00.000Z',
        rosters: [{
            id: 'main',
            title: 'Main Clan',
            connectedClanTag: '#MAIN',
            trackingMode: 'cwl',
            main: [
                { tag: '#AAA', name: 'Alpha', discord: 'alpha', th: 18 },
                { tag: '#BBB', name: 'Bravo', discord: 'bravo', th: 17 },
                { tag: '#CCC', name: 'Charlie', discord: 'legacy-name-without-an-id', th: 16 }
            ],
            subs: [],
            missing: [],
            regularWar: {
                currentWar: {
                    state: 'inwar',
                    warKey: '#MAIN|#OPP|20260809T090000.000Z',
                    endTime: '2026-08-10T09:30:00.000Z'
                },
                byTag: {
                    '#AAA': { current: { inWar: true, attacksRemaining: 1 } },
                    '#BBB': { current: { inWar: true, attacksRemaining: 0 } },
                    '#CCC': { current: { inWar: true, attacksRemaining: 1 } }
                }
            },
            cwlStats: {
                season: '2026-08-03',
                lastRefreshedAt: '2026-08-10T08:25:00.000Z',
                currentWar: {
                    state: 'inwar',
                    warTag: '#WAR7',
                    endTime: '2026-08-10T09:30:00.000Z'
                },
                byTag: {
                    '#AAA': { currentWarAttackPending: 0, resolvedWarDays: 7, attacksMade: 7 },
                    '#BBB': { currentWarAttackPending: 1, resolvedWarDays: 6, attacksMade: 6 }
                }
            },
            warPerformance: {
                regularWarHistoryByKey: {
                    fresh: {
                        warKey: '#MAIN|#OPP|fresh',
                        authoritative: true,
                        finalizedAt: '2026-08-10T08:00:00.000Z',
                        statsByTag: {
                            '#AAA': { possibleAttacks: 2, attacksMade: 1, attacksMissed: 1, countedAttacks: 1, starsTotal: 2, totalDestruction: 80 },
                            '#BBB': { possibleAttacks: 2, attacksMade: 2, attacksMissed: 0, countedAttacks: 2, starsTotal: 5, totalDestruction: 180 }
                        }
                    },
                    old: {
                        warKey: '#MAIN|#OLD|old',
                        authoritative: true,
                        finalizedAt: '2026-07-01T08:00:00.000Z',
                        statsByTag: { '#AAA': { possibleAttacks: 2, attacksMissed: 2 } }
                    }
                }
            }
        }, {
            id: 'completed-cwl',
            title: 'Completed CWL',
            connectedClanTag: '#DONE',
            trackingMode: 'cwl',
            main: [
                { tag: '#DDD', name: 'Delta', discord: 'delta', th: 18 },
                { tag: '#EEE', name: 'Echo', discord: 'echo', th: 17 }
            ],
            subs: [],
            missing: [],
            cwlStats: {
                season: '2026-08-03',
                lastRefreshedAt: '2026-08-10T08:20:00.000Z',
                byTag: {
                    '#DDD': { resolvedWarDays: 7, attacksMade: 5, missedAttacks: 2, countedAttacks: 5, starsTotal: 11, totalDestruction: 390 },
                    '#EEE': { resolvedWarDays: 7, attacksMade: 7, missedAttacks: 0, countedAttacks: 7, starsTotal: 16, totalDestruction: 600 }
                }
            }
        }],
        playerMetrics: {
            byTag: {
                '#AAA': { identity: { name: 'Alpha', discordId: '111111111111111111', discordUsername: 'alpha' } },
                '#BBB': { identity: { name: 'Bravo', discordId: '222222222222222222', discordUsername: 'bravo' } },
                '#CCC': { identity: { name: 'Charlie' } },
                '#DDD': { identity: { name: 'Delta', discordId: '333333333333333333', discordUsername: 'delta' } },
                '#EEE': { identity: { name: 'Echo', discordId: '444444444444444444', discordUsername: 'echo' } }
            }
        },
        playerWarPerformance: {
            updatedAt: '2026-08-10T08:25:00.000Z',
            byTag: {
                '#AAA': {
                    recentRegularWarForm: [{
                        warKey: 'recent-a',
                        finalizedAt: '2026-08-10T08:00:00.000Z',
                        clanTag: '#MAIN',
                        stats: { possibleAttacks: 2, usedAttacks: 0, attacksMissed: 2 }
                    }]
                }
            }
        }
    };
}

function buildConfig(features = {}) {
    const enabledAt = '2026-08-10T07:00:00.000Z';
    const allFeatures = {
        caseAlerts: true,
        attackReminders: true,
        regularWarSummaries: true,
        cwlDailyUpdates: true,
        cwlEndSummaries: true,
        missingDiscordDigest: true,
        directMessages: false,
        ...features
    };
    return {
        enabled: true,
        enabledAt,
        staffRoleId: '555555555555555555',
        timeZone: 'Europe/Berlin',
        features: allFeatures,
        featureEnabledAt: Object.fromEntries(Object.keys(allFeatures).map(key => [key, enabledAt]))
    };
}

function buildWorkspace(cases = []) {
    const rosterData = buildRosterData();
    const privateState = { settings: workflow.sanitizeSettings(null), cases };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

function emptyRecord() {
    return {
        deliveries: {},
        observations: {
            caseFingerprints: {},
            casesInitializedAt: '',
            lastMissingDiscordDigestDate: ''
        }
    };
}

test('first scheduler observation baselines cases instead of flooding the channel', () => {
    const workspace = buildWorkspace();
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig(),
        record: emptyRecord(),
        nowRaw: NOW
    });
    assert.equal(plan.notifications.some(notification => notification.kind === 'case-alert'), false);
    assert.ok(plan.caseObservations['#AAA']);
});

test('case transitions produce one staff alert after the baseline exists', () => {
    const initial = buildWorkspace();
    const baseline = planner.buildCurrentCaseObservations(initial.work, '2026-08-10T08:00:00.000Z');
    const changed = buildWorkspace([{
        tag: '#AAA',
        status: 'needs_dm',
        dmText: 'Prepared decision',
        updatedAt: '2026-08-10T08:20:00.000Z'
    }]);
    const plan = planner.planNotifications({
        ...changed,
        config: buildConfig(),
        record: {
            deliveries: {},
            observations: { caseFingerprints: baseline, casesInitializedAt: '2026-08-10T08:00:00.000Z' }
        },
        nowRaw: NOW
    });
    const alert = plan.notifications.find(notification => notification.kind === 'case-alert');
    assert.ok(alert);
    assert.match(alert.embeds[0].description, /Needs DM/);
    assert.deepEqual(alert.allowedRoleIds, ['555555555555555555']);
});

test('a removed player rejoining produces one prominent leadership alert', () => {
    const removalCase = {
        tag: '#AAA',
        name: 'Alpha',
        discordId: '111111111111111111',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        contactPurpose: 'removal',
        status: 'removed',
        outcome: 'removed',
        removalReason: 'Repeated missed attacks after prior contact.',
        removalAbsentObservedAt: '2026-08-09T00:00:00.000Z',
        createdAt: '2026-08-08T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:00.000Z',
        activity: []
    };
    const initial = buildWorkspace([removalCase]);
    initial.rosterData.rosters[0].main = initial.rosterData.rosters[0].main.filter(player => player.tag !== '#AAA');
    initial.work = workflow.buildWorkItems(initial.rosterData, initial.privateState);
    const baseline = planner.buildCurrentCaseObservations(initial.work, '2026-08-09T00:00:00.000Z');

    const changed = buildWorkspace([{
        ...removalCase,
        status: 'removal_evasion',
        outcome: '',
        removalRejoinedAt: '2026-08-10T08:20:00.000Z',
        rejoinRosterId: 'main',
        rejoinRosterTitle: 'Main Clan',
        rejoinClanTag: '#MAIN',
        updatedAt: '2026-08-10T08:20:00.000Z'
    }]);
    const plan = planner.planNotifications({
        ...changed,
        config: buildConfig(),
        record: {
            deliveries: {},
            observations: { caseFingerprints: baseline, casesInitializedAt: '2026-08-09T00:00:00.000Z' }
        },
        nowRaw: NOW
    });
    const alerts = plan.notifications.filter(notification => notification.kind === 'case-alert');
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].embeds[0].title, 'Removed player rejoined');
    assert.match(alerts[0].embeds[0].description, /Removal evasion/);
    assert.match(alerts[0].embeds[0].description, /Main Clan/);
    assert.match(alerts[0].content, /<@&555555555555555555>/);
});

test('late startup selects only the most urgent reminder window and consumes earlier windows', () => {
    const workspace = buildWorkspace();
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({
            caseAlerts: false,
            regularWarSummaries: false,
            cwlEndSummaries: false,
            missingDiscordDigest: false
        }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    const reminders = plan.notifications.filter(notification => notification.kind.endsWith('attack-reminder'));
    assert.equal(reminders.length, 2);
    for (const reminder of reminders) {
        assert.match(reminder.key, /:120m$/);
        assert.equal(reminder.consumeKeys.some(key => key.endsWith(':360m')), true);
        assert.equal(reminder.consumeKeys.some(key => key.endsWith(':120m')), true);
        assert.equal(reminder.consumeKeys.some(key => key.endsWith(':30m')), false);
    }
    assert.deepEqual(
        reminders.find(notification => notification.kind === 'regular-attack-reminder').allowedUserIds,
        ['111111111111111111']
    );
    assert.deepEqual(
        reminders.find(notification => notification.kind === 'regular-attack-reminder').allowedRoleIds,
        ['555555555555555555'],
        'staff is tagged when a pending attacker has no taggable Discord ID'
    );
    assert.deepEqual(
        reminders.find(notification => notification.kind === 'cwl-attack-reminder').allowedUserIds,
        ['222222222222222222']
    );
});

test('multiple pending accounts linked to one Discord user are not reported as unlinked', () => {
    const workspace = buildWorkspace();
    workspace.rosterData.playerMetrics.byTag['#CCC'].identity.discordId = '111111111111111111';
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({
            caseAlerts: false,
            regularWarSummaries: false,
            cwlEndSummaries: false,
            missingDiscordDigest: false
        }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    const reminder = plan.notifications.find(notification => notification.kind === 'regular-attack-reminder');
    assert.deepEqual(reminder.allowedUserIds, ['111111111111111111']);
    assert.deepEqual(reminder.allowedRoleIds, []);
    assert.doesNotMatch(reminder.embeds[0].description, /could not be tagged/);
});

test('regular and CWL end summaries include missed attackers but never replay pre-opt-in wars', () => {
    const workspace = buildWorkspace();
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, attackReminders: false, cwlDailyUpdates: false, missingDiscordDigest: false }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    const regular = plan.notifications.filter(notification => notification.kind === 'regular-war-summary');
    const cwl = plan.notifications.filter(notification => notification.kind === 'cwl-end-summary');
    assert.equal(regular.length, 1, 'only the post-opt-in regular war should be summarized');
    assert.match(regular[0].embeds[0].fields[0].value, /\{\{wfu-user:111111111111111111\}\}/);
    assert.deepEqual(regular[0].allowedUserIds, ['111111111111111111']);
    assert.equal(cwl.length, 1);
    assert.match(cwl[0].embeds[0].fields[0].value, /\{\{wfu-user:333333333333333333\}\}/);
    assert.deepEqual(cwl[0].allowedUserIds, ['333333333333333333']);
});

test('a maximum-size CWL report includes every missed attacker within Discord embed limits', () => {
    const workspace = buildWorkspace();
    const completed = workspace.rosterData.rosters.find(roster => roster.id === 'completed-cwl');
    completed.main = [];
    completed.cwlStats.byTag = {};
    workspace.rosterData.playerMetrics.byTag = {};
    const expectedTags = [];
    for (let index = 0; index < 50; index += 1) {
        const tag = `#P${String(index).padStart(3, '0')}`;
        expectedTags.push(tag);
        completed.main.push({
            tag,
            name: `Extremely long unlinked player name ${String(index).padStart(2, '0')} ${'x'.repeat(70)}`,
            th: 18
        });
        completed.cwlStats.byTag[tag] = {
            resolvedWarDays: 7,
            attacksMade: 6,
            missedAttacks: 1,
            countedAttacks: 6,
            starsTotal: index,
            totalDestruction: index * 100
        };
    }
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({
            caseAlerts: false,
            attackReminders: false,
            regularWarSummaries: false,
            cwlDailyUpdates: false,
            missingDiscordDigest: false
        }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    const notification = plan.notifications.find(entry => entry.kind === 'cwl-end-summary');
    assert.ok(notification);
    const embed = notification.embeds[0];
    const missedText = embed.fields
        .filter(field => field.name.startsWith('Missed CWL attacks'))
        .map(field => field.value)
        .join('\n');
    for (const tag of expectedTags) assert.match(missedText, new RegExp(tag.replace('#', '\\#')));
    assert.equal(embed.fields.every(field => field.value.length <= 1024), true);
    assert.ok(embed.fields.length <= 25);
    const aggregateLength = [
        embed.title,
        embed.description,
        ...embed.fields.flatMap(field => [field.name, field.value])
    ].reduce((sum, value) => sum + String(value || '').length, 0);
    assert.ok(aggregateLength <= 6000, `aggregate embed length was ${aggregateLength}`);
});

test('all-clear updates fire once only when no tracked attack remains', () => {
    const workspace = buildWorkspace();
    workspace.rosterData.rosters[0].regularWar.byTag['#AAA'].current.attacksRemaining = 0;
    workspace.rosterData.rosters[0].regularWar.byTag['#CCC'].current.attacksRemaining = 0;
    workspace.rosterData.rosters[0].cwlStats.byTag['#BBB'].currentWarAttackPending = 0;
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, regularWarSummaries: false, cwlEndSummaries: false, missingDiscordDigest: false }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    assert.ok(plan.notifications.some(notification => notification.kind === 'regular-all-clear'));
    assert.ok(plan.notifications.some(notification => notification.kind === 'cwl-all-clear'));

    const delivered = Object.fromEntries(plan.notifications.map(notification => [notification.key, { at: NOW.toISOString() }]));
    const repeated = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, regularWarSummaries: false, cwlEndSummaries: false, missingDiscordDigest: false }),
        record: { ...emptyRecord(), deliveries: delivered },
        nowRaw: NOW
    });
    assert.equal(repeated.notifications.some(notification => notification.kind.endsWith('all-clear')), false);
});

test('an active-war pointer without lineup stats is never treated as all-clear', () => {
    const workspace = buildWorkspace();
    workspace.rosterData.rosters[0].regularWar.byTag = {};
    workspace.rosterData.rosters[0].cwlStats.byTag = {};
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, regularWarSummaries: false, cwlEndSummaries: false, missingDiscordDigest: false }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    assert.equal(plan.notifications.some(notification => notification.kind.endsWith('all-clear')), false);
});

test('daily Discord-gap digest is bounded, staff-tagged, and date-deduplicated', () => {
    const workspace = buildWorkspace();
    const plan = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, attackReminders: false, regularWarSummaries: false, cwlDailyUpdates: false, cwlEndSummaries: false }),
        record: emptyRecord(),
        nowRaw: NOW
    });
    const digest = plan.notifications.find(notification => notification.kind === 'missing-discord-digest');
    assert.ok(digest);
    assert.match(digest.embeds[0].description, /Charlie/);
    assert.match(digest.embeds[0].footer.text, /cannot receive automatic tags/);
    assert.equal(plan.missingDiscordDigestDate, '2026-08-10');
    const payload = buildNotificationPayload(digest);
    assert.deepEqual(payload.allowedMentions.roles, ['555555555555555555']);

    const repeated = planner.planNotifications({
        ...workspace,
        config: buildConfig({ caseAlerts: false, attackReminders: false, regularWarSummaries: false, cwlDailyUpdates: false, cwlEndSummaries: false }),
        record: {
            deliveries: {},
            observations: { caseFingerprints: {}, casesInitializedAt: '', lastMissingDiscordDigestDate: '2026-08-10' }
        },
        nowRaw: NOW
    });
    assert.equal(repeated.notifications.some(notification => notification.kind === 'missing-discord-digest'), false);
});

test('notification embeds resolve the current guild display name while keeping real notification mentions in content', async () => {
    const fetchRequests = [];
    let sentPayload = null;
    const channel = {
        guild: {
            members: {
                fetch: async options => {
                    fetchRequests.push(options);
                    return {
                        displayName: 'Current server nickname',
                        user: { username: 'outdated-user' }
                    };
                }
            }
        },
        send: async payload => {
            sentPayload = payload;
            return { id: 'sent-message' };
        }
    };
    const notification = {
        kind: 'regular-attack-reminder',
        content: '<@111111111111111111>',
        embeds: [{
            title: 'Main Clan · attacks still open',
            description: '• **{{wfu-user:111111111111111111}}** · `#AAA` — 1 attack remaining'
        }],
        allowedUserIds: ['111111111111111111'],
        allowedRoleIds: [],
        displayNameFallbacks: { '111111111111111111': 'Old cached name' }
    };

    await sendPlannedNotification(channel, notification);

    assert.deepEqual(fetchRequests, [{ user: '111111111111111111', cache: false, force: true }]);
    assert.equal(sentPayload.content, '<@111111111111111111>');
    assert.match(sentPayload.embeds[0].description, /Current server nickname/);
    assert.doesNotMatch(sentPayload.embeds[0].description, /\{\{wfu-user:|<@111111111111111111>/);
    assert.deepEqual(sentPayload.allowedMentions.users, ['111111111111111111']);
});

test('notification embeds fall back to the roster name when a linked member cannot be fetched', async () => {
    let sentPayload = null;
    const channel = {
        guild: {
            members: {
                fetch: async () => {
                    const error = new Error('Unknown Member');
                    error.code = 10007;
                    throw error;
                }
            }
        },
        send: async payload => {
            sentPayload = payload;
            return { id: 'sent-message' };
        }
    };

    await sendPlannedNotification(channel, {
        kind: 'case-alert',
        embeds: [{ description: '• **{{wfu-user:111111111111111111}}** · `#AAA`' }],
        displayNameFallbacks: { '111111111111111111': 'Roster fallback name' }
    });

    assert.match(sentPayload.embeds[0].description, /Roster fallback name/);
    assert.doesNotMatch(sentPayload.embeds[0].description, /\{\{wfu-user:|<@111111111111111111>/);
});

test('assignment and inactivity notifications honor each moderator delivery preference and remain idempotent', () => {
    const assignedAt = '2026-08-09T07:00:00.000Z';
    const workspace = buildWorkspace([{
        tag: '#AAA',
        name: 'Alpha',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        status: 'needs_review',
        assignedModeratorId: '666666666666666666',
        assignedModeratorName: 'Case Owner',
        handledBy: 'Case Owner',
        assignedAt,
        assignmentUpdatedAt: assignedAt,
        lastMeaningfulActionAt: assignedAt,
        createdAt: assignedAt,
        updatedAt: assignedAt,
        activity: []
    }]);
    const moderators = {
        '666666666666666666': {
            discordId: '666666666666666666',
            displayName: 'Case Owner',
            notificationMode: 'both',
            accepting: true,
            clanTags: ['#MAIN']
        }
    };
    const notifications = planner.planModerationOwnershipNotifications(
        workspace.work,
        buildConfig(),
        emptyRecord(),
        moderators,
        NOW.getTime()
    );

    assert.deepEqual(
        notifications.map(notification => `${notification.kind}:${notification.destination}`).sort(),
        [
            'case-assignment:channel',
            'case-assignment:dm',
            'case-inactivity-reminder:channel',
            'case-inactivity-reminder:dm'
        ]
    );
    assert.equal(notifications.filter(notification => notification.destination === 'channel').every(notification => notification.content === '<@666666666666666666>'), true);
    assert.equal(notifications.filter(notification => notification.destination === 'dm').every(notification => notification.content === ''), true);
    assert.equal(notifications.filter(notification => notification.kind === 'case-inactivity-reminder').every(notification => /:24h:/.test(notification.key)), true);

    const fortyEightHour = planner.planModerationOwnershipNotifications(
        workspace.work,
        buildConfig(),
        emptyRecord(),
        moderators,
        new Date(assignedAt).getTime() + 49 * 60 * 60 * 1000
    ).filter(notification => notification.kind === 'case-inactivity-reminder');
    assert.equal(fortyEightHour.every(notification => /:48h:/.test(notification.key)), true);
    assert.equal(fortyEightHour.every(notification => notification.consumeKeys.some(key => /:24h:/.test(key))), true);

    const delivered = Object.fromEntries(notifications.flatMap(notification =>
        (notification.consumeKeys || [notification.key]).map(key => [key, { at: NOW.toISOString() }])
    ));
    assert.deepEqual(
        planner.planModerationOwnershipNotifications(
            workspace.work,
            buildConfig(),
            { ...emptyRecord(), deliveries: delivered },
            moderators,
            NOW.getTime()
        ),
        []
    );
});

test('a future waiting follow-up suppresses generic inactivity reminders until it is due', () => {
    const now = new Date('2026-08-10T12:00:00.000Z');
    const assignedAt = new Date(now.getTime() - 50 * 60 * 60 * 1000).toISOString();
    const workspace = buildWorkspace([{
        tag: '#AAA',
        name: 'Alpha',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        status: 'waiting',
        assignedModeratorId: '222222222222222222',
        assignedModeratorName: 'Leader A',
        handledBy: 'Leader A',
        assignedAt,
        assignmentUpdatedAt: assignedAt,
        lastMeaningfulActionAt: assignedAt,
        waitingUntil: new Date(now.getTime() + 22 * 60 * 60 * 1000).toISOString(),
        createdAt: assignedAt,
        updatedAt: assignedAt,
        activity: []
    }]);
    const notifications = planner.planModerationOwnershipNotifications(
        workspace.work,
        buildConfig(),
        { deliveries: {} },
        {
            '222222222222222222': {
                discordId: '222222222222222222',
                displayName: 'Leader A',
                notificationMode: 'both',
                accepting: true
            }
        },
        now.getTime()
    );

    assert.equal(notifications.filter(entry => entry.kind === 'case-inactivity-reminder').length, 0);
});

test('unassigned and escalated cases produce deduplicated leadership-visible notifications', () => {
    const workspace = buildWorkspace([{
        tag: '#AAA',
        name: 'Alpha',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        status: 'needs_review',
        assignmentUpdatedAt: '2026-08-10T08:00:00.000Z',
        escalatedAt: '2026-08-10T08:05:00.000Z',
        escalatedBy: 'Case Owner',
        createdAt: '2026-08-10T08:00:00.000Z',
        updatedAt: '2026-08-10T08:05:00.000Z',
        activity: []
    }]);
    const notifications = planner.planModerationOwnershipNotifications(
        workspace.work,
        buildConfig(),
        emptyRecord(),
        {},
        NOW.getTime()
    );
    assert.deepEqual(notifications.map(notification => notification.kind).sort(), ['case-escalation', 'case-unassigned']);
    assert.equal(notifications.every(notification => notification.content === '<@&555555555555555555>'), true);
});
