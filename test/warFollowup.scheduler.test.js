'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const { getStaffRoleIds } = require('../src/features/permissions/staffPermissions');
const { createWarFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const {
    MODERATOR_DIGEST_INTERVAL_MS,
    LEADERSHIP_DIGEST_INTERVAL_MS,
    prepareNotificationQueue,
    processGuild,
    runWarFollowupTick
} = require('../src/features/warFollowup/scheduler');
const { ensureModerationHub, retireDashboard } = require('../src/features/warFollowup/dashboard');

const temporaryDirectories = [];
const GUILD_ID = '111111111111111111';
const CHANNEL_ID = '222222222222222222';
const NOW = new Date('2026-08-10T08:30:00.000Z');

function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-followup-scheduler-'));
    temporaryDirectories.push(directory);
    return createWarFollowupStateStore({ filePath: path.join(directory, 'state.json') });
}

function messageTitle(payload) {
    const embed = payload?.embeds?.[0];
    return String(embed?.data?.title || embed?.title || '');
}

function createDiscordHarness(options = {}) {
    const messages = new Map();
    const sends = [];
    let sequence = 0;
    const channel = {
        id: CHANNEL_ID,
        guildId: GUILD_ID,
        isTextBased: () => true,
        isThread: () => false,
        guild: options.guild,
        messages: {
            fetch: async messageId => {
                if (messages.has(messageId)) return messages.get(messageId);
                const error = new Error('Unknown message');
                error.code = 10008;
                throw error;
            }
        },
        send: async payload => {
            const title = messageTitle(payload);
            sends.push({ payload, title });
            options.onSend?.(title, sends);
            if (options.failNotification?.(title, sends)) throw new Error('simulated Discord send failure');
            sequence += 1;
            const message = {
                id: `33333333333333333${sequence}`,
                payload,
                edit: async nextPayload => {
                    message.payload = nextPayload;
                    return message;
                }
            };
            messages.set(message.id, message);
            return message;
        }
    };
    const client = {
        channels: {
            cache: new Map([[CHANNEL_ID, channel]]),
            fetch: async channelId => channelId === CHANNEL_ID ? channel : null
        },
        users: options.users
    };
    return { client, channel, messages, sends };
}

