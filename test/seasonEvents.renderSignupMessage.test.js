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
                name: 'Pusher'
            }]
        }
    ));

    assert.match(table, /#  🏆  🥇\s+Player/);
    assert.match(table, /1  T27\s+6,100\s+Pusher/);
    assert.doesNotMatch(table, /\bTH\b/);
    assert.doesNotMatch(table, /\bTitan\b/);
    assert.doesNotMatch(table, /\btrophies\b/i);
});
