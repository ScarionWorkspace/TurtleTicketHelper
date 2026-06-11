const test = require('node:test');
const assert = require('node:assert/strict');
const {
    isValidClashTag,
    mapClanMembers,
    normalizeClashTag
} = require('../src/features/clashApi/fetchClanMembers');

test('normalizes and validates Clash tags for clan member requests', () => {
    assert.equal(normalizeClashTag(' 2qoygup08 '), '#2Q0YGUP08');
    assert.equal(isValidClashTag('#2Q0YGUP08'), true);
    assert.equal(isValidClashTag('not a clan tag'), false);
});

test('maps live clan members with normalized unique tags and API order', () => {
    const members = mapClanMembers([
        {
            tag: 'abc123',
            name: 'Alpha',
            clanRank: 2
        },
        {
            tag: '#ABC123',
            name: 'Duplicate',
            clanRank: 3
        },
        {
            tag: '#def456',
            name: 'Delta',
            clanRank: 1
        }
    ]);

    assert.deepEqual(members.map(member => member.tag), ['#ABC123', '#DEF456']);
    assert.equal(members[0].name, 'Alpha');
    assert.equal(members[0].clanRank, 2);
    assert.equal(members[1].apiOrder, 2);
});
