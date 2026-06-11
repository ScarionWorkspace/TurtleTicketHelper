const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFirebaseObjectKey } = require('../src/features/rosterFirebase/rosterFirebaseReadClient');
const {
    buildLinkListModel,
    buildLinkListPlayerRows,
    getSelectableClanRosters,
    findRosterByClanTag
} = require('../src/features/linkList/linkListData');

test('builds selectable clan rosters from valid unique connected clan tags', () => {
    const payload = {
        rosterOrder: ['bravo', 'alpha', 'duplicate', 'invalid'],
        rosters: {
            alpha: {
                id: 'alpha',
                title: 'Alpha',
                connectedClanTag: '#2Q0YGUP08'
            },
            ignored: {
                id: 'ignored',
                title: 'Ignored'
            },
            duplicate: {
                id: 'duplicate',
                title: 'Duplicate Bravo',
                connectedClanTag: '#8L28LJCC'
            },
            invalid: {
                id: 'invalid',
                title: 'Invalid',
                connectedClanTag: 'not a clan tag'
            },
            bravo: {
                id: 'bravo',
                title: 'Bravo',
                connectedClanTag: '8L28LJCC'
            }
        }
    };

    assert.deepEqual(
        getSelectableClanRosters(payload).map(roster => roster.id),
        ['bravo', 'alpha']
    );
    assert.equal(findRosterByClanTag(payload, '#8L28LJCC').id, 'bravo');
});

test('uses live clan members as the authoritative player list', () => {
    const linkedMetricKey = encodeFirebaseObjectKey('#LINK1');
    const rows = buildLinkListPlayerRows(
        {
            id: 'alpha',
            title: 'Alpha',
            connectedClanTag: '#2Q0YGUP08',
            main: [
                {
                    name: 'Linked One',
                    tag: '#LINK1'
                },
                {
                    name: 'Absent Linked',
                    tag: '#ABSNT'
                }
            ],
            subs: [],
            missing: [
                {
                    name: 'Missing In Database',
                    tag: '#MISS1'
                }
            ]
        },
        {
            byTag: {
                [linkedMetricKey]: {
                    identity: {
                        tag: '#LINK1',
                        name: 'Metric Linked',
                        discordId: '111111111111111111',
                        discordUsername: 'linked_user'
                    },
                    latestSnapshot: {
                        name: 'Latest Linked'
                    }
                },
                '#ABSNT': {
                    identity: {
                        tag: '#ABSNT',
                        discordId: '222222222222222222',
                        discordUsername: 'absent_user'
                    }
                },
                '#MISS1': {
                    identity: {
                        tag: '#MISS1',
                        discordUsername: 'missing_but_live'
                    }
                }
            }
        },
        [
            {
                tag: '#LINK1',
                name: 'Live Linked',
                clanRank: 1
            },
            {
                tag: '#MISS1',
                name: 'Live Missing',
                clanRank: 2
            },
            {
                tag: '#EXTRA',
                name: 'New Live Member',
                clanRank: 3
            }
        ]
    );

    assert.deepEqual(rows.map(row => row.tag), ['#LINK1', '#MISS1', '#EXTRA']);
    assert.equal(rows.find(row => row.tag === '#ABSNT'), undefined);
    assert.equal(rows.find(row => row.tag === '#LINK1').linked, true);
    assert.equal(rows.find(row => row.tag === '#MISS1').linked, true);
    assert.equal(rows.find(row => row.tag === '#EXTRA').linked, false);
    assert.equal(rows.find(row => row.tag === '#LINK1').inGameName, 'Live Linked');
});

test('sorts linked and unlinked groups by active roster order before live clan rank', () => {
    const model = buildLinkListModel(
        {
            id: 'alpha',
            title: 'Alpha',
            connectedClanTag: '#2Q0YGUP08',
            main: [
                { name: 'Second', tag: '#SECOND' },
                { name: 'First', tag: '#FIRST' }
            ],
            subs: [
                { name: 'Third', tag: '#THIRD' }
            ],
            missing: []
        },
        {
            byTag: {
                '#FIRST': {
                    identity: {
                        discordUsername: 'first_user'
                    }
                },
                '#SECOND': {
                    identity: {
                        discordUsername: 'second_user'
                    }
                },
                '#LIVE1': {
                    identity: {
                        discordUsername: 'live_user'
                    }
                }
            }
        },
        [
            { tag: '#LIVE1', name: 'Live Linked', clanRank: 1 },
            { tag: '#FIRST', name: 'First', clanRank: 50 },
            { tag: '#SECOND', name: 'Second', clanRank: 49 },
            { tag: '#THIRD', name: 'Third', clanRank: 2 },
            { tag: '#LIVE2', name: 'Live Unlinked', clanRank: 3 }
        ]
    );

    assert.deepEqual(model.linked.map(row => row.tag), ['#SEC0ND', '#FIRST', '#LIVE1']);
    assert.deepEqual(model.notLinked.map(row => row.tag), ['#THIRD', '#LIVE2']);
});

test('splits confirmed absent Discord members into a separate linked category', () => {
    const model = buildLinkListModel(
        {
            id: 'alpha',
            title: 'Alpha',
            connectedClanTag: '#2Q0YGUP08',
            main: [
                { name: 'Present', tag: '#AAA1' },
                { name: 'Absent', tag: '#BBB2' },
                { name: 'Username Only', tag: '#CCC3' }
            ],
            subs: [],
            missing: []
        },
        {
            byTag: {
                '#AAA1': {
                    identity: {
                        discordId: '111111111111111111',
                        discordUsername: 'present_user'
                    }
                },
                '#BBB2': {
                    identity: {
                        discordId: '222222222222222222',
                        discordUsername: 'absent_user'
                    }
                },
                '#CCC3': {
                    identity: {
                        discordUsername: 'username_only'
                    }
                }
            }
        },
        [
            { tag: '#AAA1', name: 'Present', clanRank: 1 },
            { tag: '#BBB2', name: 'Absent', clanRank: 2 },
            { tag: '#CCC3', name: 'Username Only', clanRank: 3 },
            { tag: '#DDD4', name: 'No Link', clanRank: 4 }
        ],
        {
            discordPresenceById: {
                '111111111111111111': true,
                '222222222222222222': false
            }
        }
    );

    assert.deepEqual(model.linked.map(row => row.tag), ['#AAA1', '#CCC3']);
    assert.deepEqual(model.linkedNotInServer.map(row => row.tag), ['#BBB2']);
    assert.deepEqual(model.notLinked.map(row => row.tag), ['#DDD4']);
});
