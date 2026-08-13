'use strict';

const assert = require('node:assert/strict');
const { beforeEach, test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const views = require('../src/features/warFollowup/views');
const service = require('../src/features/warFollowup/service');
const moderation = require('../src/features/warFollowup/moderation');
const { warFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const { buildCustomId } = require('../src/features/warFollowup/customIds');
const { handleWarFollowupInteraction } = require('../src/features/warFollowup/interaction');
const mutationOutbox = require('../src/features/warFollowup/mutationOutbox');

const GUILD_ID = '111111111111111111';
const STAFF_ROLE_ID = '1444000343431053332';
const APPRENTICE_ROLE_ID = '1456074413412716780';

beforeEach(t => {
    const contexts = new Map();
    t.mock.method(warFollowupStateStore, 'recordModalContext', (_guildId, userId, customId, context) => {
        const value = { ...structuredClone(context), userId, customId };
        contexts.set(`${userId}:${customId}`, value);
        return value;
    });
    t.mock.method(warFollowupStateStore, 'getModalContext', (_guildId, userId, customId) =>
        contexts.get(`${userId}:${customId}`) || null
    );
    t.mock.method(warFollowupStateStore, 'removeModalContext', (_guildId, userId, customId) =>
        contexts.delete(`${userId}:${customId}`)
    );
    t.mock.method(service, 'syncModeratorPreference', async preference => preference);
});

function buildWorkspace(caseValue) {
    const rosterData = {
        rosters: [{
            id: 'main',
            title: 'Main',
            connectedClanTag: '#2LUCULP',
            main: [{ tag: '#P0LYGQ', name: 'Alpha', discord: 'alpha', th: 18 }],
            subs: [],
            missing: []
        }, {
            id: 'hero-down',
            title: 'Hero-down',
            connectedClanTag: '#9PYLQG',
            main: [],
            subs: [],
            missing: []
        }],
        playerMetrics: {
            byTag: {
                '#P0LYGQ': { identity: { discordId: '222222222222222222', discordUsername: 'alpha' } }
            }
        }
    };
    const privateState = {
        settings: workflow.sanitizeSettings(null),
        cases: [caseValue]
    };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

function baseInteraction(customId, overrides = {}) {
    const calls = { replies: [], edits: [], modals: [], defers: 0, followUps: [] };
    const interaction = {
        id: '333333333333333333',
        customId,
        guildId: GUILD_ID,
        guild: { members: { me: {} } },
        member: {
            displayName: 'Moderator',
            roles: { cache: { has: roleId => roleId === STAFF_ROLE_ID } }
        },
        user: { id: '777777777777777777', username: 'moderator' },
        message: { flags: { bitfield: 64 } },
        client: {},
        replied: false,
        deferred: false,
        inGuild: () => true,
        isModalSubmit: () => false,
        reply: async payload => {
            interaction.replied = true;
            calls.replies.push(payload);
        },
        followUp: async payload => calls.followUps.push(payload),
        deferUpdate: async () => {
            interaction.deferred = true;
            calls.defers += 1;
        },
        deferReply: async () => {
            interaction.deferred = true;
            calls.defers += 1;
        },
        editReply: async payload => calls.edits.push(payload),
        showModal: async modal => calls.modals.push(modal.toJSON()),
        ...overrides
    };
    return { interaction, calls };
}

test('modal controls acknowledge immediately from the rendered workspace cache', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(service, 'loadWorkspace', async () => {
        throw new Error('a modal opener must not make a network read');
    });
    const { interaction, calls } = baseInteraction(buildCustomId('watch', item.tag, views.caseToken(item)));

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(calls.modals.length, 1);
    assert.equal(calls.defers, 0);
    assert.equal(calls.replies.length, 0);
});

test('a stale case control is rejected before any modal or mutation', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    t.mock.method(service, 'peekWorkspace', () => workspace);
    const { interaction, calls } = baseInteraction(buildCustomId('watch', '#P0LYGQ', 'stale-token'));

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(calls.modals.length, 0);
    assert.equal(calls.replies.length, 1);
    assert.match(calls.replies[0].content, /changed after it was opened/);
});

test('No action snapshots the evidence visible when the Discord case is closed', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-13T10:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const saved = [];
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        saved.push(structuredClone(record));
        return structuredClone(record);
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => ({
        record: { ...saved[0], id: mutationId, state: 'pending' },
        attempted: true
    }));
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: {} }
    }));
    const { interaction } = baseInteraction(buildCustomId('dismiss', item.tag, views.caseToken(item)));

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(saved.length, 1);
    assert.deepEqual(saved[0].request.evidence, item.evidence);
});

