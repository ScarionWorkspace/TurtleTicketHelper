const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const command = require('../src/commands/seasonEvents/sendCwlEventSignup');
const {
    buildCustomId,
    isSeasonEventCustomId,
    parseCustomId
} = require('../src/features/seasonEvents/constants');
const { buildSignupMessage } = require('../src/features/seasonEvents/renderSignupMessage');

const originalReadActiveRosterPayload = rosterPublicData.readActiveRosterPayload;

afterEach(() => {
    rosterPublicData.readActiveRosterPayload = originalReadActiveRosterPayload;
});

test('CWL event command requires an autocompleted roster selector', () => {
    const json = command.data.toJSON();
    const rosterOption = json.options.find(option => option.name === 'roster');

    assert.ok(rosterOption);
    assert.equal(rosterOption.required, true);
    assert.equal(rosterOption.autocomplete, true);
});

test('CWL event roster autocomplete only returns connected CWL rosters in configured order', async () => {
    let readOptions = null;
    rosterPublicData.readActiveRosterPayload = async options => {
        readOptions = options;
        return ({
            rosterOrder: ['second', 'main', 'regular', 'unconnected'],
            rosters: {
                main: { id: 'main', title: 'Main Roster', trackingMode: 'cwl', connectedClanTag: '#MAIN' },
                second: { id: 'second', title: 'Second Roster', trackingMode: 'cwl', connectedClanTag: '#SECOND' },
                regular: { id: 'regular', title: 'Regular War', trackingMode: 'regularWar', connectedClanTag: '#REGULAR' },
                unconnected: { id: 'unconnected', title: 'No Clan', trackingMode: 'cwl', connectedClanTag: '' }
            }
        });
    };
    let choices = null;
    await command.autocomplete({
        options: { getFocused: () => 'roster' },
        respond: async payload => { choices = payload; }
    });

    assert.deepEqual(choices, [
        { name: 'Second Roster (#SECOND)', value: 'second' },
        { name: 'Main Roster (#MAIN)', value: 'main' }
    ]);
    assert.deepEqual(readOptions, { cacheTtlMs: 15_000, timeoutMs: 2_500 });
});

test('versioned season-event custom IDs retain the exact CWL event within Discord limits', () => {
    const customId = buildCustomId('select', 'cwl', {
        eventId: 'cwl-20260805T1234567-abcdef123456',
        userId: '1234567890123456789',
        messageId: '9876543210987654321',
        mode: 'update'
    });

    assert.equal(isSeasonEventCustomId(customId), true);
    assert.ok(customId.length <= 100);
    assert.deepEqual(parseCustomId(customId), {
        action: 'select',
        type: 'cwl',
        eventId: 'cwl-20260805T1234567-abcdef123456',
        userId: '1234567890123456789',
        messageId: '9876543210987654321',
        mode: 'update',
        parts: ['cwl-20260805T1234567-abcdef123456', '1234567890123456789', '9876543210987654321', 'u'],
        version: 2
    });

    const legacy = parseCustomId(buildCustomId('signup', 'cwl'));
    assert.equal(legacy.eventId, null);
    assert.equal(legacy.type, 'cwl');
});

test('every control on a CWL signup panel stays bound to that panel event', () => {
    const eventId = 'cwl-20260805T1234567-abcdef123456';
    const message = buildSignupMessage('cwl', {
        eventId,
        type: 'cwl',
        title: 'CWL Event — Second Roster',
        status: 'open',
        signupsOpen: true,
        cwlTrackingState: 'active',
        cwl: {
            target: {
                resolved: true,
                status: 'resolved',
                selectionMode: 'explicit',
                rosterId: 'second',
                rosterTitle: 'Second Roster',
                clanTag: '#SECOND',
                eligibleAccountTags: ['#BBB']
            }
        },
        participantsByDiscordId: {}
    }, { leaderboard: [] });
    const controls = message.components[0].toJSON().components;
    const parsed = controls.map(control => parseCustomId(control.custom_id));

    assert.deepEqual(parsed.map(value => value.action), ['refresh', 'signup', 'optout', 'options']);
    assert.equal(parsed.every(value => value.eventId === eventId && value.type === 'cwl'), true);
    assert.equal(controls.every(control => control.custom_id.length <= 100), true);
});