function buildWorkspace() {
    const rosterData = {
        rosters: [{
            id: 'main',
            title: 'Main Clan',
            main: [{ tag: '#P0LYGQ', name: 'Alpha', discord: 'alpha' }],
            subs: [],
            missing: [],
            regularWar: {
                currentWar: {
                    state: 'inwar',
                    warKey: 'war-one',
                    endTime: '2026-08-10T09:30:00.000Z'
                },
                byTag: {
                    '#P0LYGQ': { current: { inWar: true, attacksRemaining: 1 } }
                }
            }
        }],
        playerMetrics: {
            byTag: {
                '#P0LYGQ': { identity: { name: 'Alpha', discordId: '444444444444444444' } }
            }
        }
    };
    const privateState = { settings: workflow.sanitizeSettings(null), cases: [] };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

test('moderation notifications are grouped per recipient and respect digest cooldowns', () => {
    const moderatorId = '666666666666666666';
    const assignments = Array.from({ length: 10 }, (_, index) => ({
        key: `assignment-${index}`,
        kind: 'case-assignment',
        destination: 'channel',
        recipientUserId: moderatorId,
        content: `<@${moderatorId}>`,
        embeds: [{ title: 'New moderation case assigned', description: `Player ${index} · Main Clan` }],
        allowedUserIds: [moderatorId],
        allowedRoleIds: []
    }));

    const first = prepareNotificationQueue(assignments, { deliveries: {} }, NOW);
    assert.equal(first.notifications.length, 1);
    assert.equal(first.notifications[0].kind, 'moderation-digest');
    assert.equal(first.notifications[0].content, `<@${moderatorId}>`);
    assert.equal(first.notifications[0].consumeKeys.length, 10);
    assert.match(first.notifications[0].embeds[0].title, /10 updates/);

    const cadenceKey = first.notifications[0].cadenceKey;
    const coolingDown = prepareNotificationQueue(assignments, {
        deliveries: { [cadenceKey]: { at: NOW.toISOString() } }
    }, new Date(NOW.getTime() + MODERATOR_DIGEST_INTERVAL_MS - 1));
    assert.equal(coolingDown.notifications.length, 0);
    assert.equal(coolingDown.deferred.length, 1);

    const readyAgain = prepareNotificationQueue(assignments, {
        deliveries: { [cadenceKey]: { at: NOW.toISOString() } }
    }, new Date(NOW.getTime() + MODERATOR_DIGEST_INTERVAL_MS));
    assert.equal(readyAgain.notifications.length, 1);
});

test('leadership and war alerts produce at most one ping per digest wave', () => {
    const roleId = '555555555555555555';
    const userId = '444444444444444444';
    const planned = [
        {
            key: 'escalation-a',
            kind: 'case-escalation',
            destination: 'channel',
            content: `<@&${roleId}>`,
            embeds: [{ title: 'Leadership review requested', description: 'Player A · #AAA' }],
            allowedUserIds: [],
            allowedRoleIds: [roleId]
        },
        {
            key: 'unassigned-b',
            kind: 'case-unassigned',
            destination: 'channel',
            content: `<@&${roleId}>`,
            embeds: [{ title: 'Moderation case is unassigned', description: 'Player B · #BBB' }],
            allowedUserIds: [],
            allowedRoleIds: [roleId]
        },
        {
            key: 'case-alert-c',
            kind: 'case-alert',
            destination: 'channel',
            content: `<@&${roleId}>`,
            embeds: [{ title: 'War follow-up needs attention', description: 'Player C · removal evasion' }],
            allowedUserIds: [],
            allowedRoleIds: [roleId]
        },
        ...['regular', 'cwl'].map(mode => ({
            key: `attack-${mode}`,
            kind: `${mode}-attack-reminder`,
            destination: 'channel',
            content: `<@${userId}>`,
            embeds: [{ title: `${mode} attacks still open`, description: 'One attack remains.' }],
            allowedUserIds: [userId],
            allowedRoleIds: []
        }))
    ];

    const prepared = prepareNotificationQueue(planned, { deliveries: {} }, NOW);
    assert.equal(prepared.notifications.length, 2);
    const leadership = prepared.notifications.find(notification => notification.kind === 'moderation-digest');
    const reminders = prepared.notifications.find(notification => notification.kind === 'war-reminder-digest');
    assert.equal((leadership.content.match(new RegExp(`<@&${roleId}>`, 'g')) || []).length, 1);
    assert.equal((reminders.content.match(new RegExp(`<@${userId}>`, 'g')) || []).length, 1);
    assert.equal(leadership.cadenceMs, LEADERSHIP_DIGEST_INTERVAL_MS);
    const deferred = prepareNotificationQueue(planned, {
        deliveries: { [leadership.cadenceKey]: { at: NOW.toISOString() } }
    }, new Date(NOW.getTime() + 60 * 60 * 1000));
    assert.equal(deferred.deferredCaseAlert, true);
});

test('scheduler persists moderator cooldown and later sends all accumulated cases together', async () => {
    const store = createStore();
    const moderatorId = '666666666666666666';
    const staffRoleId = getStaffRoleIds()[0];
    const guild = {
        members: {
            fetch: async ({ user }) => ({
                id: user,
                displayName: 'Assigned Leader',
                user: { username: 'assigned-leader' },
                roles: { cache: { has: roleId => roleId === staffRoleId } }
            })
        }
    };
    const harness = createDiscordHarness({ guild });
    store.patchConfig(GUILD_ID, {
        enabled: true,
        channelId: CHANNEL_ID
    }, new Date('2026-08-10T07:00:00.000Z'));
    store.upsertModerator(GUILD_ID, moderatorId, {
        displayName: 'Assigned Leader',
        clanTags: ['#MAIN'],
        notificationMode: 'channel',
        accepting: true
    }, NOW);
    const workspace = buildWorkspace();
    const assignedCase = (tag, name, at) => ({
        tag,
        name,
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        status: 'needs_review',
        assignedModeratorId: moderatorId,
        assignedModeratorName: 'Assigned Leader',
        handledBy: 'Assigned Leader',
        assignedAt: at,
        assignmentUpdatedAt: at,
        lastMeaningfulActionAt: at,
        openedAt: at,
        createdAt: at,
        updatedAt: at,
        activity: []
    });
    workspace.privateState.cases = [assignedCase('#P0LYGQ', 'Alpha', NOW.toISOString())];
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);

    await processGuild(harness.client, { guildId: GUILD_ID }, workspace, { store, now: NOW });
    assert.equal(harness.sends.filter(send => send.title.includes('Your moderation work')).length, 1);

    const secondAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    workspace.privateState.cases.push(assignedCase('#P2QUL292G', 'Bravo', secondAt.toISOString()));
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);
    const deferred = await processGuild(harness.client, { guildId: GUILD_ID }, workspace, { store, now: secondAt });
    assert.equal(deferred.deferred, 1);
    assert.equal(harness.sends.filter(send => send.title.includes('Your moderation work')).length, 1);

    const digestAt = new Date(NOW.getTime() + MODERATOR_DIGEST_INTERVAL_MS);
    await processGuild(harness.client, { guildId: GUILD_ID }, workspace, { store, now: digestAt });
    assert.equal(harness.sends.filter(send => send.title.includes('Your moderation work')).length, 2);
});