test('a submitted Contact player message is saved locally and remains visible when the backend is unavailable', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        assignedModeratorId: '777777777777777777',
        updatedAt: '2026-08-13T10:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const saved = [];
    let sequence = 0;
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(service, 'loadWorkspace', async () => {
        throw new Error('modal submission must not need a backend read');
    });
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        sequence += 1;
        saved.push(structuredClone(record));
        return structuredClone(record);
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => {
        sequence += 1;
        return {
            record: {
                ...saved[0],
                id: mutationId,
                state: 'pending',
                attempts: 1,
                nextAttemptAt: '2026-08-13T10:05:00.000Z',
                lastError: { code: 'TIMEOUT', status: null, message: 'Roster backend request timed out.' }
            },
            attempted: true
        };
    });
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: { directMessages: true, playerReplies: true } }
    }));

    const opener = baseInteraction(buildCustomId('contact', item.tag, views.caseToken(item)));
    assert.equal(await handleWarFollowupInteraction(opener.interaction), true);
    assert.equal(opener.calls.modals.length, 1);

    const typedMessage = 'Hi Alpha. Could you explain why the attack was missed?';
    const submit = baseInteraction(opener.calls.modals[0].custom_id, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: id => id === 'message' ? typedMessage : '' }
    });
    assert.equal(await handleWarFollowupInteraction(submit.interaction), true);
    assert.equal(saved.length, 1);
    assert.equal(sequence, 2, 'durable local save must happen before attempting the backend');
    assert.equal(saved[0].request.expectedUpdatedAt, '2026-08-13T10:00:00.000Z');
    assert.equal(saved[0].request.dmText, typedMessage);
    assert.match(saved[0].draftPreview, /Could you explain/);
    assert.equal(submit.calls.edits.length, 2);
    assert.match(JSON.stringify(submit.calls.edits[0]), /Change saved locally/);
    assert.match(JSON.stringify(submit.calls.edits.at(-1)), /Could you explain/);
    assert.match(JSON.stringify(submit.calls.edits.at(-1)), /Nothing is sent to the player until the backend accepts/);
});

test('a local storage failure returns the complete submitted message instead of losing it', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        assignedModeratorId: '777777777777777777',
        updatedAt: '2026-08-13T10:00:00.000Z'
    });
    const item = workspace.work.items[0];
    t.mock.method(service, 'peekWorkspace', () => workspace);

    const opener = baseInteraction(buildCustomId('contact', item.tag, views.caseToken(item)));
    assert.equal(await handleWarFollowupInteraction(opener.interaction), true);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', () => {
        throw new Error('local disk unavailable');
    });

    const typedMessage = 'Please keep this exact explanation request available for me.';
    const submit = baseInteraction(opener.calls.modals[0].custom_id, {
        isModalSubmit: () => true,
        fields: { getTextInputValue: id => id === 'message' ? typedMessage : '' }
    });
    assert.equal(await handleWarFollowupInteraction(submit.interaction), true);
    assert.equal(submit.calls.defers, 0);
    assert.equal(submit.calls.replies.length, 1);
    assert.match(submit.calls.replies[0].content, /local disk unavailable/);
    assert.match(JSON.stringify(submit.calls.replies[0].embeds), /Please keep this exact explanation request/);
    assert.match(JSON.stringify(submit.calls.replies[0].embeds), /Your submitted text was not discarded/);
});

test('slow private controls show a locked action-specific busy state before loading', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const customId = buildCustomId('refresh');
    let calls;
    t.mock.method(service, 'loadWorkspace', async () => {
        assert.equal(calls.edits.length, 1, 'busy state must render before the backend read starts');
        assert.match(calls.edits[0].content, /Refreshing cases/);
        assert.equal(calls.edits[0].components[0].components.every(component => component.disabled), true);
        return workspace;
    });
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: {} }
    }));
    const built = baseInteraction(customId, {
        message: {
            flags: { bitfield: 64 },
            content: 'Original case view',
            embeds: [{ title: 'Case' }],
            components: [{
                type: 1,
                components: [
                    { type: 2, style: 1, custom_id: customId, label: 'Refresh' },
                    { type: 2, style: 2, custom_id: buildCustomId('mycases'), label: 'My cases' }
                ]
            }]
        }
    });
    calls = built.calls;

    assert.equal(await handleWarFollowupInteraction(built.interaction), true);
    assert.equal(calls.edits.length, 2);
    assert.equal(calls.edits[0].components[0].components[0].label, 'Refreshing cases\u2026');
    assert.match(calls.edits[0].content, /Controls will unlock when this finishes/);
    assert.doesNotMatch(calls.edits[1].content || '', /Controls will unlock/);
});

