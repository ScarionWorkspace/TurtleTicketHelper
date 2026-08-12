'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { getStaffRoleIds } = require('../src/features/permissions/staffPermissions');
const workflow = require('../src/features/warFollowup/workflow');
const service = require('../src/features/warFollowup/service');
const moderation = require('../src/features/warFollowup/moderation');

const GUILD_ID = '111111111111111111';
const MOD_A = '222222222222222222';
const MOD_B = '333333333333333333';
const STAFF_ROLE_ID = getStaffRoleIds()[0];
const NOW = new Date('2026-08-10T12:00:00.000Z');

function moderator(discordId, overrides = {}) {
    return {
        discordId,
        displayName: discordId === MOD_A ? 'Leader A' : 'Leader B',
        clanTags: ['#CLAN0'],
        notificationMode: 'channel',
        accepting: true,
        updatedAt: '2026-08-01T00:00:00.000Z',
        lastAssignedAt: '',
        ...overrides
    };
}

function member(discordId, eligible = true) {
    return {
        id: discordId,
        displayName: discordId === MOD_A ? 'Leader A' : 'Leader B',
        user: { username: discordId },
        roles: { cache: { has: roleId => eligible && roleId === STAFF_ROLE_ID } }
    };
}

function guildWithEligibility(eligibility = {}) {
    return {
        members: {
            fetch: async ({ user }) => member(user, eligibility[user] !== false)
        }
    };
}

function buildWorkspace(caseValue = null) {
    const rosterData = {
        rosters: [{
            id: 'main',
            title: 'Main Clan',
            connectedClanTag: '#CLAN0',
            main: [{ tag: '#P0LYGQ', name: 'Player', discord: 'player', th: 18 }],
            subs: [],
            missing: []
        }],
        playerMetrics: {
            byTag: { '#P0LYGQ': { identity: { discordId: '444444444444444444' } } }
        }
    };
    const privateState = {
        settings: workflow.sanitizeSettings(null),
        cases: caseValue ? [caseValue] : []
    };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

function createStore(moderators) {
    const assignments = [];
    return {
        assignments,
        getGuild: () => ({ moderators }),
        recordModeratorAssignment: (...args) => assignments.push(args)
    };
}

test('automatic balancing prefers the fewest open cases, then the longest time without an assignment', () => {
    const eligible = [
        moderator(MOD_A, { lastAssignedAt: '2026-08-09T10:00:00.000Z' }),
        moderator(MOD_B, { lastAssignedAt: '2026-08-08T10:00:00.000Z' })
    ];
    const items = [{ status: 'needs_review', case: { assignedModeratorId: MOD_A } }];
    assert.equal(moderation.chooseModerator(eligible, items).discordId, MOD_B, 'fewest open cases wins');

    items.push({ status: 'waiting', case: { assignedModeratorId: MOD_B } });
    assert.equal(moderation.chooseModerator(eligible, items).discordId, MOD_B, 'older last assignment wins an open-case tie');
});

test('eligible moderators must be accepting, subscribed to the source clan, present, and still staff', async () => {
    const record = {
        moderators: {
            [MOD_A]: moderator(MOD_A),
            [MOD_B]: moderator(MOD_B)
        }
    };
    const eligible = await moderation.getEligibleModerators(
        guildWithEligibility({ [MOD_B]: false }),
        record,
        '#CLANO'
    );
    assert.deepEqual(eligible.map(entry => entry.discordId), [MOD_A]);
});

test('a new automated case is atomically created with its evidence snapshot and chosen owner', async t => {
    const workspace = buildWorkspace();
    workspace.work.items = [{
        tag: '#P0LYGQ',
        status: 'needs_review',
        player: workspace.work.directory.byTag['#P0LYGQ'],
        case: null,
        signals: [{ id: 'regular_missed:event', reasonCode: 'regular_missed', title: 'Regular attacks missed' }],
        signalIds: ['regular_missed:event'],
        evidence: { capturedAt: NOW.toISOString(), regular: { possibleAttacks: 2, missedAttacks: 2 }, cwl: {} }
    }];
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ item, action, patch });
        return {
            tag: item.tag,
            name: item.player.name,
            sourceRosterId: item.player.rosterId,
            sourceRosterTitle: item.player.rosterTitle,
            sourceClanTag: item.player.clanTag,
            status: 'needs_review',
            reasonCodes: patch.reasonCodes,
            evidence: patch.evidence,
            triggerSignalIds: patch.triggerSignalIds,
            assignedModeratorId: patch.assignedModeratorId,
            assignedModeratorName: patch.assignedModeratorName,
            handledBy: patch.handledBy,
            assignedAt: NOW.toISOString(),
            assignmentUpdatedAt: NOW.toISOString(),
            lastMeaningfulActionAt: NOW.toISOString(),
            openedAt: NOW.toISOString(),
            createdAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            activity: []
        };
    });
    const store = createStore({
        [MOD_A]: moderator(MOD_A, { lastAssignedAt: '2026-08-09T10:00:00.000Z' }),
        [MOD_B]: moderator(MOD_B, { lastAssignedAt: '2026-08-01T10:00:00.000Z' })
    });

    const result = await moderation.synchronizeModerationCases(
        guildWithEligibility(),
        GUILD_ID,
        workspace,
        store,
        { now: NOW }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'create_automatic');
    assert.equal(calls[0].patch.assignedModeratorId, MOD_B);
    assert.equal(calls[0].patch.sourceClanTag, '#CLAN0');
    assert.equal(calls[0].patch.evidence.regular.missedAttacks, 2);
    assert.equal(result.workspace.work.items[0].case.assignedModeratorId, MOD_B);
    assert.equal(store.assignments.length, 1);
});

