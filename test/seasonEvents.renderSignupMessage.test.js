const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSignupMessage
} = require('../src/features/seasonEvents/renderSignupMessage');

function getEmbed(message) {
    return message.embeds[0].toJSON();
}

function getConfirmedTable(message) {
    const embed = getEmbed(message);
    const confirmedField = embed.fields.find(field => field.name.startsWith('Confirmed'));

    return confirmedField.value;
}

function getField(embed, name) {
    return embed.fields.find(field => field.name === name);
}

test('donation signup table omits TH and donation unit text', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true
        },
        {
            leaderboard: [{
                rank: 1,
                scoreLabel: '200 donations',
                name: 'Donor'
            }]
        }
    ));

    assert.match(table, /#  Donos Player/);
    assert.match(table, /1  200\s+Donor/);
    assert.doesNotMatch(table, /\bTH\b/);
    assert.doesNotMatch(table, /\bdonations?\b/i);
});

test('donation signup table compacts donations at 100k', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true
        },
        {
            leaderboard: [{
                rank: 1,
                score: 123456,
                name: 'Big Donor'
            }, {
                rank: 2,
                score: 100000,
                name: 'Threshold Donor'
            }, {
                rank: 3,
                score: 99999,
                name: 'Almost Donor'
            }]
        }
    ));

    assert.match(table, /1  123k\s+Big Donor/);
    assert.match(table, /2  100k\s+Threshold Donor/);
    assert.match(table, /3  99,999\s+Almost Donor/);
    assert.doesNotMatch(table, /123,456|100,000/);
});

test('donation signup table sorts ranked rows with first place at the top', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true,
            participants: [{
                status: 'signed_up',
                accounts: [{
                    tag: '#LOW1',
                    name: 'Low Donor'
                }]
            }, {
                status: 'signed_up',
                accounts: [{
                    tag: '#HIGH1',
                    name: 'High Donor'
                }]
            }]
        },
        {
            leaderboard: [{
                rank: 2,
                accounts: [{
                    tag: '#LOW1',
                    name: 'Low Donor',
                    score: 100
                }]
            }, {
                rank: 1,
                accounts: [{
                    tag: '#HIGH1',
                    name: 'High Donor',
                    score: 300
                }]
            }]
        }
    ));

    assert.match(table, /1  300\s+High Donor/);
    assert.match(table, /2  100\s+Low Donor/);
    assert(table.indexOf('1  300') < table.indexOf('2  100'));
});

test('donation signup table splits backend participant totals by account value', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true,
            participantsByDiscordId: {
                donor: {
                    discordId: 'donor',
                    discordUsername: 'Top Donor',
                    status: 'signed_up',
                    accounts: [{
                        tag: '#MAIN1',
                        name: 'Main Donor'
                    }, {
                        tag: '#ALT22',
                        name: 'Alt Donor'
                    }]
                }
            }
        },
        {
            leaderboard: [{
                rank: 1,
                score: 146000,
                displayName: 'Top Donor',
                accounts: [{
                    tag: '#MAIN1',
                    name: 'Main Donor',
                    currentValue: 126000
                }, {
                    tag: '#ALT22',
                    name: 'Alt Donor',
                    currentValue: 20000
                }]
            }]
        }
    ));

    assert.match(table, /1  126k\s+Main Donor/);
    assert.match(table, /1  20,000\s+Alt Donor/);
    assert.doesNotMatch(table, /146k\s+Main Donor/);
    assert.doesNotMatch(table, /146k\s+Alt Donor/);
});

test('donation signup table uses one Discord total when account values are unavailable', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true,
            participantsByDiscordId: {
                donor: {
                    discordId: 'donor',
                    discordUsername: 'Top Donor',
                    status: 'signed_up',
                    accounts: [{
                        tag: '#MAIN1',
                        name: 'Main Donor'
                    }, {
                        tag: '#ALT22',
                        name: 'Alt Donor'
                    }]
                }
            }
        },
        {
            leaderboard: [{
                rank: 1,
                score: 146000,
                displayName: 'Top Donor',
                accounts: [{
                    tag: '#MAIN1',
                    name: 'Main Donor'
                }, {
                    tag: '#ALT22',
                    name: 'Alt Donor'
                }]
            }]
        }
    ));

    assert.match(table, /1  146k\s+Top Donor/);
    assert.doesNotMatch(table, /Main Donor/);
    assert.doesNotMatch(table, /Alt Donor/);
});