test('a failed slow action restores its controls before reporting the error', async t => {
    const customId = buildCustomId('refresh');
    t.mock.method(service, 'loadWorkspace', async () => {
        throw new Error('backend unavailable');
    });
    const { interaction, calls } = baseInteraction(customId, {
        message: {
            flags: { bitfield: 64 },
            content: 'Original case view',
            embeds: [{ title: 'Case' }],
            components: [{
                type: 1,
                components: [{ type: 2, style: 1, custom_id: customId, label: 'Refresh' }]
            }]
        }
    });

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(calls.edits.length, 2);
    assert.equal(calls.edits[0].components[0].components[0].disabled, true);
    assert.equal(calls.edits[1].content, 'Original case view');
    assert.equal(calls.edits[1].components[0].components[0].disabled, undefined);
    assert.equal(calls.followUps.length, 1);
    assert.match(calls.followUps[0].content, /backend unavailable/);
});

test('extension submission preserves the newly selected connected target roster', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'hero_down',
        targetRosterId: 'main',
        targetRosterTitle: 'Main',
        targetClanTag: '#2LUCULP',
        recoveryWarTarget: 3,
        requireNoMisses: true,
        dmText: 'Existing decision',
        dmSentAt: '2026-08-01T00:00:00.000Z',
        recoveryStartedAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const target = workspace.work.directory.rosters.find(roster => roster.id === 'hero-down');
    const mutations = [];
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        mutations.push(record);
        return record;
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => ({
        record: { ...mutations[0], id: mutationId, state: 'committed' },
        result: { ...item.case, ...mutations[0].request, updatedAt: '2026-08-01T01:00:00.000Z' }
    }));
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: { directMessages: false } }
    }));
    const fields = { wars: '4', no_misses: 'yes', message: 'Updated extension decision' };
    const { interaction, calls } = baseInteraction(
        buildCustomId('extendform', item.tag, views.caseToken(item), views.rosterToken(target.id)),
        {
            isModalSubmit: () => true,
            fields: { getTextInputValue: id => fields[id] || '' }
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].action, 'extend');
    assert.deepEqual(
        {
            targetRosterId: mutations[0].request.targetRosterId,
            targetRosterTitle: mutations[0].request.targetRosterTitle,
            targetClanTag: mutations[0].request.targetClanTag,
            recoveryWarTarget: mutations[0].request.recoveryWarTarget
        },
        {
            targetRosterId: 'hero-down',
            targetRosterTitle: 'Hero-down',
            targetClanTag: '#9PYLQG',
            recoveryWarTarget: 4
        }
    );
    assert.equal(calls.edits.length, 2);
});

