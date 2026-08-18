'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const command = require('../src/commands/warFollowup/warFollowup');
const workflow = require('../src/features/warFollowup/workflow');
const views = require('../src/features/warFollowup/views');
const { assertCaseActionAllowed, directDmDeliveryKey } = require('../src/features/warFollowup/interaction');
const {
    buildCustomId,
    parseCustomId
} = require('../src/features/warFollowup/customIds');

function buildWorkspace(caseValue = null) {
    const rosterData = {
        lastUpdatedAt: '2026-08-01T00:00:00.000Z',
        rosters: [{
            id: 'main-roster',
            title: 'Main',
            connectedClanTag: '#MAIN',
            trackingMode: 'regularWar',
            main: [{ tag: '#PLAYER', name: 'Player', discord: 'player', th: 18 }],
            subs: [],
            missing: []
        }, {
            id: 'hero-down-roster-with-a-readable-name',
            title: 'Hero-down',
            connectedClanTag: '#HERO',
            trackingMode: 'regularWar',
            main: [],
            subs: [],
            missing: []
        }],
        playerMetrics: {
            byTag: {
                '#PLAYER': { identity: { discordId: '111111111111111111', discordUsername: 'player' } }
            }
        },
        playerWarPerformance: {
            byTag: {
                '#PLAYER': {
                    recentRegularWarForm: [{
                        warKey: 'war-1',
                        finalizedAt: '2026-08-01T00:00:00.000Z',
                        clanTag: '#MAIN',
                        stats: { possibleAttacks: 2, attacksMissed: 2 }
                    }]
                }
            }
        }
    };
    const privateState = {
        settings: workflow.sanitizeSettings({ moderatorNames: ['Alex', 'Sam'] }),
        cases: caseValue ? [caseValue] : []
    };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

function config() {
    return {
        enabled: true,
        channelId: '222222222222222222',
        staffRoleId: '333333333333333333',
        features: { directMessages: true }
    };
}

function serialize(payload) {
    return JSON.parse(JSON.stringify(payload));
}

function collectCustomIds(value, out = []) {
    if (Array.isArray(value)) {
        for (const item of value) collectCustomIds(item, out);
    } else if (value && typeof value === 'object') {
        if (typeof value.custom_id === 'string') out.push(value.custom_id);
        for (const nested of Object.values(value)) collectCustomIds(nested, out);
    }
    return out;
}

test('/war-follow-up exposes the private tools and public moderation-panel publisher', () => {
    const json = command.data.toJSON();
    assert.ok(json.dm_permission === false || json.contexts?.includes(0), 'the staff workflow must be guild-only');
    assert.deepEqual(json.options.map(option => option.name), [
        'panel',
        'moderation',
        'overview',
        'mine',
        'publish-panel',
        'setup',
        'case',
        'ignored',
        'rules',
        'status',
        'sync-now'
    ]);
    const publishPanel = json.options.find(option => option.name === 'publish-panel');
    assert.equal(publishPanel.options.find(option => option.name === 'channel').required, true);
    const setup = json.options.find(option => option.name === 'setup');
    for (const name of [
        'channel',
        'staff-role',
        'enabled',
        'case-alerts',
        'attack-reminders',
        'regular-summaries',
        'cwl-daily-updates',
        'cwl-end-summaries',
        'discord-gap-report',
        'direct-dms'
    ]) {
        assert.ok(setup.options.some(option => option.name === name), `missing setup option ${name}`);
    }
    assert.equal(setup.options.filter(option => option.name.endsWith('summaries')).every(option => option.required !== true), true);
});

test('player input resolves exact and unique names while rejecting ambiguous searches', () => {
    const directory = {
        byTag: {
            '#P0LYGQ': { tag: '#P0LYGQ', name: 'Alpha' },
            '#P0LYGJ': { tag: '#P0LYGJ', name: 'Alpha Two' }
        },
        players: [
            { tag: '#P0LYGQ', name: 'Alpha', rosterTitle: 'Main' },
            { tag: '#P0LYGJ', name: 'Alpha Two', rosterTitle: 'Feeder' }
        ],
        missingTags: new Set(['#9P0LYG'])
    };
    assert.equal(command.resolvePlayerInput('Alpha', directory), '#P0LYGQ');
    assert.equal(command.resolvePlayerInput('two', directory), '#P0LYGJ');
    assert.equal(command.resolvePlayerInput('P0LYGQ', directory), '#P0LYGQ');
    assert.equal(command.resolvePlayerInput('#28PYLQ', directory), '#28PYLQ');
    assert.throws(() => command.resolvePlayerInput('alp', directory), /multiple accounts/);
    assert.throws(() => command.resolvePlayerInput('#9P0LYG', directory), /archived or missing/);
    assert.throws(() => command.resolvePlayerInput('not a player', directory), /No roster account/);
});

test('setup rejects a staff role the bot cannot actually notify', () => {
    const interaction = { guild: { members: { me: {} } } };
    const deniedChannel = { permissionsFor: () => ({ has: () => false }) };
    const allowedChannel = { permissionsFor: () => ({ has: () => true }) };
    assert.equal(command.canMentionRole({ mentionable: true }, deniedChannel, interaction), true);
    assert.equal(command.canMentionRole({ mentionable: false }, deniedChannel, interaction), false);
    assert.equal(command.canMentionRole({ mentionable: false }, allowedChannel, interaction), true);
    assert.equal(command.canMentionRole({ id: '111111111111111111', mentionable: true }, allowedChannel, {
        ...interaction,
        guildId: '111111111111111111'
    }), false, 'the @everyone role is never a valid staff notification role');
    const everyone = { id: '111111111111111111' };
    assert.equal(command.everyoneCanViewChannel({
        permissionsFor: role => ({ has: permission => role === everyone && permission === 1024n })
    }, {
        guildId: '111111111111111111',
        guild: { roles: { everyone } }
    }), true);
    assert.equal(command.everyoneCanViewChannel({
        permissionsFor: () => ({ has: () => false })
    }, {
        guildId: '111111111111111111',
        guild: { roles: { everyone } }
    }), false);
});

test('versioned custom IDs round-trip safely and enforce Discord limits', () => {
    const id = buildCustomId('heroform', '#PLAYER', 'roster-token');
    assert.ok(id.length <= 100);
    assert.deepEqual(parseCustomId(id), {
        action: 'heroform',
        values: ['#PLAYER', 'roster-token']
    });
    assert.throws(() => buildCustomId('heroform', 'x'.repeat(200)), /exceeds 100/);
});

test('case action tokens change when a moderator decision changes', () => {
    const first = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'First decision',
        updatedAt: '2026-08-01T00:00:00.000Z'
    }).work.items[0];
    const second = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'Updated decision',
        updatedAt: '2026-08-01T00:01:00.000Z'
    }).work.items[0];
    assert.notEqual(views.caseToken(first), views.caseToken(second));

    const relinked = {
        ...second,
        player: { ...second.player, discordId: '999999999999999999' }
    };
    assert.notEqual(views.caseToken(second), views.caseToken(relinked), 'a relink must invalidate any pending direct-DM button');
});

