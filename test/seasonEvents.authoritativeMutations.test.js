const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const { getStatusMessage } = require('../src/features/seasonEvents/statusMessages');
const {
    handleAccountSelect,
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

test('signup uses one authoritative mutation call despite stale Cloudflare cache', async () => {
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

    rosterBackend.getSeasonEventMutationContext = async () => {
        assert.fail('signup must not make a separate mutation-context request');
    };
    rosterBackend.registerSeasonEventSignup = async payload => {
        signupPayload = payload;
        return { status: 'signed-up', event: mutationEvent };
    };
    installBackendLeaderboard(mutationEvent);

    const { interaction, state } = makeInteraction();
    await handleSignupButton(interaction, { type: 'donation' });

    assert.equal(signupPayload.eventType, 'donation');
    assert.equal(signupPayload.discordUser.id, 'discord-user-1');
    assert.equal(signupPayload.playerTags, undefined);
    assert.equal(cacheCalls.participant, 0);
    assert.equal(cacheCalls.links, 0);
    assert.equal(cacheCalls.pointer, 0);
    assert.equal(cacheCalls.event, 0);
    assert.equal(state.messageEdits.length, 1);
    assert.match(state.edits.at(-1).content, /signed up/i);
    assert.ok(cacheCalls.invalidatedPrefixes.some(path => path.includes('donation-current')));
    assert.ok(cacheCalls.invalidatedPaths.includes('bootstrap/current'));
});

test('signup account selection calls registration directly without repeating mutation context', async () => {
    const mutationEvent = makeEvent({ activeParticipantCount: 1 });
    let signupCalls = 0;
    let signupPayload = null;

    rosterBackend.getSeasonEventMutationContext = async () => {
        assert.fail('account selection must not repeat mutation context');
    };
    rosterBackend.registerSeasonEventSignup = async payload => {
        signupCalls += 1;
        signupPayload = payload;
        return { status: 'signed-up', event: mutationEvent };
    };
    installBackendLeaderboard(mutationEvent);

    const { interaction, state } = makeInteraction();
    interaction.values = ['#NEW123'];
    await handleAccountSelect(interaction, {
        type: 'donation',
        mode: 'signup',
        userId: 'discord-user-1',
        messageId: 'signup-message-1'
    });

    assert.equal(signupCalls, 1);
    assert.equal(signupPayload.eventType, 'donation');
    assert.deepEqual(signupPayload.playerTags, ['#NEW123']);
    assert.match(state.edits[0].content, /signed up/i);
    assert.equal(state.messageEdits.length, 1);
});

test('direct signup opens the account picker from the authoritative registration response', async () => {
    rosterBackend.getSeasonEventMutationContext = async () => {
        assert.fail('direct signup must not make a separate mutation-context request');
    };
    rosterBackend.registerSeasonEventSignup = async () => ({
        status: 'multiple-linked-accounts',
        event: makeEvent(),
        linkedAccounts: [
            { tag: '#9PYLQG', name: 'Bravo', townHallLevel: 15 },
            { tag: '#8CCVV', name: 'Charlie', townHallLevel: 14 }
        ]
    });

    const { interaction, state } = makeInteraction();
    await handleSignupButton(interaction, { type: 'donation' });

    assert.equal(state.edits.length, 1);
    const response = state.edits[0];
    assert.equal(response.components.length, 1);
    const select = response.components[0].toJSON().components[0];
    assert.deepEqual(select.options.map(option => option.value), ['#9PYLQG', '#8CCVV']);
    assert.equal(state.messageEdits.length, 0);
});

test('direct signup preserves the existing participant management response', async () => {
    rosterBackend.registerSeasonEventSignup = async () => ({
        status: 'already-signed-up',
        event: makeEvent(),
        participant: {
            discordId: 'discord-user-1',
            status: 'signed_up',
            accounts: [{ tag: '#9PYLQG', name: 'Bravo' }]
        }
    });

    const { interaction, state } = makeInteraction();
    await handleSignupButton(interaction, { type: 'donation' });

    assert.match(state.edits[0].content, /already signed up/i);
    assert.ok(state.edits[0].components.length > 0);
    assert.equal(state.messageEdits.length, 0);
});

for (const [status, type] of [
    ['event-not-found', 'donation'],
    ['not-linked', 'donation'],
    ['accounts-outside-event-roster', 'cwl'],
    ['cwl-target-unresolved', 'cwl'],
    ['signups-closed', 'donation']
]) {
    test(`direct signup surfaces ${status} without refreshing the public message`, async () => {
        rosterBackend.registerSeasonEventSignup = async () => ({
            status,
            event: status === 'event-not-found' ? null : makeEvent({ type })
        });
        rosterBackend.getSeasonEventLeaderboard = async () => {
            assert.fail('a failed signup must not refresh the leaderboard');
        };

        const { interaction, state } = makeInteraction();
        await handleSignupButton(interaction, { type });

        assert.equal(state.edits[0].content, getStatusMessage(status, 'Unable to complete signup.'));
        assert.deepEqual(state.edits[0].components || [], []);
        assert.equal(state.messageEdits.length, 0);
    });
}

test('successful signup is acknowledged before the public signup message refresh finishes', async () => {
    const mutationEvent = makeEvent({ activeParticipantCount: 1 });
    rosterBackend.registerSeasonEventSignup = async () => ({
        status: 'signed-up',
        event: mutationEvent
    });
    rosterBackend.isRosterBackendConfigured = () => true;
    let signalLeaderboardStarted = null;
    let finishLeaderboard = null;
    const leaderboardStarted = new Promise(resolve => {
        signalLeaderboardStarted = resolve;
    });
    rosterBackend.getSeasonEventLeaderboard = async payload => {
        signalLeaderboardStarted();
        return new Promise(resolve => {
            finishLeaderboard = () => resolve({
                event: { ...mutationEvent, eventId: payload.eventId },
                leaderboard: []
            });
        });
    };

    const { interaction, state } = makeInteraction();
    const pending = handleSignupButton(interaction, { type: 'donation' });
    await leaderboardStarted;

    assert.match(state.edits[0].content, /signed up/i);
    assert.equal(state.messageEdits.length, 0);
    finishLeaderboard();
    await pending;
    assert.equal(state.messageEdits.length, 1);
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