test('a delivered DM with a failed backend mutation retires the send controls and records dedupe state', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_dm',
        contactPurpose: 'general',
        dmText: 'Prepared decision',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const deliveries = [];
    const mutations = [];
    let dmSends = 0;
    let deliveredPayload = null;
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        mutations.push(record);
        return record;
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => ({
        record: {
            ...mutations[0],
            id: mutationId,
            state: 'pending',
            attempts: 1,
            nextAttemptAt: '2026-08-01T00:01:00.000Z',
            lastError: { message: 'temporary backend outage' }
        },
        result: null,
        attempted: true
    }));
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: { directMessages: true } }
    }));
    t.mock.method(warFollowupStateStore, 'hasDelivery', () => false);
    t.mock.method(warFollowupStateStore, 'recordDeliveries', (...args) => deliveries.push(args));
    const { interaction, calls } = baseInteraction(
        buildCustomId('senddm', item.tag, views.caseToken(item)),
        {
            user: { id: '333333333333333333', username: 'moderator' },
            client: {
                users: {
                    fetch: async () => ({
                        send: async payload => {
                            dmSends += 1;
                            deliveredPayload = payload;
                            return { id: '555555555555555555' };
                        }
                    })
                }
            }
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(dmSends, 1);
    assert.match(deliveredPayload.content, /reply to this message/i);
    assert.deepEqual(deliveries.map(entry => entry[2].disposition), [
        'direct-dm-pending',
        'direct-dm-sent'
    ]);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].request.dmDeliveryMode, 'bot');
    assert.equal(mutations[0].request.dmMessageId, '555555555555555555');
    assert.equal(mutations[0].request.dmSentByDiscordId, '333333333333333333');
    assert.equal(mutations[0].request.dmSentByName, 'Moderator');
    assert.equal(calls.edits.length, 3);
    assert.match(calls.edits[0].content, /Sending DM/);
    assert.match(JSON.stringify(calls.edits[1]), /DM delivered; case update saved/);
    assert.match(JSON.stringify(calls.edits[2]), /DM delivered; case update saved/);
    assert.match(JSON.stringify(calls.edits[2]), /Do not send the message again/);
    assert.doesNotMatch(JSON.stringify(calls.edits[2]), /Send DM now/);
    assert.equal(calls.followUps.length, 0);
});

test('a known Discord DM failure releases the durable reservation for a safe retry', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_dm',
        dmText: 'Prepared decision',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const dispositions = [];
    const removed = [];
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: { directMessages: true } }
    }));
    t.mock.method(warFollowupStateStore, 'hasDelivery', () => false);
    t.mock.method(warFollowupStateStore, 'recordDeliveries', (_guildId, _key, details) => {
        dispositions.push(details.disposition);
    });
    t.mock.method(warFollowupStateStore, 'removeDeliveries', (_guildId, key) => {
        removed.push(key);
        return true;
    });
    const { interaction, calls } = baseInteraction(
        buildCustomId('senddm', item.tag, views.caseToken(item)),
        {
            client: {
                users: {
                    fetch: async () => ({
                        send: async () => {
                            throw new Error('Discord rejected the DM');
                        }
                    })
                }
            }
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.deepEqual(dispositions, ['direct-dm-pending']);
    assert.equal(removed.length, 1);
    assert.equal(calls.edits.length, 2);
    assert.match(calls.edits[0].content, /Sending DM/);
    assert.equal(calls.followUps.length, 1);
    assert.match(calls.followUps[0].content, /Discord rejected the DM/);
});

test('moderators can persist their own clan subscriptions and assignment availability from the panel', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const moderatorId = '222222222222222222';
    let preference = {
        discordId: moderatorId,
        displayName: 'Moderator',
        clanTags: [],
        notificationMode: 'channel',
        accepting: false
    };
    const patches = [];
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: {} },
        moderators: { [moderatorId]: preference }
    }));
    t.mock.method(warFollowupStateStore, 'upsertModerator', (_guildId, _discordId, patch) => {
        patches.push(patch);
        preference = { ...preference, ...patch };
        return preference;
    });
    const clans = baseInteraction(buildCustomId('modclans'), {
        user: { id: moderatorId, username: 'moderator' },
        values: ['#2LUCULP']
    });
    assert.equal(await handleWarFollowupInteraction(clans.interaction), true);
    assert.deepEqual(patches[0].clanTags, ['#2LUCULP']);
    assert.equal(clans.calls.edits.length, 2);

    const toggle = baseInteraction(buildCustomId('modtoggle'), {
        user: { id: moderatorId, username: 'moderator' }
    });
    assert.equal(await handleWarFollowupInteraction(toggle.interaction), true);
    assert.equal(patches[1].accepting, true);
    assert.equal(toggle.calls.edits.length, 2);
});

