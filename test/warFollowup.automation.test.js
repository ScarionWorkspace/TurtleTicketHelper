'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');
const automation = require('../src/features/warFollowup/automation');
const service = require('../src/features/warFollowup/service');
const workflow = require('../src/features/warFollowup/workflow');

const GUILD_ID = '111111111111111111';
const PLAYER_ID = '222222222222222222';
const MODERATOR_ID = '666666666666666666';
const originalMutateCase = service.mutateCase;
const originalSyncModeratorPreference = service.syncModeratorPreference;

afterEach(() => {
    service.mutateCase = originalMutateCase;
    service.syncModeratorPreference = originalSyncModeratorPreference;
});

function createStore(moderators = {}) {
    const deliveries = {};
    return {
        getGuild: () => ({ moderators, deliveries }),
        hasDelivery: (_guildId, key) => Boolean(deliveries[key]),
        getDelivery: (_guildId, key) => deliveries[key] || null,
        recordDeliveries: (_guildId, keys, value) => {
            for (const key of Array.isArray(keys) ? keys : [keys]) deliveries[key] = { ...value };
        },
        deliveries
    };
}

function createClient(options = {}) {
    const sent = [];
    return {
        sent,
        users: {
            fetch: async discordId => ({
                id: discordId,
                send: async payload => {
                    if (options.fail) throw new Error('Discord rejected the DM');
                    sent.push({ discordId, payload });
                    return { id: String(800000000000000000n + BigInt(sent.length)) };
                }
            })
        }
    };
}

function createWorkspace(casePatch = {}) {
    const rosterData = {
        rosters: [{
            id: 'main',
            title: 'Main clan',
            clanTag: '#P0LYGQ',
            main: [{ tag: '#P0LYGQ', name: 'Player One', discord: 'player' }],
            subs: [],
            missing: []
        }],
        playerMetrics: {
            byTag: {
                '#P0LYGQ': { identity: { name: 'Player One', discord: 'player', discordId: PLAYER_ID } }
            }
        }
    };
    const caseValue = workflow.normalizeCase({
        tag: '#P0LYGQ',
        name: 'Player One',
        discordId: PLAYER_ID,
        sourceRosterId: 'main',
        sourceRosterTitle: 'Main clan',
        sourceClanTag: '#P0LYGQ',
        status: 'waiting',
        contactPurpose: 'general',
        contactStage: 'awaiting_first_response',
        dmText: 'Please explain what happened.',
        dmSentAt: '2026-08-12T08:00:00.000Z',
        dmDeliveryMode: 'bot',
        dmMessageId: '777777777777777777',
        waitingUntil: '2026-08-13T08:00:00.000Z',
        updatedAt: '2026-08-12T08:00:00.000Z',
        createdAt: '2026-08-12T08:00:00.000Z',
        ...casePatch
    });
    const privateState = { settings: workflow.sanitizeSettings(null), cases: [caseValue] };
    return { rosterData, privateState, work: workflow.buildWorkItems(rosterData, privateState) };
}

test('contact automation sends one reminder, then returns an unanswered case to Needs action without another DM', async () => {
    const workspace = createWorkspace();
    const store = createStore();
    const client = createClient();
    const calls = [];
    service.mutateCase = async (item, action, patch) => {
        calls.push({ action, patch });
        if (action === 'contact_reminder_sent') {
            return {
                ...item.case,
                status: 'waiting',
                contactStage: 'awaiting_after_reminder',
                contactReminderSentAt: '2026-08-13T09:00:00.000Z',
                contactReminderMessageId: patch.contactReminderMessageId,
                waitingUntil: '2026-08-13T09:00:00.000Z',
                updatedAt: '2026-08-13T09:00:00.000Z'
            };
        }
        if (action === 'contact_no_response') {
            return {
                ...item.case,
                status: 'needs_review',
                contactStage: 'no_response',
                waitingUntil: '',
                updatedAt: '2026-08-13T10:00:00.000Z'
            };
        }
        throw new Error(`Unexpected action ${action}`);
    };
    const config = { features: { directMessages: true, playerReplies: true } };

    const reminded = await automation.processContactAutomations(
        client, GUILD_ID, workspace, store, config, new Date('2026-08-13T09:00:00.000Z')
    );
    assert.deepEqual(reminded.map(entry => entry.action), ['contact_reminder_sent']);
    assert.equal(client.sent.length, 1);
    assert.match(client.sent[0].payload.content, /still waiting for your response/i);

    const noResponse = await automation.processContactAutomations(
        client, GUILD_ID, workspace, store, config, new Date('2026-08-13T10:00:00.000Z')
    );
    assert.deepEqual(noResponse.map(entry => entry.action), ['contact_no_response']);
    assert.equal(client.sent.length, 1, 'no second automatic reminder may be sent');
    assert.equal(workspace.work.items[0].case.contactStage, 'no_response');
    assert.deepEqual(calls.map(call => call.action), ['contact_reminder_sent', 'contact_no_response']);
});

