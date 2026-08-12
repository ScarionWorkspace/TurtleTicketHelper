'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const views = require('../src/features/warFollowup/views');
const service = require('../src/features/warFollowup/service');
const { warFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const { buildCustomId } = require('../src/features/warFollowup/customIds');
const { handleWarFollowupInteraction } = require('../src/features/warFollowup/interaction');

const GUILD_ID = '111111111111111111';
const STAFF_ROLE_ID = '1444000343431053332';

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
        user: { username: 'moderator' },
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
    t.mock.method(service, 'mutateCase', async (...args) => {
        mutations.push(args);
        return item.case;
    });
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
    assert.equal(mutations[0][1], 'extend');
    assert.deepEqual(
        {
            targetRosterId: mutations[0][2].targetRosterId,
            targetRosterTitle: mutations[0][2].targetRosterTitle,
            targetClanTag: mutations[0][2].targetClanTag,
            recoveryWarTarget: mutations[0][2].recoveryWarTarget
        },
        {
            targetRosterId: 'hero-down',
            targetRosterTitle: 'Hero-down',
            targetClanTag: '#9PYLQG',
            recoveryWarTarget: 4
        }
    );
    assert.equal(calls.edits.length, 1);
});

test('a delivered DM with a failed backend mutation retires the send controls and records dedupe state', async t => {
    const workspace = buildWorkspace({
        tag: '#P0LYGQ',
        status: 'needs_dm',
        dmText: 'Prepared decision',
        updatedAt: '2026-08-01T00:00:00.000Z'
    });
    const item = workspace.work.items[0];
    const deliveries = [];
    let dmSends = 0;
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(service, 'mutateCase', async () => {
        throw new Error('temporary backend outage');
    });
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: { enabled: true, channelId: '444444444444444444', features: { directMessages: true } }
    }));
    t.mock.method(warFollowupStateStore, 'hasDelivery', () => false);
    t.mock.method(warFollowupStateStore, 'recordDeliveries', (...args) => deliveries.push(args));
    const { interaction, calls } = baseInteraction(
        buildCustomId('senddm', item.tag, views.caseToken(item)),
        {
            client: {
                users: {
                    fetch: async () => ({
                        send: async () => {
                            dmSends += 1;
                            return { id: '555555555555555555' };
                        }
                    })
                }
            }
        }
    );

    assert.equal(await handleWarFollowupInteraction(interaction), true);
    assert.equal(dmSends, 1);
    assert.deepEqual(deliveries.map(entry => entry[2].disposition), [
        'direct-dm-pending',
        'direct-dm-sent'
    ]);
    assert.equal(calls.edits.length, 2);
    assert.match(calls.edits[0].content, /Sending DM/);
    assert.match(calls.edits[1].content, /DM was delivered/);
    assert.doesNotMatch(JSON.stringify(calls.edits[1]), /Send DM now/);
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