test('an eligible moderator can explicitly take ownership of another moderators case', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        sourceClanTag: '#2LUCULP',
        assignedModeratorId: '999999999999999999',
        assignedModeratorName: 'Previous owner',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const moderatorId = '222222222222222222';
    const mutations = [];
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        mutations.push(record);
        return record;
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => ({
        record: { ...mutations[0], id: mutationId, state: 'committed' },
        result: {
            ...item.case,
            ...mutations[0].request,
            assignedAt: '2026-08-12T12:00:00.000Z',
            updatedAt: '2026-08-12T12:00:00.000Z'
        }
    }));
    t.mock.method(moderation, 'getEligibleModerators', async () => [{
        discordId: moderatorId,
        displayName: 'Moderator',
        notificationMode: 'channel',
        accepting: true,
        clanTags: ['#2LUCULP']
    }]);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: {} },
        moderationHub: {},
        moderators: {}
    }));
    const { interaction, calls } = baseInteraction(
        buildCustomId('assignpick', item.tag, views.caseToken(item)),
        {
            user: { id: moderatorId, username: 'moderator' },
            values: ['__self__']
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].action, 'assign_owner');
    assert.equal(mutations[0].request.assignedModeratorId, moderatorId);
    assert.equal(mutations[0].request.assignedModeratorName, 'Moderator');
    assert.equal(mutations[0].request.assignmentCoverageOverride, false);
    assert.equal(calls.edits.length, 3);
});

test('a senior leader can take ownership without enabling automatic clan coverage', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        sourceClanTag: '#2LUCULP',
        assignedModeratorId: '999999999999999999',
        assignedModeratorName: 'Previous owner',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const moderatorId = '222222222222222222';
    const mutations = [];
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'enqueueMutation', (_guildId, record) => {
        mutations.push(record);
        return record;
    });
    t.mock.method(mutationOutbox, 'executeMutation', async (_guildId, mutationId) => ({
        record: { ...mutations[0], id: mutationId, state: 'committed' },
        result: {
            ...item.case,
            ...mutations[0].request,
            assignedAt: '2026-08-12T12:00:00.000Z',
            updatedAt: '2026-08-12T12:00:00.000Z'
        }
    }));
    t.mock.method(moderation, 'getEligibleModerators', async () => []);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: {} },
        moderationHub: {},
        moderators: {}
    }));
    const { interaction } = baseInteraction(
        buildCustomId('assignpick', item.tag, views.caseToken(item)),
        {
            user: { id: moderatorId, username: 'moderator' },
            values: ['__self__']
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(mutations.length, 1);
    assert.equal(mutations[0].request.assignedModeratorId, moderatorId);
    assert.equal(mutations[0].request.assignmentCoverageOverride, true);
});

test('ordinary staff still need clan coverage before taking ownership', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        sourceClanTag: '#2LUCULP',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    let mutations = 0;
    t.mock.method(service, 'peekWorkspace', () => workspace);
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(service, 'mutateCase', async () => {
        mutations += 1;
        return item.case;
    });
    t.mock.method(moderation, 'getEligibleModerators', async () => []);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: false, channelId: '', features: {} },
        moderationHub: {},
        moderators: {}
    }));
    const { interaction, calls } = baseInteraction(
        buildCustomId('assignpick', item.tag, views.caseToken(item)),
        {
            member: {
                displayName: 'Apprentice leader',
                roles: { cache: { has: roleId => roleId === APPRENTICE_ROLE_ID } }
            },
            user: { id: '222222222222222222', username: 'apprentice' },
            values: ['__self__']
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(mutations, 0);
    assert.match(JSON.stringify(calls), /senior leadership role/i);
});

test('public Moderation Hub controls always open a private personalized response', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const deferPayloads = [];
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: {} },
        moderationHub: {},
        moderators: {}
    }));
    const { interaction, calls } = baseInteraction(buildCustomId('modsettings'), {
        user: { id: '222222222222222222', username: 'moderator' },
        message: { flags: { bitfield: 0 } },
        deferReply: async payload => {
            interaction.deferred = true;
            deferPayloads.push(payload);
        }
    });

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(deferPayloads[0].flags, views.EPHEMERAL);
    assert.equal(calls.edits.length, 1);
});

test('read-only panels clearly label a recent cached fallback', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_review',
        assignedModeratorId: '222222222222222222',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    workspace.freshness = {
        privateStateStale: true,
        privateStateCachedAt: Date.now() - 60_000
    };
    t.mock.method(service, 'loadWorkspace', async options => {
        assert.equal(options.allowStalePrivateOnError, true);
        return workspace;
    });
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: {} }
    }));
    const { interaction, calls } = baseInteraction(buildCustomId('mycases'), {
        user: { id: '222222222222222222', username: 'moderator' }
    });

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(calls.edits.length, 2);
    assert.match(calls.edits[1].content, /Backend temporarily unavailable/);
    assert.match(calls.edits[1].content, /last confirmed case data/);
});