test('queued website contact is delivered once and committed with the website moderator as sender', async () => {
    const workspace = createWorkspace({
        status: 'needs_dm',
        contactStage: '',
        dmSentAt: '',
        dmDeliveryMode: '',
        dmMessageId: '',
        waitingUntil: '',
        dmQueueId: 'website-queue-1',
        dmQueuedByDiscordId: MODERATOR_ID,
        dmQueuedByName: 'Case Leader'
    });
    const store = createStore();
    const client = createClient();
    const calls = [];
    service.mutateCase = async (item, action, patch) => {
        calls.push({ action, patch });
        return {
            ...item.case,
            status: 'waiting',
            contactStage: 'awaiting_first_response',
            dmQueueId: '',
            dmSentAt: '2026-08-13T09:00:00.000Z',
            dmDeliveryMode: 'bot',
            dmMessageId: patch.dmMessageId,
            dmSentByDiscordId: patch.dmSentByDiscordId,
            dmSentByName: patch.dmSentByName,
            waitingUntil: '2026-08-14T09:00:00.000Z',
            updatedAt: '2026-08-13T09:00:00.000Z'
        };
    };

    const first = await automation.processQueuedDiscordDms(
        client, GUILD_ID, workspace, store, { features: { directMessages: true } }
    );
    assert.deepEqual(first.map(entry => entry.action), ['mark_dm_sent']);
    assert.equal(client.sent.length, 1);
    assert.match(client.sent[0].payload.content, /reply to this message/i);
    assert.equal(calls[0].patch.dmSentByDiscordId, MODERATOR_ID);
    assert.equal(calls[0].patch.dmSentByName, 'Case Leader');

    const second = await automation.processQueuedDiscordDms(
        client, GUILD_ID, workspace, store, { features: { directMessages: true } }
    );
    assert.deepEqual(second, []);
    assert.equal(client.sent.length, 1);
});

test('a moderator-approved final message never starts another automatic reminder cycle', async () => {
    const workspace = createWorkspace({
        contactStage: 'awaiting_final_response',
        contactAutomaticReminderAllowed: false
    });
    const store = createStore();
    const client = createClient();
    const actions = [];
    service.mutateCase = async (item, action) => {
        actions.push(action);
        return {
            ...item.case,
            status: 'needs_review',
            contactStage: 'no_response',
            waitingUntil: '',
            updatedAt: '2026-08-13T09:00:00.000Z'
        };
    };
    const results = await automation.processContactAutomations(
        client,
        GUILD_ID,
        workspace,
        store,
        { features: { directMessages: true, playerReplies: true } },
        new Date('2026-08-13T09:00:00.000Z')
    );
    assert.deepEqual(results.map(entry => entry.action), ['contact_no_response']);
    assert.deepEqual(actions, ['contact_no_response']);
    assert.equal(client.sent.length, 0);
});

test('moderator directory sync is revision-idempotent and retries failed revisions', async () => {
    const preference = {
        discordId: MODERATOR_ID,
        displayName: 'Case Leader',
        clanTags: ['#P0LYGQ'],
        notificationMode: 'both',
        accepting: true,
        updatedAt: '2026-08-13T09:00:00.000Z'
    };
    const store = createStore({ [MODERATOR_ID]: preference });
    let calls = 0;
    service.syncModeratorPreference = async () => { calls += 1; };
    assert.equal((await automation.syncModeratorDirectory(GUILD_ID, store)).length, 1);
    assert.equal((await automation.syncModeratorDirectory(GUILD_ID, store)).length, 0);
    assert.equal(calls, 1);

    preference.updatedAt = '2026-08-13T10:00:00.000Z';
    let fail = true;
    service.syncModeratorPreference = async () => {
        calls += 1;
        if (fail) throw new Error('temporary backend failure');
    };
    const failed = await automation.syncModeratorDirectory(GUILD_ID, store);
    assert.equal(failed[0].synced, false);
    fail = false;
    const retried = await automation.syncModeratorDirectory(GUILD_ID, store);
    assert.equal(retried[0].synced, true);
    assert.equal(calls, 3);
});
