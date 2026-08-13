'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const {
    FEATURE_KEYS,
    createWarFollowupStateStore
} = require('../src/features/warFollowup/stateStore');

const temporaryDirectories = [];

function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-followup-store-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'state.json');
    return { filePath, store: createWarFollowupStateStore({ filePath }) };
}

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

test('all Discord notification categories are opt-in by default', () => {
    const { store } = createStore();
    const record = store.getGuild('111111111111111111');
    assert.equal(record.config.enabled, false);
    assert.deepEqual(
        Object.fromEntries(FEATURE_KEYS.map(key => [key, record.config.features[key]])),
        Object.fromEntries(FEATURE_KEYS.map(key => [key, false]))
    );
});

test('configuration transitions timestamp only the categories explicitly enabled', () => {
    const { store } = createStore();
    const firstAt = new Date('2026-08-01T10:00:00.000Z');
    const secondAt = new Date('2026-08-02T10:00:00.000Z');
    const first = store.patchConfig('111111111111111111', {
        enabled: true,
        channelId: '222222222222222222',
        features: { caseAlerts: true }
    }, firstAt);
    assert.equal(first.featureEnabledAt.caseAlerts, firstAt.toISOString());
    assert.equal(first.featureEnabledAt.attackReminders, undefined);

    const second = store.patchConfig('111111111111111111', {
        features: { attackReminders: true }
    }, secondAt);
    assert.equal(second.featureEnabledAt.caseAlerts, firstAt.toISOString());
    assert.equal(second.featureEnabledAt.attackReminders, secondAt.toISOString());

    store.markSummaryBaselineInitialized('111111111111111111', 'regularWarSummaries');
    store.patchConfig('111111111111111111', { features: { regularWarSummaries: true } }, secondAt);
    assert.equal(
        store.getGuild('111111111111111111').observations.summaryBaselinesInitialized.regularWarSummaries,
        false,
        'newly opting into a summary category requires a fresh no-replay baseline'
    );
});

test('enabling direct DMs also enables reply capture for Contact player conversations', () => {
    const { store } = createStore();
    const config = store.patchConfig('111111111111111111', {
        enabled: true,
        channelId: '222222222222222222',
        features: { directMessages: true, playerReplies: false }
    });

    assert.equal(config.features.directMessages, true);
    assert.equal(config.features.playerReplies, true);
});

test('delivery keys and case baselines survive a fresh process read', () => {
    const { filePath, store } = createStore();
    store.patchConfig('111111111111111111', {
        enabled: true,
        channelId: '222222222222222222'
    });
    store.recordDeliveries('111111111111111111', ['war:key:6h', 'war:key:2h'], {
        messageId: '333333333333333333'
    });
    store.setDashboard('111111111111111111', {
        channelId: '222222222222222222',
        messageId: '444444444444444444',
        semanticHash: 'dashboard-v1'
    });
    store.setModerationHub('111111111111111111', {
        channelId: '555555555555555555',
        messageId: '666666666666666666',
        semanticHash: 'moderation-hub-v1'
    });
    store.replaceCaseObservations('111111111111111111', {
        '#PLAYER': { fingerprint: 'fingerprint', status: 'needs_review', observedAt: '2026-08-01T00:00:00.000Z' }
    }, '2026-08-01T00:00:00.000Z');

    const reloaded = createWarFollowupStateStore({ filePath });
    assert.equal(reloaded.hasDelivery('111111111111111111', 'war:key:6h'), true);
    assert.equal(reloaded.removeDeliveries('111111111111111111', 'war:key:6h'), true);
    assert.equal(reloaded.hasDelivery('111111111111111111', 'war:key:6h'), false);
    assert.equal(reloaded.removeDeliveries('111111111111111111', 'war:key:6h'), false);
    assert.equal(reloaded.getGuild('111111111111111111').dashboard.messageId, '444444444444444444');
    assert.equal(reloaded.getGuild('111111111111111111').dashboard.channelId, '222222222222222222');
    assert.equal(reloaded.getGuild('111111111111111111').moderationHub.messageId, '666666666666666666');
    assert.equal(reloaded.getGuild('111111111111111111').moderationHub.channelId, '555555555555555555');
    assert.equal(
        reloaded.getGuild('111111111111111111').observations.caseFingerprints['#PLAYER'].fingerprint,
        'fingerprint'
    );
});

test('re-enabling after a disabled period clears replay-sensitive baselines', () => {
    const { store } = createStore();
    const guildId = '111111111111111111';
    store.patchConfig(guildId, {
        enabled: true,
        channelId: '222222222222222222',
        features: { caseAlerts: true, missingDiscordDigest: true }
    }, new Date('2026-08-01T10:00:00.000Z'));
    store.replaceCaseObservations(guildId, {
        '#PLAYER': { fingerprint: 'before-disable', status: 'needs_review', observedAt: '2026-08-01T10:00:00.000Z' }
    });
    store.setLastMissingDiscordDigestDate(guildId, '2026-08-01');
    store.patchConfig(guildId, { enabled: false }, new Date('2026-08-02T10:00:00.000Z'));
    const reenabled = store.patchConfig(guildId, { enabled: true }, new Date('2026-08-03T10:00:00.000Z'));
    const record = store.getGuild(guildId);

    assert.deepEqual(record.observations.caseFingerprints, {});
    assert.equal(record.observations.casesInitializedAt, '');
    assert.equal(record.observations.lastMissingDiscordDigestDate, '');
    assert.deepEqual(record.observations.summaryBaselinesInitialized, {
        regularWarSummaries: false,
        cwlEndSummaries: false
    });
    assert.equal(reenabled.featureEnabledAt.caseAlerts, '2026-08-03T10:00:00.000Z');
    assert.equal(reenabled.featureEnabledAt.missingDiscordDigest, '2026-08-03T10:00:00.000Z');
});

test('a corrupt runtime file is backed up rather than silently overwritten', () => {
    const { filePath } = createStore();
    fs.writeFileSync(filePath, '{not json', 'utf8');
    const store = createWarFollowupStateStore({ filePath });
    assert.throws(() => store.getGuild('111111111111111111'), /state is unreadable/);
    const backups = fs.readdirSync(path.dirname(filePath)).filter(name => name.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{not json');
});

test('schema migration persists sanitized per-moderator clan and notification preferences', () => {
    const { filePath } = createStore();
    fs.writeFileSync(filePath, JSON.stringify({
        schemaVersion: 1,
        guilds: {
            '111111111111111111': {
                config: {},
                deliveries: {},
                observations: {}
            }
        }
    }), 'utf8');
    const store = createWarFollowupStateStore({ filePath });
    assert.deepEqual(store.getGuild('111111111111111111').moderators, {});

    const saved = store.upsertModerator('111111111111111111', '222222222222222222', {
        displayName: 'Clan Leader',
        clanTags: ['#CLANO', ' clan2 ', '#CLANO'],
        notificationMode: 'both',
        accepting: true
    }, new Date('2026-08-09T12:00:00.000Z'));
    assert.deepEqual(saved.clanTags, ['#CLAN0', '#CLAN2']);
    assert.equal(saved.notificationMode, 'both');
    assert.equal(saved.accepting, true);

    store.recordModeratorAssignment(
        '111111111111111111',
        '222222222222222222',
        '2026-08-09T13:00:00.000Z'
    );
    const reloaded = createWarFollowupStateStore({ filePath }).getGuild('111111111111111111');
    assert.equal(reloaded.moderators['222222222222222222'].lastAssignedAt, '2026-08-09T13:00:00.000Z');
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).schemaVersion, 3);
});