test('crafted controls cannot bypass lifecycle prerequisites', () => {
    assert.throws(
        () => assertCaseActionAllowed({ status: 'needs_review' }, 'approve_return'),
        /not completed/
    );
    assert.throws(
        () => assertCaseActionAllowed({ status: 'closed' }, 'mark_dm_sent'),
        /no longer valid/
    );
    assert.doesNotThrow(() => assertCaseActionAllowed({
        status: 'ready',
        recovery: { ready: true }
    }, 'approve_return'));
    assert.doesNotThrow(() => assertCaseActionAllowed({ status: 'ready' }, 'extend'));
    assert.throws(
        () => assertCaseActionAllowed({ status: 'closed', case: { status: 'closed' } }, 'approve_rejoin'),
        /not under rejoin monitoring/
    );
    assert.doesNotThrow(() => assertCaseActionAllowed({ status: 'needs_review', case: { status: 'needs_review' } }, 'resolve'));
    for (const action of ['contact', 'watch', 'hero_down', 'wait', 'dismiss', 'resolve', 'reopen']) {
        assert.throws(
            () => assertCaseActionAllowed({ status: 'needs_review', case: { status: 'removal_evasion' } }, action),
            /removal workflow/,
            `${action} must not bypass a removal-evasion decision`
        );
    }
    const decision = {
        tag: '#P0LYGQ',
        case: {
            dmText: 'Decision text',
            targetRosterId: 'hero-down',
            targetClanTag: '#9PYLQG',
            recoveryWarTarget: 3,
            requireNoMisses: true,
            activity: [{ id: 'decision-1', at: '2026-08-01T00:00:00.000Z', type: 'hero_down_decision' }]
        }
    };
    const deliveryKey = directDmDeliveryKey(decision);
    assert.match(deliveryKey, /^direct-dm:#P0LYGQ:[^:]{8,}$/);
    assert.equal(
        directDmDeliveryKey({
            ...decision,
            case: {
                ...decision.case,
                handledBy: 'Another moderator',
                updatedAt: '2026-08-02T00:00:00.000Z',
                activity: [
                    ...decision.case.activity,
                    { id: 'note-1', at: '2026-08-02T00:00:00.000Z', type: 'note' }
                ]
            }
        }),
        deliveryKey,
        'notes and assignments must not make the same decision DM sendable twice'
    );
    assert.notEqual(
        directDmDeliveryKey({
            ...decision,
            case: {
                ...decision.case,
                activity: [
                    ...decision.case.activity,
                    { id: 'decision-2', at: '2026-08-03T00:00:00.000Z', type: 'extended' }
                ]
            }
        }),
        deliveryKey,
        'an explicit new or extended decision gets its own delivery identity'
    );
});

test('dashboard and private queue remain within Discord component and custom-ID limits', () => {
    const workspace = buildWorkspace();
    const payloads = [
        views.buildDashboardPayload(workspace, config()).payload,
        views.buildHomePayload(workspace, config()),
        views.buildGapsPayload(workspace),
        views.buildIgnoredPayload(workspace),
        views.buildRulesPayload(workspace)
    ].map(serialize);

    for (const payload of payloads) {
        assert.ok((payload.components || []).length <= 5);
        assert.equal(collectCustomIds(payload).every(id => id.length <= 100), true);
    }
});

test('public Moderation Hub is a clean personalized entry point with stable automatic-update semantics', () => {
    const workspace = buildWorkspace();
    const guildRecord = {
        moderators: {
            '222222222222222222': {
                discordId: '222222222222222222',
                displayName: 'Leader',
                clanTags: ['#MAIN'],
                notificationMode: 'both',
                accepting: true
            }
        }
    };
    const built = views.buildModerationHubPayload(workspace, guildRecord, {
        now: new Date('2026-08-09T12:00:00.000Z')
    });
    const json = serialize(built.payload);
    const rendered = JSON.stringify(json);
    assert.match(rendered, /Moderation Hub/);
    assert.match(rendered, /Choose clans/);
    assert.match(rendered, /Main/);
    assert.match(rendered, /1 leader/);
    assert.match(rendered, /Current workload/);
    assert.match(rendered, /No attacks pending/);
    assert.match(rendered, /Use My cases for your assigned work/);
    assert.doesNotMatch(rendered, /digest|grouped|cadence|cooldown/i);
    assert.doesNotMatch(rendered, /Fair workload assignment|24h\/48h|72h reassignment/);
    assert.equal(Object.prototype.hasOwnProperty.call(json, 'flags'), false, 'the singleton panel itself is public');
    assert.equal(json.components.length, 2);
    assert.deepEqual(json.components.map(row => row.components.map(component => component.label)), [
        ['Choose clans', 'My cases'],
        ['Needs attention (1)', 'Recent activity', 'All cases']
    ]);
    assert.doesNotMatch(rendered, /"label":"Coverage"/);
    assert.equal(collectCustomIds(json).every(id => id.length <= 100), true);

    const paused = views.buildModerationHubPayload(workspace, {
        moderators: {
            '222222222222222222': {
                ...guildRecord.moderators['222222222222222222'],
                accepting: false
            }
        }
    }, { now: new Date('2026-08-09T12:00:00.000Z') });
    assert.notEqual(paused.semanticHash, built.semanticHash, 'changing coverage causes an in-place panel refresh');
});

test('Choose clans includes live team coverage and workload without a separate coverage view', () => {
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_review',
        assignedModeratorId: '222222222222222222',
        assignedModeratorName: 'Leader',
        updatedAt: '2026-08-10T10:00:00.000Z'
    });
    const guildRecord = {
        moderators: {
            '222222222222222222': {
                discordId: '222222222222222222',
                displayName: 'Leader',
                clanTags: ['#MAIN'],
                notificationMode: 'both',
                accepting: true,
                lastAssignedAt: '2026-08-10T10:00:00.000Z'
            },
            '333333333333333333': {
                discordId: '333333333333333333',
                displayName: 'Paused Leader',
                clanTags: ['#HERO'],
                notificationMode: 'channel',
                accepting: false
            }
        }
    };

    const payload = serialize(views.buildModeratorSettingsPayload(
        workspace,
        guildRecord,
        '222222222222222222',
        'Leader',
        {
            eligibleIds: new Set(['222222222222222222']),
            now: new Date('2026-08-10T12:00:00.000Z')
        }
    ));
    const rendered = JSON.stringify(payload);

    assert.match(rendered, /Team coverage/);
    assert.match(rendered, /Team workload/);
    assert.match(rendered, /Leader.*1 active case/);
    assert.match(rendered, /Paused Leader.*paused/);
    assert.match(rendered, /#MAIN.*1 available/);
    assert.match(rendered, /#HER0.*needs coverage.*1 paused/i);
    assert.doesNotMatch(rendered, /"label":"Coverage"/);
});

test('Recent activity combines case audits, sorts newest first, and keeps private text inside cases', () => {
    const workspace = buildWorkspace();
    workspace.privateState.cases = [{
        tag: '#PLAYER',
        name: 'Player',
        status: 'closed',
        activity: [{
            id: 'old-note',
            at: '2026-08-10T10:00:00.000Z',
            type: 'note',
            actor: 'Alex',
            text: 'Sensitive private note contents'
        }, {
            id: 'new-resolution',
            at: '2026-08-10T11:00:00.000Z',
            type: 'resolved',
            actor: 'Sam',
            text: 'Case closed: internal resolution details'
        }]
    }];

    const payload = serialize(views.buildRecentActivityPayload(workspace, { page: 0 }));
    const rendered = JSON.stringify(payload);
    const description = payload.embeds[0].description;

    assert.match(rendered, /Recent case activity/);
    assert.ok(description.indexOf('Resolved case') < description.indexOf('Added a private note'));
    assert.doesNotMatch(rendered, /Sensitive private note contents|internal resolution details/);
    assert.match(rendered, /Open a case from this page/);
});

test('Needs attention deduplicates shared exceptions and explains why each case is listed', () => {
    const workspace = buildWorkspace();
    workspace.work.items = [{
        tag: '#UNASSIGNED',
        status: 'needs_review',
        player: { name: 'Unassigned Player' },
        case: {
            status: 'needs_review',
            updatedAt: '2026-08-08T10:00:00.000Z',
            lastMeaningfulActionAt: '2026-08-08T10:00:00.000Z'
        }
    }, {
        tag: '#RESPONSE',
        status: 'needs_review',
        player: { name: 'Reply Player' },
        case: {
            status: 'needs_review',
            assignedModeratorId: '222222222222222222',
            assignedModeratorName: 'Leader',
            contactStage: 'responded',
            playerResponseAt: '2026-08-10T11:00:00.000Z',
            lastMeaningfulActionAt: '2026-08-10T11:00:00.000Z'
        }
    }, {
        tag: '#NORMAL',
        status: 'needs_review',
        player: { name: 'Normal Assigned Case' },
        case: {
            status: 'needs_review',
            assignedModeratorId: '222222222222222222',
            lastMeaningfulActionAt: '2026-08-10T11:30:00.000Z'
        }
    }, {
        tag: '#DUE',
        status: 'waiting',
        player: { name: 'Due Follow-up' },
        case: {
            status: 'waiting',
            assignedModeratorId: '222222222222222222',
            assignedModeratorName: 'Leader',
            waitingUntil: '2026-08-10T11:30:00.000Z',
            lastMeaningfulActionAt: '2026-08-09T11:30:00.000Z'
        }
    }];

    const entries = views.moderationAttentionItems(workspace, {}, new Date('2026-08-10T12:00:00.000Z'));
    const payload = serialize(views.buildAttentionPayload(workspace, {}, {
        now: new Date('2026-08-10T12:00:00.000Z')
    }));
    const rendered = JSON.stringify(payload);

    assert.equal(entries.length, 3);
    assert.deepEqual(entries[0].reasons, ['Unassigned']);
    assert.deepEqual(entries.find(entry => entry.item.tag === '#RESPONSE').reasons, ['Player replied']);
    assert.deepEqual(entries.find(entry => entry.item.tag === '#DUE').reasons, ['Follow-up due']);
    assert.match(rendered, /Unassigned Player.*Unassigned/);
    assert.match(rendered, /Reply Player.*Player replied/);
    assert.doesNotMatch(rendered, /Normal Assigned Case/);
});

test('new Hub views paginate safely within Discord limits', () => {
    const workspace = buildWorkspace();
    workspace.work.items = Array.from({ length: 30 }, (_, index) => ({
        tag: `#CASE${index}`,
        status: 'needs_review',
        player: { name: `Player ${index} ${'Long name '.repeat(8)}` },
        case: { status: 'needs_review', updatedAt: `2026-08-10T10:${String(index).padStart(2, '0')}:00.000Z` }
    }));
    workspace.privateState.cases = workspace.work.items.map((item, index) => ({
        tag: item.tag,
        name: item.player.name,
        status: 'needs_review',
        activity: [{
            id: `activity-${index}`,
            at: `2026-08-10T10:${String(index).padStart(2, '0')}:00.000Z`,
            type: 'automatic_case',
            actor: 'War Follow Up',
            text: 'Opened from automated evidence.'
        }]
    }));

    const payloads = [
        serialize(views.buildAttentionPayload(workspace, {}, { now: new Date('2026-08-10T12:00:00.000Z') })),
        serialize(views.buildRecentActivityPayload(workspace, { page: 0 }))
    ];
    for (const payload of payloads) {
        assert.ok(payload.embeds[0].description.length <= 4096);
        assert.ok(payload.components.length <= 5);
        assert.equal(payload.components.every(row => row.components.length <= 5), true);
        assert.equal(collectCustomIds(payload).every(id => id.length <= 100), true);
    }
});

test('Moderation Hub separates actionable work from cases awaiting player replies', () => {
    const workspace = buildWorkspace();
    const assignedModeratorId = '222222222222222222';
    const waitingCases = Array.from({ length: 4 }, (_, index) => ({
        tag: `#WAIT${index}`,
        status: 'waiting',
        case: {
            status: 'waiting',
            contactPurpose: 'general',
            dmSentAt: '2026-08-10T10:00:00.000Z',
            waitingUntil: '2026-08-11T10:00:00.000Z',
            assignedModeratorId,
            assignedAt: '2026-08-10T10:00:00.000Z',
            lastMeaningfulActionAt: '2026-08-10T10:00:00.000Z'
        }
    }));
    workspace.work.items = [
        ...waitingCases,
        {
            tag: '#HERO1',
            status: 'hero_down',
            case: {
                status: 'hero_down',
                assignedModeratorId,
                assignedAt: '2026-08-10T10:00:00.000Z',
                lastMeaningfulActionAt: '2026-08-10T10:00:00.000Z'
            }
        }
    ];
    const guildRecord = {
        moderators: {
            [assignedModeratorId]: {
                discordId: assignedModeratorId,
                displayName: 'Leader',
                clanTags: ['#MAIN', '#HERO'],
                accepting: true
            }
        }
    };

    const payload = serialize(views.buildModerationHubPayload(workspace, guildRecord, {
        now: new Date('2026-08-10T12:00:00.000Z')
    }).payload);
    const rendered = JSON.stringify(payload);

    assert.match(rendered, /5 tracked/);
    assert.match(rendered, /0 actionable/);
    assert.match(rendered, /4 awaiting player replies/);
    assert.match(rendered, /1 hero-down recovery/);
    assert.match(rendered, /5 assigned/);
    assert.doesNotMatch(rendered, /5 open/);
    assert.doesNotMatch(rendered, /in progress/i);
});

test('a due waiting case is actionable instead of being reported as still waiting', () => {
    const workspace = buildWorkspace();
    workspace.work.items = [{
        tag: '#DUE1',
        status: 'waiting',
        case: {
            status: 'waiting',
            contactPurpose: 'general',
            dmSentAt: '2026-08-08T10:00:00.000Z',
            waitingUntil: '2026-08-09T10:00:00.000Z',
            assignedModeratorId: '222222222222222222',
            lastMeaningfulActionAt: '2026-08-08T10:00:00.000Z'
        }
    }];

    const summary = views.moderationCaseSummary(workspace, {}, new Date('2026-08-10T12:00:00.000Z'));

    assert.equal(summary.actionable.length, 1);
    assert.equal(summary.waiting.length, 0);
    assert.equal(summary.awaitingPlayer.length, 0);
    assert.equal(summary.overdue.length, 1);
});

test('My cases separates immediate work from replies and active recovery or removal', () => {
    const workspace = buildWorkspace();
    const moderatorId = '222222222222222222';
    workspace.work.items = [{
        tag: '#REVIEW1',
        status: 'needs_review',
        player: { name: 'Review Player' },
        case: { status: 'needs_review', assignedModeratorId: moderatorId }
    }, {
        tag: '#REPLY1',
        status: 'waiting',
        player: { name: 'Reply Player' },
        case: {
            status: 'waiting',
            contactPurpose: 'general',
            dmSentAt: '2026-08-10T10:00:00.000Z',
            waitingUntil: '2026-08-11T10:00:00.000Z',
            assignedModeratorId: moderatorId
        }
    }, {
        tag: '#HERO1',
        status: 'hero_down',
        player: { name: 'Recovery Player' },
        case: { status: 'hero_down', assignedModeratorId: moderatorId }
    }, {
        tag: '#REMOVE1',
        status: 'removal_pending',
        player: { name: 'Removal Player' },
        case: {
            status: 'removal_pending',
            removalActionedAt: '2026-08-10T10:30:00.000Z',
            assignedModeratorId: moderatorId
        }
    }];

    const rendered = JSON.stringify(serialize(views.buildMyCasesPayload(workspace, moderatorId, {
        now: new Date('2026-08-10T12:00:00.000Z')
    })));

    assert.match(rendered, /Needs action \(1\)/);
    assert.match(rendered, /Awaiting player replies \(1\)/);
    assert.match(rendered, /Active recovery\/removal \(2\)/);
    assert.match(rendered, /Hero-down recovery/);
    assert.match(rendered, /Awaiting removal confirmation/);
    assert.match(rendered, /Nothing needs action right now|Start with Needs action/);
    assert.doesNotMatch(rendered, /in progress/i);
});

test('My cases replaces a stale backend task with its durable local syncing state', () => {
    const workspace = buildWorkspace();
    const moderatorId = '222222222222222222';
    workspace.work.items = [{
        tag: '#REVIEW1',
        status: 'needs_review',
        player: { name: 'Review Player' },
        case: { status: 'needs_review', assignedModeratorId: moderatorId }
    }];
    const payload = views.buildMyCasesPayload(workspace, moderatorId, {
        pendingMutations: [{
            id: 'discord-wfu-pending-view',
            state: 'pending',
            action: 'contact',
            tag: '#REVIEW1',
            actorId: moderatorId
        }]
    });
    const rendered = JSON.stringify(serialize(payload));

    assert.match(rendered, /Saved changes \(1\)/);
    assert.match(rendered, /Player message/);
    assert.match(rendered, /Saving/);
    assert.doesNotMatch(rendered, /backend|local|restart/i);
    assert.match(rendered, /Needs action \(0\)/);
    assert.match(rendered, /Open a saved change/);
    assert.equal(payload.components.length <= 5, true);
});

test('assignment picker makes taking ownership explicit while retaining manual reassignment', () => {
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_review',
        assignedModeratorId: '999999999999999999',
        assignedModeratorName: 'Previous owner',
        updatedAt: '2026-08-10T10:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const payload = serialize(views.buildReassignmentPayload(item, [{
        discordId: '222222222222222222',
        displayName: 'Current leader',
        notificationMode: 'channel'
    }, {
        discordId: '333333333333333333',
        displayName: 'Another leader',
        notificationMode: 'dm'
    }], {
        currentModeratorId: '222222222222222222',
        currentModeratorName: 'Current leader'
    }));
    const rendered = JSON.stringify(payload);

    assert.match(rendered, /Take ownership/);
    assert.match(rendered, /Another leader/);
    assert.match(rendered, /Assign automatically/);
    assert.match(rendered, /reassign the case/i);
    assert.match(JSON.stringify(serialize(views.buildCasePayload(item, workspace, config()))), /Change owner/);

    const seniorPayload = serialize(views.buildReassignmentPayload(item, [], {
        currentModeratorId: '222222222222222222',
        currentModeratorName: 'Current leader',
        canTakeAnyCase: true
    }));
    assert.match(JSON.stringify(seniorPayload), /without changing your automatic coverage/i);
});

