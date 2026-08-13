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
            dmDeliveryMode: 'bot',
            dmMessageId: '888888888888888888',
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
    const directMessages = [];
    const channelMessages = [];
    const playerMessages = [];
    const guildId = '111111111111111111';
    const moderators = {
        '333333333333333333': {
            discordId: '333333333333333333',
            notificationMode: options.mode || 'dm',
            displayName: 'Moderator'
        },
        ...(options.senderModerator ? {
            [options.senderModerator.discordId]: options.senderModerator
        } : {})
    };
    t.mock.method(warFollowupStateStore, 'listEnabledGuilds', () => [{
        guildId,
        config: {
            enabled: true,
            channelId: '444444444444444444',
            staffRoleId: '555555555555555555',
            features: {
                directMessages: options.enabled !== false,
                playerReplies: options.legacyReplyFlag === true
            }
        },
        moderators
    }]);
    t.mock.method(warFollowupStateStore, 'getGuild', () => ({
        config: {
            enabled: true,
            channelId: '444444444444444444',
            staffRoleId: '555555555555555555',
            features: { playerReplies: true }
        },
        moderators
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
        const at = '2026-08-12T12:00:00.000Z';
        return {
            ...current,
            status: 'needs_review',
            playerResponse: args[1],
            playerResponseAt: at,
            conversation: (current.conversation || []).concat([{
                id: `player:${args[2]}`,
                direction: 'player',
                at,
                actor: 'Player',
                text: args[1],
                messageId: args[2]
            }])
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
            fetch: async discordId => ({
                send: async payload => {
                    if (options.failingDmId === discordId) throw new Error('Discord rejected this moderator DM');
                    moderatorMessages.push(payload);
                    directMessages.push({ discordId, payload });
                }
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
    return { client, message, mutations, moderatorMessages, directMessages, channelMessages, playerMessages };
}

test('captures an opted-in player reply, moves the case back to review, and privately notifies the moderator', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { mode: 'dm' });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: true });
    assert.equal(setupState.mutations.length, 1);
    assert.equal(setupState.mutations[0][1], 'I had a family emergency and could not attack.');
    assert.equal(setupState.mutations[0][2], '777777777777777777');
    assert.equal(setupState.mutations[0][3].responseToMessageId, '');
    assert.equal(setupState.moderatorMessages.length, 1);
    assert.match(setupState.moderatorMessages[0].embeds[0].description, /family emergency/);
    assert.equal(setupState.channelMessages.length, 0);
    assert.match(setupState.playerMessages[0].content, /forwarded to the moderation team/);
});

test('moderator notifications include the outgoing message and latest player reply as conversation context', async t => {
    const workspace = baseWorkspace();
    workspace.work.items[0].case.conversation = [{
        id: 'staff:888888888888888888',
        direction: 'staff',
        at: '2026-08-12T10:00:00.000Z',
        actor: 'Contact Sender',
        text: 'Could you tell us why your CWL attack was missed?',
        messageId: '888888888888888888',
        deliveryMode: 'bot'
    }];
    const setupState = setup(t, workspace, { mode: 'dm' });

    await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    const description = setupState.moderatorMessages[0].embeds[0].description;
    assert.match(description, /Could you tell us why/i);
    assert.match(description, /family emergency/i);
    assert.ok(description.indexOf('Could you tell us why') < description.indexOf('family emergency'));
});

test('a follow-up player message is appended while the 72-hour capture window remains open', async t => {
    const workspace = baseWorkspace('needs_review');
    workspace.work.items[0].case.replyCaptureUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    workspace.work.items[0].case.playerResponse = 'First part of my explanation.';
    const setupState = setup(t, workspace, { mode: 'dm' });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: true });
    assert.equal(setupState.mutations.length, 1);
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

test('disabled direct DMs with no legacy capture window leave player DMs untouched', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { enabled: false });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: false });
    assert.equal(setupState.mutations.length, 0);
    assert.equal(setupState.playerMessages.length, 0);
});

test('direct DMs always capture Contact player replies without a second feature flag', async t => {
    const workspace = baseWorkspace();
    const setupState = setup(t, workspace, { enabled: true, legacyReplyFlag: false });

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: true });
    assert.equal(setupState.mutations.length, 1);
});