test('72 hours of inactivity reassigns to another eligible moderator and never selects the inactive owner when an alternative exists', async t => {
    const oldAction = new Date(NOW.getTime() - 73 * 60 * 60 * 1000).toISOString();
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        name: 'Player',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        status: 'needs_review',
        assignedModeratorId: MOD_A,
        assignedModeratorName: 'Leader A',
        handledBy: 'Leader A',
        assignedAt: oldAction,
        assignmentUpdatedAt: oldAction,
        lastMeaningfulActionAt: oldAction,
        createdAt: oldAction,
        updatedAt: oldAction,
        activity: []
    });
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ action, patch });
        return {
            ...item.case,
            ...patch,
            tag: item.tag,
            status: item.case.status,
            assignedAt: NOW.toISOString(),
            assignmentUpdatedAt: NOW.toISOString(),
            lastMeaningfulActionAt: NOW.toISOString(),
            updatedAt: NOW.toISOString()
        };
    });
    const store = createStore({ [MOD_A]: moderator(MOD_A), [MOD_B]: moderator(MOD_B) });

    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'assign_owner');
    assert.equal(calls[0].patch.assignedModeratorId, MOD_B);
});

test('an owner who loses staff eligibility is removed even when nobody else is available', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        status: 'needs_review',
        assignedModeratorId: MOD_A,
        assignedModeratorName: 'Leader A',
        assignmentCoverageOverride: true,
        handledBy: 'Leader A',
        assignedAt: NOW.toISOString(),
        assignmentUpdatedAt: NOW.toISOString(),
        lastMeaningfulActionAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        activity: []
    });
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ action, patch });
        return {
            ...item.case,
            tag: item.tag,
            status: item.case.status,
            handledBy: '',
            assignedModeratorId: '',
            assignedModeratorName: '',
            assignedAt: '',
            assignmentUpdatedAt: new Date(NOW.getTime() + 1).toISOString(),
            lastMeaningfulActionAt: new Date(NOW.getTime() + 1).toISOString(),
            updatedAt: new Date(NOW.getTime() + 1).toISOString()
        };
    });
    const store = createStore({ [MOD_A]: moderator(MOD_A) });

    await moderation.synchronizeModerationCases(
        guildWithEligibility({ [MOD_A]: false }),
        GUILD_ID,
        workspace,
        store,
        { now: NOW }
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'unassign_owner');
});

test('a senior leader who explicitly took a case remains assigned outside automatic coverage', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        status: 'needs_review',
        assignedModeratorId: MOD_A,
        assignedModeratorName: 'Leader A',
        assignmentCoverageOverride: true,
        handledBy: 'Leader A',
        assignedAt: NOW.toISOString(),
        assignmentUpdatedAt: NOW.toISOString(),
        lastMeaningfulActionAt: NOW.toISOString(),
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        activity: []
    });
    const calls = [];
    t.mock.method(service, 'mutateCase', async (...args) => {
        calls.push(args);
        return workspace.work.items[0].case;
    });
    const store = createStore({
        [MOD_A]: moderator(MOD_A, { accepting: false, clanTags: [] })
    });

    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });

    assert.equal(calls.length, 0);
});