test('the moderation panel accepts an existing staff-only channel', () => {
    const publishPanel = command.data.toJSON().options.find(option => option.name === 'publish-panel');
    assert.match(publishPanel.description, /staff-only channel/i);
    assert.doesNotMatch(JSON.stringify(publishPanel), /empty channel/i);
    assert.equal(Object.prototype.hasOwnProperty.call(command, 'panelChannelIsEmpty'), false);
});

test('moderator settings, coverage, and personal ownership views stay within Discord UI limits', () => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'waiting',
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main',
        sourceClanTag: '#2LUCULP',
        assignedModeratorId: '222222222222222222',
        assignedModeratorName: 'Moderator',
        handledBy: 'Moderator',
        assignedAt: '2026-08-01T00:00:00.000Z',
        assignmentUpdatedAt: '2026-08-01T00:00:00.000Z',
        lastMeaningfulActionAt: '2026-08-01T00:00:00.000Z',
        waitingUntil: '2026-08-02T00:00:00.000Z',
        openedAt: '2026-08-01T00:00:00.000Z',
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        activity: []
    });
    const guildRecord = {
        moderators: {
            '222222222222222222': {
                discordId: '222222222222222222',
                displayName: 'Moderator',
                clanTags: ['#2LUCULP'],
                notificationMode: 'both',
                accepting: true
            }
        }
    };
    const settingsPayload = views.buildModeratorSettingsPayload(workspace, guildRecord, '222222222222222222', 'Moderator');
    const settingsRendered = JSON.stringify(serialize(settingsPayload));
    assert.match(settingsRendered, /Moderation settings/);
    assert.match(settingsRendered, /Choose clans/);
    assert.match(settingsRendered, /Pause new assignments/);
    assert.doesNotMatch(settingsRendered, /Step 1|Step 2|Step 3/);
    const payloads = [
        settingsPayload,
        views.buildCoveragePayload(workspace, guildRecord, { eligibleIds: new Set(['222222222222222222']) }),
        views.buildMyCasesPayload(workspace, '222222222222222222')
    ];
    for (const payload of payloads) {
        assert.ok(payload.components.length <= 5);
        assert.equal(payload.components.every(row => row.toJSON().components.length <= 5), true);
        assert.equal(collectCustomIds(payload.components.map(row => row.toJSON())).every(id => id.length <= 100), true);
    }
    const assignedCase = workspace.work.items.find(item => item.tag === '#P0LYGQ');
    const caseJson = views.buildCasePayload(assignedCase, workspace, { features: {} }).embeds[0].toJSON();
    assert.match(JSON.stringify(caseJson), /Assigned moderator/);
    assert.match(JSON.stringify(caseJson), /Case source/);
    assert.doesNotMatch(JSON.stringify(caseJson), /Case source snapshot/);

    const monitoringWorkspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'watching',
        sourceRosterId: 'main-roster',
        sourceRosterTitle: 'Main',
        sourceClanTag: '#MAIN',
        assignedModeratorId: '222222222222222222',
        assignedModeratorName: 'Moderator',
        watchStartedAt: '2026-08-02T00:00:00.000Z',
        watchWarTarget: 2,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
        activity: []
    });
    const myMonitoring = JSON.stringify(serialize(
        views.buildMyCasesPayload(monitoringWorkspace, '222222222222222222')
    ));
    assert.match(myMonitoring, /no assigned moderation cases/i);
    assert.doesNotMatch(myMonitoring, /Open an assigned case/);
});

