const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ApplicationCommandOptionType,
    ButtonStyle,
    InteractionContextType,
    PermissionFlagsBits
} = require('discord.js');
const command = require('../src/commands/cwl/pingCwlRosterMoves');
const {
    MESSAGE_MAX_CHARS,
    autocompleteCwlRosterClan,
    buildCwlRosterMoveMessages,
    getCwlDestinationRosters,
    pingCwlRosterMoves,
    scanCwlRosterMoves
} = require('../src/features/cwlRosterMoves/cwlRosterMoves');

const LINKED_DISCORD_ID = '111111111111111111';
const readEmptyWarFollowupState = async () => ({
    settings: { trustedPlayerTags: [] }
});

function buildPayload() {
    return {
        rosterOrder: ['alpha', 'bravo', 'alpha-second', 'regular', 'unconnected'],
        rosters: {
            alpha: {
                id: 'alpha',
                title: 'Alpha',
                trackingMode: 'cwl',
                connectedClanTag: '#2PP',
                main: [
                    { name: 'Already There', tag: '#P0Y' },
                    { name: 'Needs Move', tag: '#P2Y' }
                ],
                subs: []
            },
            bravo: {
                id: 'bravo',
                title: 'Bravo',
                trackingMode: 'CWL',
                connectedClanTag: '2QQ',
                main: [{ name: 'Unlinked Move', tag: '#Q2Y' }]
            },
            'alpha-second': {
                id: 'alpha-second',
                title: 'Alpha Overflow',
                trackingMode: 'cwl',
                connectedClanTag: '#2PP',
                main: [{ name: 'Second Assignment', tag: '#G2Y' }]
            },
            regular: {
                id: 'regular',
                title: 'Regular War',
                trackingMode: 'regularWar',
                connectedClanTag: '#2RR',
                main: [{ name: 'Ignored', tag: '#R2Y' }]
            },
            unconnected: {
                id: 'unconnected',
                title: 'No Destination',
                trackingMode: 'cwl',
                connectedClanTag: '',
                main: [{ name: 'Ignored Too', tag: '#C2Y' }]
            }
        },
        playerMetrics: {
            byTag: {
                '#P2Y': {
                    identity: {
                        discordId: LINKED_DISCORD_ID
                    }
                },
                '#G2Y': {
                    identity: {
                        discordId: LINKED_DISCORD_ID
                    }
                }
            }
        }
    };
}

function buildInteraction({ selectedClan = null } = {}) {
    const calls = [];
    const sent = [];

    return {
        options: {
            getString: name => {
                assert.equal(name, 'clan');
                return selectedClan;
            }
        },
        channel: {
            send: async payload => {
                sent.push(payload);
            }
        },
        deferReply: async payload => calls.push({ method: 'deferReply', payload }),
        editReply: async payload => calls.push({ method: 'editReply', payload }),
        calls,
        sent
    };
}

test('command is guild-only and limited to members who can manage the server', () => {
    const json = command.data.toJSON();

    assert.equal(json.name, 'ping-cwl-roster-moves');
    assert.deepEqual(json.contexts, [InteractionContextType.Guild]);
    assert.equal(json.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
    assert.deepEqual(json.options.map(option => ({
        name: option.name,
        type: option.type,
        required: option.required,
        autocomplete: option.autocomplete
    })), [{
        name: 'clan',
        type: ApplicationCommandOptionType.String,
        required: false,
        autocomplete: true
    }]);
});

test('selects only active CWL rosters with connected destination clans', () => {
    assert.deepEqual(
        getCwlDestinationRosters(buildPayload()).map(roster => roster.id),
        ['alpha', 'bravo', 'alpha-second']
    );
});

test('autocomplete returns matching CWL destination clans in roster order', async () => {
    const responses = [];
    const interaction = {
        options: {
            getFocused: () => 'brav'
        },
        respond: async choices => responses.push(choices)
    };

    await autocompleteCwlRosterClan(interaction, {
        readActiveRosterPayload: async () => buildPayload()
    });

    assert.deepEqual(responses, [[{
        name: 'Bravo (#2QQ)',
        value: 'bravo'
    }]]);
});

test('checks each unique destination clan once and finds only absent roster players', async () => {
    const fetchedClanTags = [];
    const { plan } = await scanCwlRosterMoves(buildPayload(), {
        fetchClanMembers: async clanTag => {
            fetchedClanTags.push(clanTag);
            return {
                clanTag,
                members: clanTag === '#2PP'
                    ? [{ tag: '#P0Y', name: 'Already There' }]
                    : []
            };
        }
    });

    assert.deepEqual(fetchedClanTags.sort(), ['#2PP', '#2QQ']);
    assert.equal(plan.movingAccountCount, 3);
    assert.equal(plan.pingableMemberCount, 1);
    assert.equal(plan.unlinkedAccountCount, 1);
    assert.deepEqual(
        plan.groups.flatMap(group => group.movers.map(mover => mover.name)),
        ['Needs Move', 'Unlinked Move', 'Second Assignment']
    );
});

test('a selected clan scans only that destination roster', async () => {
    const fetchedClanTags = [];
    const { rosters, plan } = await scanCwlRosterMoves(buildPayload(), {
        rosterId: 'bravo',
        fetchClanMembers: async clanTag => {
            fetchedClanTags.push(clanTag);
            return { clanTag, members: [] };
        }
    });

    assert.deepEqual(fetchedClanTags, ['#2QQ']);
    assert.deepEqual(rosters.map(roster => roster.id), ['bravo']);
    assert.deepEqual(plan.groups.map(group => group.rosterId), ['bravo']);
    assert.equal(plan.movingAccountCount, 1);
});

test('builds bounded public messages and pings each linked Discord member only once', async () => {
    const { plan } = await scanCwlRosterMoves(buildPayload(), {
        fetchClanMembers: async clanTag => ({
            clanTag,
            members: clanTag === '#2PP' ? [{ tag: '#P0Y' }] : []
        })
    });
    const messages = buildCwlRosterMoveMessages(plan);

    assert(messages.length >= 3);
    assert(messages.every(message => message.content.length <= MESSAGE_MAX_CHARS));
    assert.equal(
        messages.flatMap(message => message.allowedMentions.users)
            .filter(id => id === LINKED_DISCORD_ID).length,
        1
    );
    assert(messages.every(message => message.allowedMentions.parse.length === 0));
    assert(messages.every(message => message.allowedMentions.roles.length === 0));
    assert.match(messages[0].content, /Move here.*Open Alpha in Clash of Clans/s);
    assert.match(messages[0].content, /Hey <@111111111111111111>.*saved.*Needs Move.*CWL spot/s);
    assert(messages.some(message => /Unlinked Move.*no linked Discord member/s.test(message.content)));
    const button = messages[0].components[0].components[0].toJSON();
    assert.equal(button.style, ButtonStyle.Link);
    assert.equal(button.label, 'Open Alpha in-game');
    assert.equal(
        button.url,
        'https://link.clashofclans.com/en/?action=OpenClanProfile&tag=%232PP'
    );
});

test('always-ignored accounts and every account linked to that Discord user are excluded', async () => {
    const { plan } = await scanCwlRosterMoves(buildPayload(), {
        ignoredPlayerTags: ['#P2Y'],
        fetchClanMembers: async clanTag => ({
            clanTag,
            members: clanTag === '#2PP' ? [{ tag: '#P0Y' }] : []
        })
    });

    assert.equal(plan.alwaysIgnoredAccountCount, 2);
    assert.equal(plan.movingAccountCount, 1);
    assert.equal(plan.pingableMemberCount, 0);
    assert.deepEqual(
        plan.groups.flatMap(group => group.movers.map(mover => mover.name)),
        ['Unlinked Move']
    );
});

test('aborts without public messages when any destination clan cannot be verified', async () => {
    const interaction = buildInteraction();

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        readWarFollowupPrivateState: readEmptyWarFollowupState,
        fetchClanMembers: async clanTag => {
            if (clanTag === '#2QQ') {
                throw new Error('CLASH_API_TIMEOUT');
            }

            return { clanTag, members: [] };
        }
    });

    assert.equal(interaction.sent.length, 0);
    assert.deepEqual(interaction.calls[0], {
        method: 'deferReply',
        payload: { flags: 64 }
    });
    assert.match(
        interaction.calls.at(-1).payload,
        /no move pings were sent.*#2QQ/i
    );
});