test('scheduler records a delivery only after Discord accepts it and retries a failed send', async t => {
    t.mock.method(console, 'error', () => {});
    const store = createStore();
    let notificationFailuresRemaining = 1;
    const harness = createDiscordHarness({
        failNotification: title => {
            if (!title.includes('attacks still open') || notificationFailuresRemaining <= 0) return false;
            notificationFailuresRemaining -= 1;
            return true;
        }
    });
    store.patchConfig(GUILD_ID, {
        enabled: true,
        channelId: CHANNEL_ID,
        features: { attackReminders: true }
    }, new Date('2026-08-10T07:00:00.000Z'));
    const workspace = buildWorkspace();

    const first = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(first.planned, 1);
    assert.deepEqual(first.sent, []);
    assert.equal(Object.keys(store.getGuild(GUILD_ID).deliveries).length, 0);

    const second = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(second.sent.length, 1);
    assert.equal(Object.keys(store.getGuild(GUILD_ID).deliveries).length, 2, 'the 6h and 2h reminder windows are consumed together');

    const third = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(third.planned, 0);
    assert.equal(harness.sends.filter(send => send.title.includes('attacks still open')).length, 2);
});

test('disabled installations perform no workspace or Discord work', async () => {
    const store = createStore();
    const result = await runWarFollowupTick({}, { store });
    assert.deepEqual(result, { skipped: true, reason: 'no-enabled-guilds' });
});

test('an opt-out that lands during a tick prevents the queued notification', async () => {
    const store = createStore();
    let disabled = false;
    const harness = createDiscordHarness({
        onSend: title => {
            if (title !== 'War Follow Up' || disabled) return;
            disabled = true;
            store.patchConfig(GUILD_ID, { enabled: false }, new Date('2026-08-10T08:30:01.000Z'));
        }
    });
    store.patchConfig(GUILD_ID, {
        enabled: true,
        channelId: CHANNEL_ID,
        features: { attackReminders: true }
    }, new Date('2026-08-10T07:00:00.000Z'));

    const result = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        buildWorkspace(),
        { store, now: NOW }
    );
    assert.deepEqual(result.sent, []);
    assert.equal(harness.sends.some(send => send.title.includes('attacks still open')), false);
    assert.equal(store.getGuild(GUILD_ID).observations.casesInitializedAt, '');
});

test('summary opt-in baselines existing wars and sends only a later finalization', async () => {
    const store = createStore();
    const harness = createDiscordHarness();
    store.patchConfig(GUILD_ID, {
        enabled: true,
        channelId: CHANNEL_ID,
        features: { regularWarSummaries: true }
    }, new Date('2026-08-10T07:00:00.000Z'));
    const workspace = buildWorkspace();
    workspace.rosterData.rosters[0].warPerformance = {
        regularWarHistoryByKey: {
            old: {
                warKey: 'old-war',
                authoritative: true,
                finalizedAt: '2026-08-10T07:30:00.000Z',
                statsByTag: { '#P0LYGQ': { possibleAttacks: 2, attacksMissed: 1 } }
            }
        }
    };

    const baseline = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(baseline.planned, 0);
    const afterBaseline = store.getGuild(GUILD_ID);
    assert.equal(afterBaseline.observations.summaryBaselinesInitialized.regularWarSummaries, true);
    assert.equal(Object.values(afterBaseline.deliveries).some(entry => entry.disposition === 'baseline'), true);

    workspace.rosterData.rosters[0].warPerformance.regularWarHistoryByKey.new = {
        warKey: 'new-war',
        authoritative: true,
        finalizedAt: '2026-08-10T08:25:00.000Z',
        statsByTag: { '#P0LYGQ': { possibleAttacks: 2, attacksMade: 2, countedAttacks: 2, starsTotal: 5, totalDestruction: 180 } }
    };
    const next = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(next.sent.length, 1);
    assert.equal(harness.sends.some(send => send.title.includes('regular war summary')), true);
});

