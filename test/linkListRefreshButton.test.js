const test = require('node:test');
const assert = require('node:assert/strict');
const {
    MODE_TAGS,
    buildLinkListRefreshCustomId,
    parseLinkListRefreshCustomId
} = require('../src/features/linkList/linkListCustomIds');
const { buildLinkListMessage } = require('../src/features/linkList/linkListMessage');

const REFRESH_EMOJI = '\uD83D\uDD04';

function getRoster() {
    return {
        id: 'alpha',
        title: 'Alpha',
        connectedClanTag: '#2Q0YGUP08',
        main: [],
        subs: [],
        missing: []
    };
}

test('builds and parses link-list refresh custom ids', () => {
    const customId = buildLinkListRefreshCustomId('#2Q0YGUP08', MODE_TAGS);

    assert.equal(customId, 'link_list:v1:refresh:tags:2Q0YGUP08');
    assert.deepEqual(parseLinkListRefreshCustomId(customId), {
        action: 'refresh',
        mode: MODE_TAGS,
        clanTag: '#2Q0YGUP08'
    });
});

test('adds an emoji-only refresh button to the link-list button row', () => {
    const roster = getRoster();
    const message = buildLinkListMessage(
        roster,
        { byTag: {} },
        [],
        MODE_TAGS,
        {
            clanRosters: [roster]
        }
    );
    const buttons = message.components[0].components.map(component => component.toJSON());
    const refreshButton = buttons.find(button =>
        String(button.custom_id || '').startsWith('link_list:v1:refresh:')
    );

    assert(refreshButton);
    assert.equal(refreshButton.custom_id, 'link_list:v1:refresh:tags:2Q0YGUP08');
    assert.equal(refreshButton.label, undefined);
    assert.equal(refreshButton.emoji.name, REFRESH_EMOJI);
});