test('donation signup table falls back to donation count when rank is missing', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true
        },
        {
            leaderboard: [{
                scoreLabel: '50 donations',
                name: 'Low Donor'
            }, {
                scoreLabel: '500 donations',
                name: 'High Donor'
            }]
        }
    ));

    assert.match(table, /1  500\s+High Donor/);
    assert.match(table, /2  50\s+Low Donor/);
    assert(table.indexOf('1  500') < table.indexOf('2  50'));
});

test('push signup table uses emoji columns and compact league labels', () => {
    const table = getConfirmedTable(buildSignupMessage(
        'push',
        {
            eventId: 'push-2026-05',
            type: 'push',
            title: 'Push Event',
            status: 'open',
            signupsOpen: true
        },
        {
            leaderboard: [{
                rank: 1,
                currentLeagueName: 'Titan 27',
                currentTrophies: 6100,
                displayName: 'Discord Nick',
                accounts: [{
                    tag: '#PUSH1',
                    name: 'Pusher'
                }]
            }]
        }
    ));

    assert.match(table, /#  🏆  🥇\s+Player/);
    assert.match(table, /1  T27\s+6,100\s+Pusher/);
    assert.doesNotMatch(table, /Discord Nick/);
    assert.doesNotMatch(table, /\bTH\b/);
    assert.doesNotMatch(table, /\bTitan\b/);
    assert.doesNotMatch(table, /\btrophies\b/i);
});

test('signup embed hides roster identity and promotes event timestamps', () => {
    const embed = getEmbed(buildSignupMessage(
        'push',
        {
            eventId: 'roster-push-2026-05',
            type: 'push',
            title: 'Push Event',
            status: 'open',
            signupsOpen: true,
            clanName: 'Roster Clan',
            clanTag: '#ABC123',
            seasonId: 'roster-season-id',
            startsAt: '2026-05-01T00:00:00.000Z',
            endsAt: '2026-05-31T23:59:59.000Z'
        },
        { leaderboard: [] }
    ));
    const windowField = getField(embed, 'Event Window');

    assert.equal(embed.author.name, 'Current Push Event');
    assert.doesNotMatch(embed.author.name, /Roster|#ABC123|season-id/i);
    assert.match(windowField.value, /\*\*Start:\*\* <t:\d+:f> \(<t:\d+:R>\)/);
    assert.match(windowField.value, /\*\*End:\*\* <t:\d+:f> \(<t:\d+:R>\)/);
    assert.doesNotMatch(embed.footer.text, /May|2026|<t:/);
});

test('signup embed uses editable event description before default info text', () => {
    const embed = getEmbed(buildSignupMessage(
        'push',
        {
            eventId: 'push-2026-05',
            type: 'push',
            title: 'Push Event',
            status: 'open',
            signupsOpen: true,
            description: 'Custom push rules.\nBe in a clan at the end.'
        },
        { leaderboard: [] }
    ));
    const infoField = getField(embed, 'Event Info');

    assert.equal(infoField.value, 'Custom push rules.\nBe in a clan at the end.');
});

test('donation signup default info is less strict about leaving', () => {
    const embed = getEmbed(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true
        },
        { leaderboard: [] }
    ));
    const infoField = getField(embed, 'Event Info');

    assert.match(infoField.value, /Leaving a clan before the event ends does not disqualify/i);
    assert.match(embed.footer.text, /Multi-account ranks can repeat/);
});

test('signup embed uses backend summary counts when participants are omitted', () => {
    const embed = getEmbed(buildSignupMessage(
        'donation',
        {
            eventId: 'donation-2026-05',
            type: 'donation',
            title: 'Donation Event',
            status: 'open',
            signupsOpen: true,
            activeParticipantCount: 12,
            participantCount: 20,
            accountCount: 18
        },
        {
            leaderboard: [{
                rank: 1,
                score: 300,
                displayName: 'Donor',
                accounts: [{
                    tag: '#DONOR',
                    name: 'Donor',
                    score: 300
                }]
            }]
        }
    ));
    const confirmedField = embed.fields.find(field => field.name.startsWith('Confirmed'));

    assert.equal(confirmedField.name, 'Confirmed Signups - 12');
    assert.match(embed.footer.text, /Confirmed 12\/50 \| Accounts selected 18/);
});
