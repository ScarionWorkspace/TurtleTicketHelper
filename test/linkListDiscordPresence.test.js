const test = require('node:test');
const assert = require('node:assert/strict');
const {
    DISCORD_UNKNOWN_MEMBER_CODE,
    buildDiscordPresenceById,
    fetchDiscordMemberPresence,
    getUniqueDiscordIds
} = require('../src/features/linkList/linkListDiscordPresence');

function buildGuild(fetchImpl) {
    return {
        members: {
            fetch: fetchImpl
        }
    };
}

test('collects unique Discord IDs from linked rows', () => {
    assert.deepEqual(
        getUniqueDiscordIds([
            { discordId: '111' },
            { discordId: '111' },
            { discordId: '' },
            { discordUsername: 'username_only' },
            { discordId: '222' }
        ]),
        ['111', '222']
    );
});

test('marks confirmed unknown Discord members as absent', async () => {
    const requested = [];
    const guild = buildGuild(async discordId => {
        requested.push(discordId);
        if (discordId.user === '222') {
            const error = new Error('Unknown Member');
            error.code = DISCORD_UNKNOWN_MEMBER_CODE;
            throw error;
        }

        return { id: discordId.user };
    });

    assert.equal(await fetchDiscordMemberPresence(guild, '111'), true);
    assert.equal(await fetchDiscordMemberPresence(guild, '222'), false);
    assert.deepEqual(requested, [
        {
            user: '111',
            cache: false,
            force: true
        },
        {
            user: '222',
            cache: false,
            force: true
        }
    ]);
});

test('keeps ambiguous Discord member fetch failures unknown', async () => {
    const guild = buildGuild(async () => {
        const error = new Error('Temporary failure');
        error.code = 500;
        throw error;
    });
    const originalWarn = console.warn;
    const warnings = [];

    console.warn = (...args) => {
        warnings.push(args);
    };

    try {
        assert.equal(await fetchDiscordMemberPresence(guild, '111'), null);
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(warnings.length, 1);
});

test('builds Discord presence map for linked rows', async () => {
    const guild = buildGuild(async discordId => {
        if (discordId.user === '222') {
            const error = new Error('Unknown Member');
            error.code = DISCORD_UNKNOWN_MEMBER_CODE;
            throw error;
        }

        return { id: discordId.user };
    });

    assert.deepEqual(
        await buildDiscordPresenceById(guild, [
            { discordId: '111' },
            { discordId: '222' },
            { discordUsername: 'username_only' }
        ]),
        {
            '111': true,
            '222': false
        }
    );
});
