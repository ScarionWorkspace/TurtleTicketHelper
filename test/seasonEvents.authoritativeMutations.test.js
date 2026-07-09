const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const {
    handleSignupButton,
    handleOptOutButton,
    handleUpdateButton
} = require('../src/features/seasonEvents/accountFlow');

const originalBackend = {
    isRosterBackendConfigured: rosterBackend.isRosterBackendConfigured,
    getSeasonEventMutationContext: rosterBackend.getSeasonEventMutationContext,
    getSeasonEventLeaderboard: rosterBackend.getSeasonEventLeaderboard,
    registerSeasonEventSignup: rosterBackend.registerSeasonEventSignup,
    cancelSeasonEventSignup: rosterBackend.cancelSeasonEventSignup
};
const originalPublicData = {
    readCurrentSeasonEventPointer: rosterPublicData.readCurrentSeasonEventPointer,
    readSeasonEventById: rosterPublicData.readSeasonEventById,
    readSeasonEventParticipantByDiscordId: rosterPublicData.readSeasonEventParticipantByDiscordId,
    readLinkedAccountsForDiscordUser: rosterPublicData.readLinkedAccountsForDiscordUser,
    readAllActivePlayerMetricsByTag: rosterPublicData.readAllActivePlayerMetricsByTag,
    readDonationRefreshSeasonOverlay: rosterPublicData.readDonationRefreshSeasonOverlay,
    invalidateReadCachePath: rosterPublicData.invalidateReadCachePath,
    invalidateReadCachePrefix: rosterPublicData.invalidateReadCachePrefix
};

function makeEvent(overrides = {}) {
    return {
        eventId: 'donation-current',
        type: 'donation',
        seasonId: 'season-current',
        title: 'Donation Event',
        status: 'open',
        visibility: 'public',
        signupsOpen: true,
        startsAt: '2000-01-01T00:00:00.000Z',
        endsAt: '2100-01-01T00:00:00.000Z',
        settings: { maxAccountsPerParticipant: 3 },
        participantsByDiscordId: {},
        ...overrides
    };
}

function makeInteraction() {
    const state = {
        edits: [],
        replies: [],
        messageEdits: [],
        deferredReplies: [],
        deferredUpdates: 0
    };
    const message = {
        id: 'signup-message-1',
        edit: async payload => {
            state.messageEdits.push(payload);
            return message;
        }
    };
    const interaction = {
        user: {
            id: 'discord-user-1',
            username: 'alice',
            globalName: 'Alice'
        },
        member: { displayName: 'Alice Display' },
        guildId: 'guild-1',
        channelId: 'channel-1',
        message,
        channel: {
            messages: {
                fetch: async messageId => messageId === message.id ? message : null
            }
        },
        deferReply: async payload => state.deferredReplies.push(payload),
        deferUpdate: async () => { state.deferredUpdates += 1; },
        editReply: async payload => {
            state.edits.push(payload);
            return payload;
        },
        reply: async payload => {
            state.replies.push(payload);
            return payload;
        }
    };

    return { interaction, state };
}

function installNoCloudflareMutationReads() {
    const calls = {
        participant: 0,
        links: 0,
        pointer: 0,
        event: 0,
        metrics: 0,
        donationOverlay: 0,
        invalidatedPaths: [],
        invalidatedPrefixes: []
    };

    rosterPublicData.readSeasonEventParticipantByDiscordId = async () => {
        calls.participant += 1;
        return { status: 'signed_up' };
    };
    rosterPublicData.readLinkedAccountsForDiscordUser = async () => {
        calls.links += 1;
        return [];
    };
    rosterPublicData.readCurrentSeasonEventPointer = async () => {
        calls.pointer += 1;
        throw new Error('stale Cloudflare pointer must not be used for mutation correctness');
    };
    rosterPublicData.readSeasonEventById = async () => {
        calls.event += 1;
        throw new Error('stale Cloudflare event must not be used for mutation correctness');
    };
    rosterPublicData.readAllActivePlayerMetricsByTag = async () => {
        calls.metrics += 1;
        throw new Error('Cloudflare active metrics unavailable');
    };
    rosterPublicData.readDonationRefreshSeasonOverlay = async () => {
        calls.donationOverlay += 1;
        throw new Error('Cloudflare donation overlay unavailable');
    };
    rosterPublicData.invalidateReadCachePath = path => calls.invalidatedPaths.push(path);
    rosterPublicData.invalidateReadCachePrefix = prefix => calls.invalidatedPrefixes.push(prefix);

    return calls;
}

function installBackendLeaderboard(event) {
    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getSeasonEventLeaderboard = async payload => ({
        event: {
            ...event,
            eventId: payload.eventId
        },
        leaderboard: []
    });
}

afterEach(() => {
    Object.assign(rosterBackend, originalBackend);
    Object.assign(rosterPublicData, originalPublicData);
});