test('reply-only ephemeral flags are stripped before editing an interaction response', () => {
    const payload = views.buildHomePayload(buildWorkspace(), config());
    assert.equal(payload.flags, 64);
    const editable = views.asEditPayload(payload);
    assert.equal(Object.prototype.hasOwnProperty.call(editable, 'flags'), false);
    assert.equal(editable.components, payload.components);
});

test('case views expose every admin lifecycle action in context', () => {
    const reviewWorkspace = buildWorkspace();
    const review = reviewWorkspace.work.items[0];
    const reviewJson = serialize(views.buildCasePayload(review, reviewWorkspace, config()));
    assert.match(JSON.stringify(reviewJson), /No action/);
    assert.match(JSON.stringify(reviewJson), /Monitor next wars/);
    assert.match(JSON.stringify(reviewJson), /Hero-down period/);
    assert.match(JSON.stringify(reviewJson), /Remove from community/);
    assert.match(JSON.stringify(reviewJson), /Set follow-up/);
    assert.match(JSON.stringify(reviewJson), /Record resolution/);
    assert.match(JSON.stringify(reviewJson), /Assign owner/);
    assert.match(JSON.stringify(reviewJson), /Always ignore/);
    assert.match(JSON.stringify(reviewJson), /private note/i);
    assert.match(JSON.stringify(reviewJson), /War details/);
    assert.match(JSON.stringify(reviewJson), /Activity/);

    const dmWorkspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'Prepared moderation decision.',
        updatedAt: '2026-08-01T01:00:00.000Z'
    });
    const dmJson = serialize(views.buildCasePayload(dmWorkspace.work.items[0], dmWorkspace, config()));
    assert.match(JSON.stringify(dmJson), /Send DM now/);
    assert.match(JSON.stringify(dmJson), /Mark DM sent/);
    assert.match(JSON.stringify(dmJson), /Change decision/);

    const ready = {
        ...dmWorkspace.work.items[0],
        status: 'ready',
        recovery: { ready: true, completedWars: 3, targetWars: 3, usedAttacks: 6, possibleAttacks: 6 }
    };
    const readyJson = serialize(views.buildCasePayload(ready, dmWorkspace, config()));
    assert.match(JSON.stringify(readyJson), /Approve return/);
    assert.match(JSON.stringify(readyJson), /Extend period/);
    assert.match(JSON.stringify(readyJson), /Close without return/);
    assert.match(JSON.stringify(readyJson), /Remove from community/);

    const evasion = {
        ...review,
        status: 'needs_review',
        case: {
            ...review.case,
            status: 'removal_evasion',
            removalReason: 'Removed previously.',
            removalRejoinedAt: '2026-08-10T00:00:00.000Z',
            rejoinRosterTitle: 'Main'
        }
    };
    const evasionJson = serialize(views.buildCasePayload(evasion, reviewWorkspace, config()));
    assert.match(JSON.stringify(evasionJson), /Removal evasion/);
    assert.match(JSON.stringify(evasionJson), /Remove again/);
    assert.match(JSON.stringify(evasionJson), /Approve rejoin/);
    assert.doesNotMatch(JSON.stringify(evasionJson), /No action/);
});

