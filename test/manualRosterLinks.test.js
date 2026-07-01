const test = require('node:test');
const assert = require('node:assert/strict');
const { ApplicationCommandOptionType, InteractionContextType, PermissionFlagsBits } = require('discord.js');

const linkCommand = require('../src/commands/utility/link');
const linkDeleteCommand = require('../src/commands/utility/linkDelete');
const {
    buildLinkSuccessMessage,
    handleLinkCommand,
    handleLinkDeleteCommand,
    mapRosterLinkError
} = require('../src/features/rosterLinks/manualRosterLinks');

function buildInteraction({
    userOption = null,
    playerTag = null,
    force = null,
    guildId = 'guild-1'
} = {}) {
    const calls = [];
    const interaction = {
        guildId,
        member: { roles: { cache: new Map() } },
        deferred: false,
        replied: false,
        options: {
            getUser: (name, required = false) => {
                assert.equal(name, 'user');
                if (!userOption && required) throw new Error('missing user option');
                return userOption;
            },
            getString: (name, required = false) => {
                assert.equal(name, 'player_tag');
                if (playerTag === null && required) throw new Error('missing player_tag option');
                return playerTag;
            },
            getBoolean: name => {
                assert.equal(name, 'force');
                return force;
            }
        },
        reply: async payload => {
            interaction.replied = true;
            calls.push({ method: 'reply', payload });
        },
        deferReply: async payload => {
            interaction.deferred = true;
            calls.push({ method: 'deferReply', payload });
        },
        editReply: async payload => {
            calls.push({ method: 'editReply', payload });
        },
        followUp: async payload => {
            calls.push({ method: 'followUp', payload });
        },
        calls
    };

    return interaction;
}

function buildBackend(overrides = {}) {
    return {
        isRosterBackendConfigured: () => true,
        linkDiscordIdentityForPlayerTag: async () => ({ ok: true, tag: '#2LUCULP', playerName: 'Alpha' }),
        deleteDiscordIdentityLink: async () => ({
            ok: true,
            lookupType: 'playerTag',
            deletedCount: 1,
            removedPlayerTags: ['#2LUCULP'],
            removedDiscordId: '111111111111111111'
        }),
        ...overrides
    };
}

