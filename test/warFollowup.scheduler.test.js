'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const workflow = require('../src/features/warFollowup/workflow');
const { createWarFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const { processGuild, runWarFollowupTick } = require('../src/features/warFollowup/scheduler');
const { retireDashboard } = require('../src/features/warFollowup/dashboard');

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
        }
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