test('signup uses authoritative participant and newly linked account state despite stale Cloudflare cache', async () => {
    const initialEvent = makeEvent();
    const mutationEvent = makeEvent({
        activeParticipantCount: 1,
        participantsByDiscordId: {
            'discord-user-1': {
                discordId: 'discord-user-1',
                status: 'signed_up',
                accounts: [{ tag: '#NEW123', name: 'Fresh Link' }]
            }
        }
    });
    const cacheCalls = installNoCloudflareMutationReads();
    let signupPayload = null;

    rosterBackend.getSeasonEventMutationContext = async payload => {
        assert.equal(payload.discordUser.id, 'discord-user-1');
        return {
            event: initialEvent,
            participant: null,
            linkedAccounts: [{ tag: '#NEW123', name: 'Fresh Link', townHall: 18 }],
            eligibleAccounts: [{ tag: '#NEW123', name: 'Fresh Link', townHall: 18 }]
        };
    };
    rosterBackend.registerSeasonEventSignup = async payload => {
        signupPayload = payload;
        return { status: 'signed-up', event: mutationEvent };
    };
    installBackendLeaderboard(mutationEvent);

    const { interaction, state } = makeInteraction();
    await handleSignupButton(interaction, { type: 'donation' });

    assert.deepEqual(signupPayload.playerTags, ['#NEW123']);
    assert.equal(cacheCalls.participant, 0);
    assert.equal(cacheCalls.links, 0);
    assert.equal(cacheCalls.pointer, 0);
    assert.equal(cacheCalls.event, 0);
    assert.equal(state.messageEdits.length, 1);
    assert.match(state.edits.at(-1).content, /signed up/i);
    assert.ok(cacheCalls.invalidatedPrefixes.some(path => path.includes('donation-current')));
    assert.ok(cacheCalls.invalidatedPaths.includes('bootstrap/current'));
});

test('cancellation reaches the authoritative backend even when stale cache says no participant exists', async () => {
    const event = makeEvent();
    const mutationEvent = makeEvent({ activeParticipantCount: 0 });
    const cacheCalls = installNoCloudflareMutationReads();
    let cancelPayload = null;

    rosterPublicData.readSeasonEventParticipantByDiscordId = async () => {
        cacheCalls.participant += 1;
        return null;
    };
    rosterBackend.getSeasonEventMutationContext = async () => ({
        event,
        participant: null,
        linkedAccounts: [],
        eligibleAccounts: []
    });
    rosterBackend.cancelSeasonEventSignup = async payload => {
        cancelPayload = payload;
        return { status: 'cancelled', event: mutationEvent };
    };
    installBackendLeaderboard(mutationEvent);

    const { interaction, state } = makeInteraction();
    await handleOptOutButton(interaction, { type: 'donation' });

    assert.equal(cancelPayload.eventId, 'donation-current');
    assert.equal(cancelPayload.discordUser.id, 'discord-user-1');
    assert.equal(cacheCalls.participant, 0);
    assert.equal(cacheCalls.pointer, 0);
    assert.equal(state.messageEdits.length, 1);
    assert.match(state.edits.at(-1).content, /cancelled|canceled|opted out/i);
});

test('account editing uses authoritative participant and linked-account context', async () => {
    const event = makeEvent();
    const cacheCalls = installNoCloudflareMutationReads();

    rosterBackend.getSeasonEventMutationContext = async () => ({
        event,
        participant: {
            discordId: 'discord-user-1',
            status: 'signed_up',
            accounts: [{ tag: '#OLD111', name: 'Old Account' }]
        },
        linkedAccounts: [
            { tag: '#OLD111', name: 'Old Account', townHall: 17 },
            { tag: '#NEW222', name: 'Newly Linked', townHall: 18 }
        ],
        eligibleAccounts: [
            { tag: '#OLD111', name: 'Old Account', townHall: 17 },
            { tag: '#NEW222', name: 'Newly Linked', townHall: 18 }
        ]
    });

    const { interaction, state } = makeInteraction();
    await handleUpdateButton(interaction, {
        type: 'donation',
        userId: 'discord-user-1',
        messageId: 'signup-message-1'
    });

    assert.equal(cacheCalls.participant, 0);
    assert.equal(cacheCalls.links, 0);
    assert.equal(state.deferredUpdates, 1);
    const response = state.edits.at(-1);
    assert.equal(response.components.length, 1);
    const json = response.components[0].toJSON();
    assert.deepEqual(json.components[0].options.map(option => option.value), ['#0LD111', '#NEW222']);
});


test('successful signup remains successful when post-mutation rendering cannot reach backend or Cloudflare', async () => {
    const event = makeEvent();
    const mutationEvent = makeEvent({
        activeParticipantCount: 1,
        participantsByDiscordId: {
            'discord-user-1': {
                discordId: 'discord-user-1',
                status: 'signed_up',
                accounts: [{ tag: '#SAFE123', name: 'Canonical Account' }]
            }
        }
    });
    const cacheCalls = installNoCloudflareMutationReads();

    rosterBackend.getSeasonEventMutationContext = async () => ({
        event,
        participant: null,
        linkedAccounts: [{ tag: '#SAFE123', name: 'Canonical Account', townHall: 18 }],
        eligibleAccounts: [{ tag: '#SAFE123', name: 'Canonical Account', townHall: 18 }]
    });
    rosterBackend.registerSeasonEventSignup = async () => ({
        status: 'signed-up',
        event: mutationEvent
    });
    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.getSeasonEventLeaderboard = async () => {
        throw new Error('backend render context unavailable after canonical mutation');
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const { interaction, state } = makeInteraction();
        await handleSignupButton(interaction, { type: 'donation' });

        assert.match(state.edits.at(-1).content, /signed up/i);
        assert.equal(state.messageEdits.length, 0);
        assert.equal(cacheCalls.metrics, 1);
    } finally {
        console.warn = originalWarn;
    }
});

