const test = require('node:test');
const assert = require('node:assert/strict');
const {
    buildSignupMessage
} = require('../src/features/seasonEvents/renderSignupMessage');

function getConfirmedTable(message) {
    const embed = message.embeds[0].toJSON();
    const confirmedField = embed.fields.find(field => field.name.startsWith('Confirmed'));

    return confirmedField.value;
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
                bestLeagueName: 'Titan 27',
                bestTrophies: 6100,
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
