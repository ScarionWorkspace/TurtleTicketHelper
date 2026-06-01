const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFirebaseObjectKey } = require('../src/features/rosterFirebase/rosterFirebaseReadClient');
const {
    getOrderedRosters,
    formatRosterPlayerLines,
    formatRawRosterPlayerLines,
    chunkLines
} = require('../src/features/rosterPlayers/rosterPlayersData');

test('orders rosters by rosterOrder and appends unlisted rosters', () => {
    const rosters = getOrderedRosters({
        rosterOrder: ['bravo', 'alpha'],
        rosters: {
            alpha: {
                id: 'alpha',
                title: 'Alpha'
            },
            charlie: {
                id: 'charlie',
                title: 'Charlie'
            },
            bravo: {
                id: 'bravo',
                title: 'Bravo'
            }
        }
    });

    assert.deepEqual(rosters.map(roster => roster.id), ['bravo', 'alpha', 'charlie']);
});

test('formats players in main, subs, then missing order with linked Discord IDs', () => {
    const lines = formatRosterPlayerLines(
        {
            id: 'alpha',
            title: 'Alpha',
            main: [{
                name: 'Main One',
                tag: '#MAIN1'
            }],
            subs: [{
                name: 'Sub One',
                playerTag: '#SUB01'
            }],
            missing: [{
                name: 'Missing One',
                tag: '#MISS1'
            }]
        },
        {
            byTag: {
                '#MAIN1': {
                    identity: {
                        discordId: '111111111111111111',
                        name: 'Metric Main'
                    }
                },
                '#SUB01': {
                    identity: {
                        discordId: '222222222222222222'
                    }
                }
            }
        }
    );

    assert.deepEqual(lines, [
        'Main One / <@111111111111111111>',
        'Sub One / <@222222222222222222>',
        'Missing One / no linked Discord ID'
    ]);
});

test('ignores player.discord display cache when canonical Discord ID is missing', () => {
    const lines = formatRosterPlayerLines(
        {
            main: [{
                name: 'Cached Discord Player',
                tag: '#CACHE',
                discord: 'cached_user_name'
            }]
        },
        {
            byTag: {
                '#CACHE': {
                    identity: {
                        discordUsername: 'canonical_user_name'
                    }
                }
            }
        }
    );

    assert.deepEqual(lines, [
        'Cached Discord Player / no linked Discord ID'
    ]);
});

test('formats raw roster output as dash-prefixed plain lines', () => {
    const lines = formatRawRosterPlayerLines(
        {
            main: [{
                name: 'Raw Player',
                tag: '#RAW01'
            }]
        },
        {
            byTag: {
                '#RAW01': {
                    identity: {
                        discordId: '444444444444444444'
                    }
                }
            }
        }
    );

    assert.deepEqual(lines, [
        '- Raw Player / <@444444444444444444>'
    ]);
});

test('decodes Firebase-safe playerMetrics keys before resolving Discord IDs', () => {
    const encodedTag = encodeFirebaseObjectKey('#ABC123');
    const lines = formatRosterPlayerLines(
        {
            main: [{
                name: 'Encoded Player',
                tag: '#ABC123'
            }]
        },
        {
            byTag: {
                [encodedTag]: {
                    identity: {
                        discordId: '333333333333333333'
                    }
                }
            }
        }
    );

    assert.deepEqual(lines, [
        'Encoded Player / <@333333333333333333>'
    ]);
});

test('chunks roster player lines without changing line text', () => {
    const lines = [
        'Alpha / <@111111111111111111>',
        'Bravo / no linked Discord ID',
        'Charlie / <@333333333333333333>'
    ];

    assert.deepEqual(chunkLines(lines, 45), [
        'Alpha / <@111111111111111111>',
        'Bravo / no linked Discord ID',
        'Charlie / <@333333333333333333>'
    ]);
});
