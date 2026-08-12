'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const service = require('../src/features/warFollowup/service');
const { warFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const { handleWarFollowupPlayerReply } = require('../src/features/warFollowup/playerReply');

function baseWorkspace(status = 'waiting') {
    const item = {
        tag: '#P0LYGQ',
        status,
        player: { name: 'Alpha', discordId: '222222222222222222' },
        case: {
            status,
            contactPurpose: 'general',
            dmSentAt: '2026-08-12T10:00:00.000Z',
            waitingUntil: '2026-08-13T10:00:00.000Z',
            assignedModeratorId: '333333333333333333',
            assignedModeratorName: 'Moderator',
            updatedAt: '2026-08-12T10:00:00.000Z'
        }
    };
    return { work: { items: [item] } };
}

function setup(t, workspace, options = {}) {
    const deliveries = new Set();
    const mutations = [];
    const moderatorMessages = [];
    const channelMessages = [];
    const playerMessages = [];
    const guildId = '111111111111111111';
    t.mock.method(warFollowupStateStore, 'listEnabledGuilds', () => [{
        guildId,
        config: {
            enabled: true,
            channelId: '444444444444444444',
            staffRoleId: '555555555555555555',
            features: { playerReplies: options.enabled !== false }
        },
        moderators: {
            '333333333333333333': {
                discordId: '333333333333333333',
                notificationMode: options.mode || 'dm',
                displayName: 'Moderator'
            }
        }
    }]);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: {
            enabled: true,
            channelId: '444444444444444444',
            staffRoleId: '555555555555555555',
            features: { playerReplies: true }
        },
        moderators: {
            '333333333333333333': {
                discordId: '333333333333333333',
                notificationMode: options.mode || 'dm',
                displayName: 'Moderator'
            }
        }
    }));
    t.mock.method(warFollowupStateStore, 'hasDelivery', (_guildId, key) => deliveries.has(key));
    t.mock.method(warFollowupStateStore, 'recordDeliveries', (_guildId, keys) => {
        for (const key of (Array.isArray(keys) ? keys : [keys])) deliveries.add(key);
    });
    t.mock.method(warFollowupStateStore, 'removeDeliveries', (_guildId, keys) => {
        for (const key of (Array.isArray(keys) ? keys : [keys])) deliveries.delete(key);
    });
    t.mock.method(service, 'loadWorkspace', async () => workspace);
    t.mock.method(service, 'recordPlayerResponse', async (...args) => {
        mutations.push(args);
        const current = workspace.work.items[0].case;
        return {
            ...current,
            status: 'needs_review',
            playerResponse: args[1],
            playerResponseAt: '2026-08-12T12:00:00.000Z'
        };
    });
    const channel = {
        id: '444444444444444444',
        guildId,
        isTextBased: () => true,
        isThread: () => false,
        send: async payload => {
            channelMessages.push(payload);
            return { id: '666666666666666666' };
        }
    };
    const client = {
        channels: { cache: new Map([[channel.id, channel]]) },
        users: {
            fetch: async () => ({
                send: async payload => moderatorMessages.push(payload)
            })
        }
    };
    const message = {
        id: '777777777777777777',
        guildId: null,
        content: 'I had a family emergency and could not attack.',
        author: { id: '222222222222222222', bot: false },
        channel: {
            send: async payload => playerMessages.push(payload)
        }
    };
    return { client, message, mutations, moderatorMessages, channelMessages, playerMessages };
}

test('captures an opted-in player reply, moves the case back to review, and privately notifies the moderator', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { mode: 'dm' });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: true });
    assert.equal(setupState.mutations.length, 1);
    assert.equal(setupState.mutations[0][1], 'I had a family emergency and could not attack.');
    assert.equal(setupState.mutations[0][2], '777777777777777777');
    assert.equal(setupState.moderatorMessages.length, 1);
    assert.match(setupState.moderatorMessages[0].embeds[0].description, /family emergency/);
    assert.equal(setupState.channelMessages.length, 0);
    assert.match(setupState.playerMessages[0].content, /forwarded to the moderation team/);
});

test('channel notification mode sends one private-content-safe moderator ping', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { mode: 'channel' });

    await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.equal(setupState.moderatorMessages.length, 0);
    assert.equal(setupState.channelMessages.length, 1);
    assert.equal(setupState.channelMessages[0].content, '<@333333333333333333>');
    assert.doesNotMatch(setupState.channelMessages[0].embeds[0].description, /family emergency/);
    assert.deepEqual(setupState.channelMessages[0].allowedMentions.users, ['333333333333333333']);
});

test('disabled reply capture leaves player DMs untouched', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { enabled: false });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: false });
    assert.equal(setupState.mutations.length, 0);
    assert.equal(setupState.playerMessages.length, 0);
});

test('replies to closed or non-contact cases are not assigned accidentally', async t => {
    const workspace = baseWorkspace('needs_review');
    const setupState = setup(t, workspace);

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: false });
    assert.equal(setupState.mutations.length, 0);
    assert.equal(setupState.playerMessages.length, 0);
});
