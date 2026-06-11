const test = require('node:test');
const assert = require('node:assert/strict');

const handleClashPerkLinkMessage = require('../src/features/clashPerkLinks/handleClashPerkLinkMessage');
const messageUpdateEvent = require('../src/events/messageUpdate');
const {
    getClashPerkMessageTextCandidates,
    isConfiguredClashPerkBotMessage,
    parseClashPerkLinkMessage,
    searchGuildMembersByDisplayName
} = require('../src/features/clashPerkLinks/handleClashPerkLinkMessage');

function buildMember(id, displayName, username = displayName, bot = false, userOverrides = {}) {
    return {
        id,
        displayName,
        user: {
            id,
            username,
            bot,
            ...userOverrides
        }
    };
}

function buildMessage({
    content,
    members,
    authorId = 'clashperk',
    authorBot = true,
    id = '',
    webhookId = null,
    applicationId = null
}) {
    const sent = [];

    return {
        id,
        content,
        cleanContent: '',
        systemContent: '',
        embeds: [],
        webhookId,
        applicationId,
        author: {
            id: authorId,
            username: 'ClashPerk',
            bot: authorBot
        },
        channel: {
            id: 'channel-1',
            send: async value => {
                sent.push(value);
            }
        },
        guild: {
            members: {
                cache: new Map(),
                search: async () => new Map(members.map(member => [member.id, member]))
            }
        },
        sent
    };
}

test('parses ClashPerk bold successful link message', () => {
    const parsed = parseClashPerkLinkMessage('Successfully linked **DOOM (#P29LQ2C2U)** to **cleanupkid_**.');

    assert.equal(parsed.playerName, 'DOOM');
    assert.equal(parsed.playerTag, '#P29LQ2C2U');
    assert.equal(parsed.displayName, 'cleanupkid_');
});

test('parses ClashPerk plain successful link message', () => {
    const parsed = parseClashPerkLinkMessage('Successfully linked Ashish v2.0 (#P2QUL292G) to sagar.');

    assert.equal(parsed.playerName, 'Ashish v2.0');
    assert.equal(parsed.playerTag, '#P2QUL292G');
    assert.equal(parsed.displayName, 'sagar');
});

test('extracts ClashPerk link text from embed descriptions without footer noise', () => {
    const message = {
        content: '',
        embeds: [
            {
                description: 'Successfully linked **DOOM (#P29LQ2C2U)** to **cleanupkid_**.',
                footer: { text: 'Requested by another command' }
            }
        ]
    };

    assert.equal(
        parseClashPerkLinkMessage(getClashPerkMessageTextCandidates(message)).displayName,
        'cleanupkid_'
    );
});

test('parses ClashPerk link text with harmless prefix content', () => {
    const parsed = parseClashPerkLinkMessage('✅ Successfully linked **DOOM (#P29LQ2C2U)** to **cleanupkid_**.');

    assert.equal(parsed.playerTag, '#P29LQ2C2U');
    assert.equal(parsed.displayName, 'cleanupkid_');
});

test('matches guild members by exact account display name and ignores bots', async () => {
    const human = buildMember('111', 'server-sagar', 'real_sagar', false, {
        globalName: 'sagar'
    });
    const bot = buildMember('222', 'server-sagar', 'bot_sagar', true, {
        globalName: 'sagar'
    });
    const guild = {
        members: {
            cache: new Map(),
            search: async () => new Map([
                [human.id, human],
                [bot.id, bot]
            ])
        }
    };

    assert.deepEqual(await searchGuildMembersByDisplayName(guild, 'sagar'), [human]);
});

test('falls back to full guild member listing for global display names', async () => {
    const member = buildMember('111', 'Server Display Name', 'actual_username', false, {
        globalName: 'Display Name'
    });
    const guild = {
        members: {
            cache: new Map(),
            search: async () => new Map(),
            list: async () => new Map([[member.id, member]])
        }
    };

    assert.deepEqual(await searchGuildMembersByDisplayName(guild, 'Display Name'), [member]);
});

test('uses Discord username before server-level display names', async () => {
    const member = buildMember('111', 'server_name', 'account_username');
    const guild = {
        members: {
            cache: new Map(),
            search: async () => new Map([[member.id, member]])
        }
    };

    assert.deepEqual(await searchGuildMembersByDisplayName(guild, 'account_username'), [member]);
    assert.deepEqual(await searchGuildMembersByDisplayName(guild, 'server_name'), []);
});

test('accepts a ClashPerk-named bot or webhook when author id is not the configured id', () => {
    const message = buildMessage({
        content: 'Successfully linked Ashish v2.0 (#P2QUL292G) to sagar.',
        members: [],
        authorId: 'webhook-or-other-source'
    });

    assert.equal(isConfiguredClashPerkBotMessage(message, { botId: 'configured-bot-id' }), true);
});