test('posts mover notices and reports unique ping and unlinked counts privately', async () => {
    const interaction = buildInteraction();

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        readWarFollowupPrivateState: readEmptyWarFollowupState,
        fetchClanMembers: async clanTag => ({
            clanTag,
            members: clanTag === '#2PP' ? [{ tag: '#P0Y' }] : []
        })
    });

    assert(interaction.sent.length >= 3);
    assert.match(interaction.calls.at(-1).payload, /3 Clash accounts/);
    assert.match(interaction.calls.at(-1).payload, /pinged 1 linked Discord member/);
    assert.match(interaction.calls.at(-1).payload, /1 moving account has no linked Discord ID/);
});

test('command selection fetches and posts only the chosen destination clan', async () => {
    const interaction = buildInteraction({ selectedClan: 'bravo' });
    const fetchedClanTags = [];

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        readWarFollowupPrivateState: readEmptyWarFollowupState,
        fetchClanMembers: async clanTag => {
            fetchedClanTags.push(clanTag);
            return { clanTag, members: [] };
        }
    });

    assert.deepEqual(fetchedClanTags, ['#2QQ']);
    assert.equal(interaction.sent.length, 1);
    assert.match(interaction.sent[0].content, /Bravo/);
    assert.doesNotMatch(interaction.sent[0].content, /Alpha/);
});

test('stale selected clan fails safely without fetching or posting', async () => {
    const interaction = buildInteraction({ selectedClan: 'deleted-roster' });
    let fetchCount = 0;

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        fetchClanMembers: async () => {
            fetchCount += 1;
            return { members: [] };
        }
    });

    assert.equal(fetchCount, 0);
    assert.equal(interaction.sent.length, 0);
    assert.match(interaction.calls.at(-1).payload, /no longer available/i);
});

test('command sends no notice when every out-of-clan account is always ignored', async () => {
    const interaction = buildInteraction({ selectedClan: 'alpha' });

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        readWarFollowupPrivateState: async () => ({
            settings: { trustedPlayerTags: ['#P2Y'] }
        }),
        fetchClanMembers: async clanTag => ({
            clanTag,
            members: [{ tag: '#P0Y' }]
        })
    });

    assert.equal(interaction.sent.length, 0);
    assert.match(interaction.calls.at(-1).payload, /Always ignore setting/);
});

test('command fails closed when the always-ignore list cannot be verified', async () => {
    const interaction = buildInteraction({ selectedClan: 'alpha' });
    let clanFetchCount = 0;

    await pingCwlRosterMoves(interaction, {
        readActiveRosterPayload: async () => buildPayload(),
        readWarFollowupPrivateState: async () => {
            throw new Error('temporary backend failure');
        },
        fetchClanMembers: async () => {
            clanFetchCount += 1;
            return { members: [] };
        }
    });

    assert.equal(clanFetchCount, 0);
    assert.equal(interaction.sent.length, 0);
    assert.match(interaction.calls.at(-1).payload, /Always ignore list.*no move pings were sent/i);
});