test('all workflow and rule modals serialize with at most five input rows', () => {
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'Prepared moderation decision.',
        updatedAt: '2026-08-01T01:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const target = workspace.work.directory.rosters[1];
    const modals = [
        views.buildWatchModal(item),
        views.buildRemovalModal(item),
        views.buildResolveModal(item),
        views.buildHeroModal(item, target, workspace),
        views.buildExtendModal({ ...item, case: { ...item.case, recoveryWarTarget: 3 } }, target),
        views.buildNoteModal(item),
        views.buildMarkDmModal(item),
        views.buildContactModal(item),
        views.buildWaitModal(item),
        views.buildAssignmentModal(item),
        views.buildRegularRulesModal(workspace.work.settings),
        views.buildCwlRulesModal(workspace.work.settings),
        views.buildWorkflowRulesModal(workspace.work.settings)
    ];

    for (const modal of modals) {
        const json = modal.toJSON();
        assert.ok(json.components.length >= 1 && json.components.length <= 5);
        assert.ok(json.custom_id.length <= 100);
    }
    assert.match(
        JSON.stringify(modals[4].toJSON()),
        /Hero-down/,
        'an extension message is regenerated for the newly selected target roster'
    );
});

test('decision views preserve the captured evidence and expose war-by-war details', () => {
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'Prepared moderation decision.',
        evidence: {
            capturedAt: '2026-07-01T00:00:00.000Z',
            regular: { possibleAttacks: 4, usedAttacks: 1, missedAttacks: 3 },
            cwl: {},
            regularEvents: [{
                id: 'captured-war',
                at: '2026-06-30T00:00:00.000Z',
                clanTag: '#MAIN',
                stats: { possibleAttacks: 2, usedAttacks: 0, missedAttacks: 2 }
            }],
            cwlEvents: []
        },
        updatedAt: '2026-08-01T01:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const detail = serialize(views.buildCasePayload(item, workspace, config()));
    const evidence = serialize(views.buildEvidencePayload(item));
    assert.match(JSON.stringify(detail), /Decision evidence/);
    assert.match(JSON.stringify(evidence), /evidence snapshot used for the current decision/);
    assert.match(JSON.stringify(evidence), /captured-war|30 Jun 2026/);
});