test('moving or disabling an integration retires the old dashboard controls', async () => {
    const harness = createDiscordHarness();
    const message = await harness.channel.send({ embeds: [{ title: 'War Follow Up' }], components: [{ type: 1 }] });
    const retired = await retireDashboard(harness.client, GUILD_ID, CHANNEL_ID, message.id, {
        reason: 'This dashboard was moved.',
        newChannelId: '555555555555555555'
    });
    assert.equal(retired, true);
    assert.deepEqual(message.payload.components, []);
    assert.match(message.payload.embeds[0].description, /active dashboard is now/);
});

test('Moderation Hub is a persisted singleton that edits itself instead of adding channel messages', async () => {
    const store = createStore();
    const harness = createDiscordHarness();
    const workspace = buildWorkspace();

    const first = await ensureModerationHub(harness.client, GUILD_ID, workspace, {
        channel: harness.channel,
        store,
        force: true,
        now: NOW
    });
    assert.ok(first.message?.id);
    assert.equal(harness.sends.length, 1);
    assert.equal(harness.sends[0].title, 'Moderation Hub');
    assert.equal(store.getGuild(GUILD_ID).moderationHub.messageId, first.message.id);

    store.upsertModerator(GUILD_ID, '666666666666666666', {
        displayName: 'Leader',
        clanTags: ['#MAIN'],
        notificationMode: 'channel',
        accepting: true
    }, NOW);
    const second = await ensureModerationHub(harness.client, GUILD_ID, workspace, { store, now: NOW });
    assert.equal(second.message.id, first.message.id);
    assert.equal(harness.sends.length, 1, 'refresh edits the recorded message rather than posting another');
    assert.notEqual(second.semanticHash, first.semanticHash);
});

test('a failed assignment DM never rolls back ownership and releases its reservation for a later retry', async t => {
    t.mock.method(console, 'error', () => {});
    const store = createStore();
    const moderatorId = '666666666666666666';
    const staffRoleId = getStaffRoleIds()[0];
    let dmAttempts = 0;
    const guild = {
        members: {
            fetch: async ({ user }) => ({
                id: user,
                displayName: 'Assigned Leader',
                user: { username: 'assigned-leader' },
                roles: { cache: { has: roleId => roleId === staffRoleId } }
            })
        }
    };
    const harness = createDiscordHarness({
        guild,
        users: {
            fetch: async () => ({
                send: async () => {
                    dmAttempts += 1;
                    throw new Error('DMs disabled');
                }
            })
        }
    });
    store.patchConfig(GUILD_ID, {
        enabled: true,
        channelId: CHANNEL_ID
    }, new Date('2026-08-10T07:00:00.000Z'));
    store.upsertModerator(GUILD_ID, moderatorId, {
        displayName: 'Assigned Leader',
        clanTags: ['#MAIN'],
        notificationMode: 'dm',
        accepting: true
    }, NOW);
    const workspace = buildWorkspace();
    workspace.privateState.cases = [{
        tag: '#P0LYGQ',
        name: 'Alpha',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#MAIN',
        status: 'needs_review',
        assignedModeratorId: moderatorId,
        assignedModeratorName: 'Assigned Leader',
        handledBy: 'Assigned Leader',
        assignedAt: NOW.toISOString(),
        assignmentUpdatedAt: NOW.toISOString(),
        lastMeaningfulActionAt: NOW.toISOString(),
        openedAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        activity: []
    }];
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);

    const first = await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(first.planned, 1);
    assert.deepEqual(first.sent, []);
    assert.equal(dmAttempts, 1);
    assert.equal(workspace.work.items[0].case.assignedModeratorId, moderatorId);
    assert.deepEqual(store.getGuild(GUILD_ID).deliveries, {});

    await processGuild(
        harness.client,
        { guildId: GUILD_ID, ...store.getGuild(GUILD_ID) },
        workspace,
        { store, now: NOW }
    );
    assert.equal(dmAttempts, 2, 'a known failed delivery is safely retryable');
    assert.equal(workspace.work.items[0].case.assignedModeratorId, moderatorId);
});