test('a future waiting follow-up pauses inactivity reassignment without masking lost eligibility', async t => {
    const oldAction = new Date(NOW.getTime() - 80 * 60 * 60 * 1000).toISOString();
    const waitingUntil = new Date(NOW.getTime() + 4 * 60 * 60 * 1000).toISOString();
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        status: 'waiting',
        assignedModeratorId: MOD_A,
        assignedModeratorName: 'Leader A',
        handledBy: 'Leader A',
        assignedAt: oldAction,
        assignmentUpdatedAt: oldAction,
        lastMeaningfulActionAt: oldAction,
        waitingUntil,
        createdAt: oldAction,
        updatedAt: oldAction,
        activity: []
    });
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ action, patch });
        return { ...item.case, ...patch, tag: item.tag, updatedAt: NOW.toISOString() };
    });
    const store = createStore({ [MOD_A]: moderator(MOD_A), [MOD_B]: moderator(MOD_B) });

    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });
    assert.equal(calls.length, 0, 'scheduled waiting suppresses inactivity reassignment');

    await moderation.synchronizeModerationCases(
        guildWithEligibility({ [MOD_A]: false }),
        GUILD_ID,
        workspace,
        store,
        { now: NOW }
    );
    assert.equal(calls.length, 1, 'lost staff eligibility still triggers reassignment');
    assert.equal(calls[0].action, 'assign_owner');
    assert.equal(calls[0].patch.assignedModeratorId, MOD_B);
});

test('monitoring leaves active ownership and scheduler transitions are idempotent', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        name: 'Player',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        status: 'watching',
        watchStartedAt: '2026-08-01T00:00:00.000Z',
        watchWarTarget: 2,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        activity: []
    });
    workspace.work.items[0] = {
        ...workspace.work.items[0],
        status: 'needs_review',
        signals: [{ id: 'regular_missed:new-war', reasonCode: 'regular_missed', title: 'Regular attacks missed' }],
        signalIds: ['regular_missed:new-war'],
        watching: {
            completedWars: 1,
            targetWars: 2,
            triggered: true,
            ready: true,
            evidence: { capturedAt: NOW.toISOString(), regular: { possibleAttacks: 2, missedAttacks: 2 }, cwl: {} }
        }
    };
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ action, patch });
        return {
            ...item.case,
            ...patch,
            tag: item.tag,
            status: 'needs_review',
            assignedAt: NOW.toISOString(),
            assignmentUpdatedAt: NOW.toISOString(),
            lastMeaningfulActionAt: NOW.toISOString(),
            openedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString()
        };
    });
    const store = createStore({ [MOD_A]: moderator(MOD_A) });

    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });
    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, 'watch_triggered');
    assert.equal(calls[0].patch.assignedModeratorId, MOD_A);
    assert.deepEqual(calls[0].patch.triggerSignalIds, ['regular_missed:new-war']);
});

test('removal confirmation and later rejoin detection each run once', async t => {
    const removedAt = '2026-08-09T00:00:00.000Z';
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        name: 'Player',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main Clan',
        sourceClanTag: '#CLAN0',
        contactPurpose: 'removal',
        status: 'removal_pending',
        assignedModeratorId: MOD_A,
        assignedModeratorName: 'Leader A',
        handledBy: 'Leader A',
        removalReason: 'Repeated missed attacks after prior contact.',
        createdAt: removedAt,
        updatedAt: removedAt,
        lastMeaningfulActionAt: NOW.toISOString(),
        activity: []
    });
    workspace.rosterData.rosters[0].main = [];
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);
    const calls = [];
    t.mock.method(service, 'mutateCase', async (item, action, patch) => {
        calls.push({ action, patch });
        if (action === 'removal_confirmed') {
            return {
                ...item.case,
                tag: item.tag,
                status: 'removed',
                outcome: 'removed',
                removalAbsentObservedAt: NOW.toISOString(),
                closedAt: NOW.toISOString(),
                updatedAt: NOW.toISOString()
            };
        }
        return {
            ...item.case,
            ...patch,
            tag: item.tag,
            status: 'removal_evasion',
            outcome: '',
            removalRejoinedAt: NOW.toISOString(),
            openedAt: NOW.toISOString(),
            closedAt: '',
            updatedAt: NOW.toISOString()
        };
    });
    const store = createStore({ [MOD_A]: moderator(MOD_A) });

    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });
    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });
    assert.deepEqual(calls.map(call => call.action), ['removal_confirmed']);

    workspace.rosterData.rosters[0].main = [{ tag: '#P0LYGQ', name: 'Player', discord: 'player', th: 18 }];
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);
    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });
    await moderation.synchronizeModerationCases(guildWithEligibility(), GUILD_ID, workspace, store, { now: NOW });

    assert.deepEqual(calls.map(call => call.action), ['removal_confirmed', 'removal_rejoined']);
    assert.equal(calls[1].patch.rejoinRosterTitle, 'Main Clan');
    assert.equal(workspace.work.items[0].case.status, 'removal_evasion');
});