test('private activity remains available beyond the five-entry case summary', () => {
    const activity = Array.from({ length: 12 }, (_, index) => ({
        id: `entry-${index}`,
        at: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        type: 'note',
        actor: 'Moderator',
        text: `Private activity ${index + 1}`
    }));
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_dm',
        dmText: 'Decision',
        activity,
        updatedAt: '2026-08-01T01:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const firstPage = serialize(views.buildActivityPayload(item, 0));
    const secondPage = serialize(views.buildActivityPayload(item, 1));
    assert.match(JSON.stringify(firstPage), /Private activity 12/);
    assert.doesNotMatch(JSON.stringify(firstPage), /Private activity 1\D/);
    assert.match(JSON.stringify(secondPage), /Private activity 1\D/);
});

test('case and conversation views show outgoing DMs and player replies in chronological context', () => {
    const conversation = Array.from({ length: 9 }, (_, index) => ({
        id: `message-${index}`,
        direction: index % 2 === 0 ? 'staff' : 'player',
        at: `2026-08-${String(index + 1).padStart(2, '0')}T12:00:00.000Z`,
        actor: index % 2 === 0 ? 'Moderator' : 'Player',
        text: index === 0
            ? 'Could you explain why the attack was missed?'
            : index === 8
                ? 'Thanks, that explains what happened.'
                : `Conversation message ${index + 1}`,
        messageId: `${String(index + 1).padStart(18, '1')}`,
        deliveryMode: index % 2 === 0 ? 'bot' : 'manual'
    }));
    const workspace = buildWorkspace({
        tag: '#PLAYER',
        status: 'needs_review',
        conversation,
        updatedAt: '2026-08-10T01:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const caseView = JSON.stringify(serialize(views.buildCasePayload(item, workspace, config())));
    const latestConversation = JSON.stringify(serialize(views.buildConversationPayload(item, 'latest')));

    assert.match(caseView, /Recent conversation/);
    assert.match(caseView, /Conversation \(9\)/);
    assert.match(caseView, /Reply to player/);
    assert.match(caseView, /Thanks, that explains/);
    assert.match(latestConversation, /Private conversation/);
    assert.match(latestConversation, /Sent by Moderator/);
    assert.match(latestConversation, /Player replied/);
    assert.match(latestConversation, /Thanks, that explains/);
    assert.match(latestConversation, /Back to follow-up/);
});

test('large Discord-gap and ignored-account lists remain fully pageable', () => {
    const players = Array.from({ length: 55 }, (_, index) => ({
        tag: `#TAG${index}`,
        name: `Player ${String(index).padStart(2, '0')}`,
        rosterTitle: 'Main',
        discordId: '',
        trusted: false
    }));
    const gapWorkspace = { work: { directory: { players } } };
    const gaps = serialize(views.buildGapsPayload(gapWorkspace, { page: 1 }));
    assert.match(JSON.stringify(gaps), /page 2\/2/);
    assert.match(JSON.stringify(gaps), /Player 54/);

    const trusted = players.slice(0, 30).map(player => player.tag);
    const ignoredWorkspace = {
        work: {
            directory: {
                players,
                byTag: Object.fromEntries(players.map(player => [player.tag, player]))
            },
            settings: workflow.sanitizeSettings({ trustedPlayerTags: trusted })
        },
        privateState: { cases: [] }
    };
    const ignored = serialize(views.buildIgnoredPayload(ignoredWorkspace, { page: 1 }));
    assert.match(JSON.stringify(ignored), /page 2\/2/);
    assert.match(JSON.stringify(ignored), /Player 29/);
});
