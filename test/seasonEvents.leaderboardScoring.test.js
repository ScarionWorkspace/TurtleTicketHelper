const test = require('node:test');
const assert = require('node:assert/strict');
const {
    getLeagueTierLabel,
    buildLocalSeasonEventLeaderboard
} = require('../src/features/seasonEvents/leaderboardScoring');

const BASE_EVENT = {
    eventId: 'push-2026-05',
    type: 'push',
    seasonId: '2026-05',
    startsAt: '2026-05-01T00:00:00.000Z',
    endsAt: '2026-05-31T23:59:59.000Z',
    participantsByDiscordId: {}
};

function participant(discordId, tag, status = 'signed_up') {
    return {
        discordId,
        discordUsername: `user-${discordId}`,
        status,
        accounts: [{
            tag,
            name: `Player ${tag}`
        }]
    };
}

function metric(tag, leagueTierId, trophies, capturedAt = '2026-05-10T12:00:00.000Z', leagueName = 'Legend League') {
    return {
        identity: {
            tag,
            name: `Player ${tag}`
        },
        trophyHistoryDaily: [{
            capturedAt,
            leagueTier: {
                id: leagueTierId
            },
            trophies
        }],
        latestSnapshot: {
            capturedAt,
            leagueTier: {
                id: leagueTierId
            },
            league: {
                name: leagueName
            },
            trophies
        }
    };
}

function leaderboard(participantsByDiscordId, metricsByTag) {
    return buildLocalSeasonEventLeaderboard(
        {
            ...BASE_EVENT,
            participantsByDiscordId
        },
        {
            playerMetrics: {
                byTag: metricsByTag
            }
        },
        {
            nowIso: '2026-05-20T00:00:00.000Z'
        }
    ).leaderboard;
}

test('higher leagueTier id rank beats higher trophies across push tiers', () => {
    const rows = leaderboard(
        {
            legendsI: participant('legendsI', '#AAA111'),
            legendsII: participant('legendsII', '#BBB222'),
            titan: participant('titan', '#CCC333')
        },
        {
            '#AAA111': metric('#AAA111', 105000036, 5200),
            '#BBB222': metric('#BBB222', 105000035, 6000),
            '#CCC333': metric('#CCC333', 105000027, 6100)
        }
    );

    assert.deepEqual(
        rows.map(row => row.accounts[0].tag),
        ['#AAA111', '#BBB222', '#CCC333']
    );
    assert.deepEqual(
        rows.map(row => row.scoreLabel),
        [
            'L1 5200',
            'L2 6000',
            'T27 6100'
        ]
    );
    assert.deepEqual(
        rows.map(row => row.rank),
        [1, 2, 3]
    );
    assert.equal(rows[0].metric, 'leagueTrophies');
    assert.equal(rows[0].score, 5200);
});

test('league tier labels use compact in-game abbreviations', () => {
    const rows = leaderboard(
        {
            legendThree: participant('legendThree', '#LEG3'),
            electro: participant('electro', '#ELE33'),
            dragon: participant('dragon', '#DRA30'),
            pekka: participant('pekka', '#PEK24'),
            skeleton: participant('skeleton', '#SKEL3')
        },
        {
            '#LEG3': metric('#LEG3', 105000034, 5000),
            '#ELE33': metric('#ELE33', 105000033, 4900),
            '#DRA30': metric('#DRA30', 105000030, 4800),
            '#PEK24': metric('#PEK24', 105000024, 4700),
            '#SKEL3': metric('#SKEL3', 105000003, 4600)
        }
    );

    assert.deepEqual(
        rows.map(row => row.scoreLabel),
        [
            'L3 5000',
            'E33 4900',
            'D30 4800',
            'P24 4700',
            'S3 4600'
        ]
    );
});

test('all known league tiers have compact labels', () => {
    const expectedLabels = [
        'S1', 'S2', 'S3',
        'B4', 'B5', 'B6',
        'A7', 'A8', 'A9',
        'W10', 'W11', 'W12',
        'V13', 'V14', 'V15',
        'W16', 'W17', 'W18',
        'G19', 'G20', 'G21',
        'P22', 'P23', 'P24',
        'T25', 'T26', 'T27',
        'D28', 'D29', 'D30',
        'E31', 'E32', 'E33',
        'L3', 'L2', 'L1'
    ];

    assert.deepEqual(
        expectedLabels.map((_, index) => getLeagueTierLabel(index + 1)),
        expectedLabels
    );
});

test('players in the same rank tier are ordered by trophies descending', () => {
    const rows = leaderboard(
        {
            high: participant('high', '#HIGH1'),
            low: participant('low', '#LWW22')
        },
        {
            '#HIGH1': metric('#HIGH1', 105000027, 5800),
            '#LWW22': metric('#LWW22', 105000027, 5600)
        }
    );

    assert.equal(rows[0].accounts[0].tag, '#HIGH1');
    assert.equal(rows[0].score, 5800);
    assert.equal(rows[1].accounts[0].tag, '#LWW22');
    assert.equal(rows[1].score, 5600);
});

test('missing metrics or no valid push rank stays below valid ranked rows', () => {
    const rows = leaderboard(
        {
            valid: participant('valid', '#VALID'),
            missing: participant('missing', '#MISS1'),
            unparsed: participant('unparsed', '#UNPRS')
        },
        {
            '#VALID': metric('#VALID', 105000025, 4100),
            '#UNPRS': {
                identity: {
                    tag: '#UNPRS',
                    name: 'Player #UNPRS'
                },
                trophyHistoryDaily: [{
                    capturedAt: '2026-05-10T12:00:00.000Z',
                    league: {
                        name: 'Legend League'
                    },
                    trophies: 6100
                }],
                latestSnapshot: {
                    capturedAt: '2026-05-10T12:00:00.000Z',
                    league: {
                        name: 'Legend League'
                    },
                    trophies: 6100
                }
            }
        }
    );

    assert.equal(rows[0].accounts[0].tag, '#VALID');
    assert.equal(rows[0].hasPushRank, true);
    assert.deepEqual(
        rows.slice(1).map(row => row.hasPushRank),
        [false, false]
    );
    assert(!rows.slice(1).some(row => String(row.scoreLabel).includes('Legend')));
    assert(rows.slice(1).some(row => row.accounts[0].tag === '#MISS1'));
    assert(rows.slice(1).some(row => row.accounts[0].tag === '#UNPRS'));
});

test('cancelled and removed participants remain excluded', () => {
    const rows = leaderboard(
        {
            active: participant('active', '#ACTIV'),
            cancelled: participant('cancelled', '#CANCE', 'cancelled'),
            removed: participant('removed', '#REMOV', 'removed')
        },
        {
            '#ACTIV': metric('#ACTIV', 105000026, 5000),
            '#CANCE': metric('#CANCE', 105000036, 5500),
            '#REMOV': metric('#REMOV', 105000036, 5600)
        }
    );

    assert.equal(rows.length, 1);
    assert.equal(rows[0].accounts[0].tag, '#ACTIV');
});
