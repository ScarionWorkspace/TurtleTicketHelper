const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ROSTER_EMBED_COLOR,
    EMBED_DESCRIPTION_MAX_CHARS,
    buildClanProfileUrl,
    buildRosterPlayerMessages
} = require('../src/features/rosterPlayers/rosterPlayersMessage');

test('builds Clash clan profile URLs from normalized clan tags', () => {
    assert.equal(
        buildClanProfileUrl('abc123'),
        'https://link.clashofclans.com/en/?action=OpenClanProfile&tag=%23ABC123'
    );
});

test('builds a public red embed with player lines and Open In-game button', () => {
    const messages = buildRosterPlayerMessages(
        {
            id: 'alpha',
            title: 'Alpha Roster',
            connectedClanTag: '#abc123',
            main: [{
                name: 'Main One',
                tag: '#MAIN1'
            }]
        },
        {
            byTag: {
                '#MAIN1': {
                    identity: {
                        discordId: '111111111111111111'
                    }
                }
            }
        }
    );
    const embed = messages[0].embeds[0].toJSON();
    const button = messages[0].components[0].components[0].toJSON();

    assert.equal(messages.length, 1);
    assert.equal(embed.color, ROSTER_EMBED_COLOR);
    assert.equal(embed.title, 'Alpha Roster');
    assert.equal(embed.description, 'Main One / <@111111111111111111>');
    assert.equal(button.label, 'Open In-game');
    assert.equal(
        button.url,
        'https://link.clashofclans.com/en/?action=OpenClanProfile&tag=%23ABC123'
    );
});

test('builds an empty roster embed without a link button when no clan tag exists', () => {
    const messages = buildRosterPlayerMessages(
        {
            id: 'empty',
            title: 'Empty Roster',
            main: [],
            subs: [],
            missing: []
        },
        { byTag: {} }
    );
    const embed = messages[0].embeds[0].toJSON();

    assert.equal(messages.length, 1);
    assert.equal(embed.title, 'Empty Roster');
    assert.equal(embed.description, 'No players are listed for this roster.');
    assert.deepEqual(messages[0].components, []);
});

test('splits long roster output across embed messages within description limits', () => {
    const main = Array.from({ length: 160 }, (_, index) => ({
        name: `Player ${String(index + 1).padStart(3, '0')}`,
        tag: `#P${String(index + 1).padStart(4, '0')}`
    }));
    const messages = buildRosterPlayerMessages(
        {
            id: 'large',
            title: 'Large Roster',
            connectedClanTag: '#large1',
            main
        },
        { byTag: {} }
    );

    assert(messages.length > 1);
    assert(messages.every(message =>
        message.embeds[0].toJSON().description.length <= EMBED_DESCRIPTION_MAX_CHARS
    ));
    assert.equal(messages[0].components.length, 1);
    assert(messages.slice(1).every(message => message.components.length === 0));
    assert.match(messages[0].embeds[0].toJSON().title, /Large Roster/);
});