test('replies to closed or non-contact cases are not assigned accidentally', async t => {
    const workspace = baseWorkspace('needs_review');
    const setupState = setup(t, workspace);

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: false });
    assert.equal(setupState.mutations.length, 0);
    assert.equal(setupState.playerMessages.length, 0);
});

test('a manually delivered contact message never captures an unrelated bot DM', async t => {
    const workspace = baseWorkspace();
    workspace.work.items[0].case.dmDeliveryMode = 'manual';
    workspace.work.items[0].case.dmMessageId = '';
    const setupState = setup(t, workspace);

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: false });
    assert.equal(setupState.mutations.length, 0);
});

test('a Discord message reply identifies the correct case when one player has two open contacts', async t => {
    const workspace = baseWorkspace();
    workspace.work.items.push({
        ...structuredClone(workspace.work.items[0]),
        tag: '#Q2L9CG',
        case: {
            ...structuredClone(workspace.work.items[0].case),
            tag: '#Q2L9CG',
            dmMessageId: '999999999999999999',
            dmSentAt: '2026-08-12T11:00:00.000Z'
        }
    });
    const setupState = setup(t, workspace);
    setupState.message.reference = { messageId: '888888888888888888' };

    const result = await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(result, { handled: true, captured: true });
    assert.equal(setupState.mutations.length, 1);
    assert.equal(setupState.mutations[0][0].tag, '#P0LYGQ');
    assert.equal(setupState.mutations[0][3].responseToMessageId, '888888888888888888');
});

test('the contact sender always receives the player response even when another moderator owns the case', async t => {
    const workspace = baseWorkspace();
    workspace.work.items[0].case.dmSentByDiscordId = '666666666666666666';
    workspace.work.items[0].case.dmSentByName = 'Contact Sender';
    const setupState = setup(t, workspace, {
        mode: 'dm',
        senderModerator: {
            discordId: '666666666666666666',
            notificationMode: 'channel',
            displayName: 'Contact Sender'
        }
    });

    await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.deepEqual(
        setupState.directMessages.map(entry => entry.discordId).sort(),
        ['333333333333333333', '666666666666666666']
    );
    const senderDm = setupState.directMessages.find(entry => entry.discordId === '666666666666666666');
    assert.match(senderDm.payload.embeds[0].description, /contact DM you sent/i);
    assert.match(senderDm.payload.embeds[0].description, /family emergency/i);
});

test('existing contact cases resolve the sender only from one exact moderator name match', () => {
    const workspace = baseWorkspace();
    workspace.work.items[0].case.activity = [{
        type: 'dm_sent',
        actor: 'Contact Sender'
    }];
    const { legacyDmSenderId } = require('../src/features/warFollowup/playerReply');

    assert.equal(legacyDmSenderId(workspace.work.items[0], {
        moderators: {
            '666666666666666666': { discordId: '666666666666666666', displayName: 'Contact Sender' }
        }
    }), '666666666666666666');
    assert.equal(legacyDmSenderId(workspace.work.items[0], {
        moderators: {
            '666666666666666666': { discordId: '666666666666666666', displayName: 'Contact Sender' },
            '777777777777777777': { discordId: '777777777777777777', displayName: 'Contact Sender' }
        }
    }), '');
});

test('a blocked sender DM falls back to a private-content-safe channel ping', async t => {
    const workspace = baseWorkspace();
    workspace.work.items[0].case.dmSentByDiscordId = '666666666666666666';
    const setupState = setup(t, workspace, {
        mode: 'channel',
        failingDmId: '666666666666666666',
        senderModerator: {
            discordId: '666666666666666666',
            notificationMode: 'dm',
            displayName: 'Contact Sender'
        }
    });

    await handleWarFollowupPlayerReply(setupState.message, setupState.client);

    assert.equal(setupState.channelMessages.length, 2);
    const senderFallback = setupState.channelMessages.find(payload => payload.content === '<@666666666666666666>');
    assert.ok(senderFallback);
    assert.doesNotMatch(senderFallback.embeds[0].description, /family emergency/i);
});