test('link command uses guild context, default permissions, and correct option types', () => {
    const json = linkCommand.data.toJSON();

    assert.equal(json.name, 'link');
    assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
    assert.equal(json.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
    assert.deepEqual(
        json.options.map(option => [option.name, option.type, option.required]),
        [
            ['user', ApplicationCommandOptionType.User, true],
            ['player_tag', ApplicationCommandOptionType.String, true],
            ['force', ApplicationCommandOptionType.Boolean, false]
        ]
    );
});

test('link-delete command uses guild context and optional user/tag lookup options', () => {
    const json = linkDeleteCommand.data.toJSON();

    assert.equal(json.name, 'link-delete');
    assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
    assert.equal(json.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
    assert.deepEqual(
        json.options.map(option => [option.name, option.type, option.required]),
        [
            ['user', ApplicationCommandOptionType.User, false],
            ['player_tag', ApplicationCommandOptionType.String, false]
        ]
    );
});

test('handleLinkCommand defers ephemerally and sends normalized backend payload', async () => {
    const backendCalls = [];
    const interaction = buildInteraction({
        userOption: { id: '111111111111111111', username: 'alpha_user' },
        playerTag: '2luculp'
    });

    await handleLinkCommand(interaction, {
        isStaffMember: () => true,
        rosterBackend: buildBackend({
            linkDiscordIdentityForPlayerTag: async payload => {
                backendCalls.push(payload);
                return { ok: true, tag: '#2LUCULP', playerName: 'Alpha' };
            }
        })
    });

    assert.deepEqual(backendCalls, [{
        playerTag: '#2LUCULP',
        discordId: '111111111111111111',
        discordUsername: 'alpha_user',
        force: false
    }]);
    assert.deepEqual(interaction.calls[0], {
        method: 'deferReply',
        payload: { flags: 64 }
    });
    assert.match(interaction.calls.at(-1).payload.content, /Linked <@111111111111111111> to Alpha \(#2LUCULP\)/);
});

test('buildLinkSuccessMessage reports already linked results without conflict text', () => {
    const content = buildLinkSuccessMessage(
        {
            ok: true,
            tag: '#9PYLQG',
            playerName: 'Bravo',
            alreadyLinked: true,
            conflictsResolvedCount: 0
        },
        { id: '222222222222222222', username: 'bravo' },
        '#9PYLQG'
    );

    assert.equal(content, 'Bravo (#9PYLQG) is already linked to <@222222222222222222>.');
});

test('handleLinkCommand passes force true and maps backend conflicts clearly', async () => {
    const backendCalls = [];
    const interaction = buildInteraction({
        userOption: { id: '222222222222222222', username: 'bravo' },
        playerTag: '#9pylqg',
        force: true
    });

    await handleLinkCommand(interaction, {
        isStaffMember: () => true,
        rosterBackend: buildBackend({
            linkDiscordIdentityForPlayerTag: async payload => {
                backendCalls.push(payload);
                const err = new Error('Discord ID 222222222222222222 is already linked to #2LUCULP.');
                err.code = 'DISCORD_LINK_CONFLICT';
                throw err;
            }
        })
    });

    assert.equal(backendCalls[0].force, true);
    assert.match(interaction.calls.at(-1).payload.content, /Conflict:/);
    assert.match(interaction.calls.at(-1).payload.content, /force:true/);
});

test('handleLinkDeleteCommand requires exactly one lookup before deferring', async () => {
    const both = buildInteraction({
        userOption: { id: '111111111111111111', username: 'alpha_user' },
        playerTag: '#2LUCULP'
    });
    const neither = buildInteraction();

    await handleLinkDeleteCommand(both, {
        isStaffMember: () => true,
        rosterBackend: buildBackend()
    });
    await handleLinkDeleteCommand(neither, {
        isStaffMember: () => true,
        rosterBackend: buildBackend()
    });

    assert.equal(both.calls[0].method, 'reply');
    assert.equal(both.calls[0].payload.flags, 64);
    assert.match(both.calls[0].payload.content, /exactly one/);
    assert.equal(neither.calls[0].method, 'reply');
    assert.match(neither.calls[0].payload.content, /exactly one/);
});

test('handleLinkDeleteCommand deletes by Discord user', async () => {
    const backendCalls = [];
    const interaction = buildInteraction({
        userOption: { id: '222222222222222222', username: 'bravo' }
    });

    await handleLinkDeleteCommand(interaction, {
        isStaffMember: () => true,
        rosterBackend: buildBackend({
            deleteDiscordIdentityLink: async payload => {
                backendCalls.push(payload);
                return {
                    ok: true,
                    lookupType: 'discordUser',
                    deletedCount: 1,
                    removedPlayerTags: ['#9PYLQG'],
                    removedLinks: [{ tag: '#9PYLQG', discordId: '222222222222222222', discordUsername: 'bravo' }]
                };
            }
        })
    });

    assert.deepEqual(backendCalls, [{
        playerTag: '',
        discordId: '222222222222222222',
        discordUsername: 'bravo'
    }]);
    assert.equal(interaction.calls[0].method, 'deferReply');
    assert.match(interaction.calls.at(-1).payload.content, /Deleted 1 backend link for <@222222222222222222>: #9PYLQG/);
});

test('manual link commands return clear permission and backend config errors', async () => {
    const missingPermission = buildInteraction({
        userOption: { id: '111111111111111111', username: 'alpha_user' },
        playerTag: '#2LUCULP'
    });
    const missingConfig = buildInteraction({
        userOption: { id: '111111111111111111', username: 'alpha_user' },
        playerTag: '#2LUCULP'
    });

    await handleLinkCommand(missingPermission, {
        isStaffMember: () => false,
        rosterBackend: buildBackend()
    });
    await handleLinkCommand(missingConfig, {
        isStaffMember: () => true,
        rosterBackend: buildBackend({
            isRosterBackendConfigured: () => false
        })
    });

    assert.match(missingPermission.calls[0].payload.content, /Missing permission/);
    assert.match(missingConfig.calls[0].payload.content, /backend configuration is missing/i);
    assert.equal(missingPermission.calls[0].payload.flags, 64);
    assert.equal(missingConfig.calls[0].payload.flags, 64);
});

test('mapRosterLinkError covers invalid tag, missing player, missing link, and backend failure', () => {
    const invalidTag = new Error('Invalid player tag.');
    invalidTag.code = 'INVALID_PLAYER_TAG';
    const notFound = new Error('Player not found for tag #PYYQQ.');
    notFound.code = 'PLAYER_NOT_FOUND';
    const missingLink = new Error('No backend Discord link was found.');
    missingLink.code = 'DISCORD_LINK_MISSING';
    const htmlResponse = new Error('<!doctype html><html><body>backend failed</body></html>');
    htmlResponse.code = 'INVALID_JSON';

    assert.match(mapRosterLinkError(invalidTag), /Invalid player tag/);
    assert.match(mapRosterLinkError(notFound, { playerTag: '#PYYQQ' }), /Player not found for #PYYQQ/);
    assert.match(mapRosterLinkError(missingLink), /No backend link/);
    assert.match(mapRosterLinkError(htmlResponse), /non-JSON response/);
    assert.doesNotMatch(mapRosterLinkError(htmlResponse), /<html/i);
    assert.match(mapRosterLinkError(new Error('upstream broke')), /Roster backend failure/);
});