test('accepts ClashPerk webhook-style public interaction replies', async () => {
    const member = buildMember('111', 'Steimi', 'steimi');
    const message = buildMessage({
        content: 'Successfully linked Bigfoot (#2PCQ2CGL8) to Steimi.',
        members: [member],
        authorId: 'webhook-user-id',
        authorBot: false,
        webhookId: 'webhook-id'
    });
    const calls = [];

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: { botId: 'configured-bot-id' },
        syncDiscordIdentityForPlayerTag: async (...args) => {
            calls.push(args);
            return { ok: true, updated: true };
        }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['#2PCQ2CGL8', '111', 'steimi']]);
});

test('saves unambiguous ClashPerk link to backend and sends success message', async () => {
    const member = buildMember('111', 'server-cleanupkid', 'cleanupkid', false, {
        globalName: 'cleanupkid_'
    });
    const message = buildMessage({
        content: 'Successfully linked **DOOM (#P29LQ2C2U)** to **cleanupkid_**.',
        members: [member]
    });
    const calls = [];

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: {
            botId: 'clashperk',
            linkSavedMessage: 'Link Saved'
        },
        syncDiscordIdentityForPlayerTag: async (...args) => {
            calls.push(args);
            return { ok: true, updated: true };
        }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [['#P29LQ2C2U', '111', 'cleanupkid']]);
    assert.deepEqual(message.sent, ['Link Saved']);
});

test('handles ClashPerk link text arriving on message update', async () => {
    const message = buildMessage({
        id: 'updated-message-1',
        content: 'Successfully linked Bigfoot (#2PCQ2CGL8) to Steimi.',
        members: []
    });
    const calls = [];

    await messageUpdateEvent.execute(null, message);

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: { botId: 'clashperk' },
        syncDiscordIdentityForPlayerTag: async (...args) => {
            calls.push(args);
            return { ok: true, updated: true };
        }
    });

    assert.equal(result, null);
    assert.deepEqual(calls, []);
});

test('does not process the same ClashPerk message id twice', async () => {
    const member = buildMember('111', 'Steimi', 'steimi');
    const message = buildMessage({
        id: 'duplicate-message-1',
        content: 'Successfully linked Bigfoot (#2PCQ2CGL8) to Steimi.',
        members: [member]
    });
    const calls = [];
    const options = {
        clashPerkConfig: { botId: 'clashperk' },
        syncDiscordIdentityForPlayerTag: async (...args) => {
            calls.push(args);
            return { ok: true, updated: true };
        }
    };

    const first = await handleClashPerkLinkMessage(message, options);
    const second = await handleClashPerkLinkMessage(message, options);

    assert.equal(first.ok, true);
    assert.equal(second, null);
    assert.equal(calls.length, 1);
    assert.deepEqual(message.sent, ['Link Saved']);
});

test('warns when a ClashPerk candidate arrives without readable content', async () => {
    const message = buildMessage({
        id: 'empty-content-message-1',
        content: '',
        members: []
    });
    const originalWarn = console.warn;
    const warnings = [];

    console.warn = (...args) => {
        warnings.push(args);
    };

    try {
        const result = await handleClashPerkLinkMessage(message, {
            clashPerkConfig: { botId: 'clashperk' }
        });

        assert.equal(result, null);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
    assert.match(warnings[0][0], /without readable message content/);
});

test('warns and skips backend sync for ambiguous display names', async () => {
    const message = buildMessage({
        content: 'Successfully linked Ashish v2.0 (#P2QUL292G) to sagar.',
        members: [
            buildMember('111', 'server-sagar-one', 'sagar_one', false, {
                globalName: 'sagar'
            }),
            buildMember('222', 'server-sagar-two', 'sagar_two', false, {
                globalName: 'sagar'
            })
        ]
    });
    let syncCalled = false;

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: { botId: 'clashperk' },
        syncDiscordIdentityForPlayerTag: async () => {
            syncCalled = true;
            return { ok: true };
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'ambiguous-display-name');
    assert.equal(syncCalled, false);
    assert.match(message.sent[0], /ambiguous/);
    assert.match(message.sent[0], /admin panel/);
});

test('warns and skips backend sync when display name is not found', async () => {
    const message = buildMessage({
        content: 'Successfully linked Ashish v2.0 (#P2QUL292G) to sagar.',
        members: []
    });

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: { botId: 'clashperk' },
        syncDiscordIdentityForPlayerTag: async () => {
            throw new Error('should not sync');
        }
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'display-name-not-found');
    assert.match(message.sent[0], /no Discord member/);
});

test('ignores messages from other bots', async () => {
    const message = buildMessage({
        content: 'Successfully linked Ashish v2.0 (#P2QUL292G) to sagar.',
        members: [buildMember('111', 'sagar')]
    });
    message.author.id = 'other-bot';
    message.author.username = 'OtherBot';

    const result = await handleClashPerkLinkMessage(message, {
        clashPerkConfig: { botId: 'clashperk' },
        syncDiscordIdentityForPlayerTag: async () => {
            throw new Error('should not sync');
        }
    });

    assert.equal(result, null);
    assert.deepEqual(message.sent, []);
});
