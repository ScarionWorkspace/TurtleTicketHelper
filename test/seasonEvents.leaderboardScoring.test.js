const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
            'Legends I - 5200 trophies',
            'Legends II - 6000 trophies',
            'Titan 27 - 6100 trophies'
        ]
    );
    assert.deepEqual(
        rows.map(row => row.rank),
        [1, 2, 3]
    );
    assert.equal(rows[0].metric, 'leagueTrophies');
    assert.equal(rows[0].score, 5200);
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
