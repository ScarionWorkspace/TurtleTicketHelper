const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const {
    buildCwlLeagueSignupMessagePayload,
    buildCwlLeagueCustomId,
    parseCwlLeagueCustomId,
    handleCwlLeagueSignupInteraction,
    resolveCwlLeagueEmoji
} = require('../src/features/cwlLeagueSignups/cwlLeagueSignupFlow');

const originalBackend = {
    setCwlLeaguePreference: rosterBackend.setCwlLeaguePreference,
    getCwlLeaguePreferencesForDiscordUser: rosterBackend.getCwlLeaguePreferencesForDiscordUser,
    clearCwlLeaguePreference: rosterBackend.clearCwlLeaguePreference,
    resetCwlLeaguePreferences: rosterBackend.resetCwlLeaguePreferences
};
const originalPublicData = {
    readLinkedAccountsForDiscordUser: rosterPublicData.readLinkedAccountsForDiscordUser,
    readCwlLeagueSignups: rosterPublicData.readCwlLeagueSignups
};

function makeLeagueOption(index) {
    return {
        optionKey: `league-${index}`,
        leagueKey: `league-${index}`,
        leagueName: `League ${index}`,
        clanNames: [`Clan ${index}`]
    };
}

function makePreference(overrides = {}) {
    return {
        discordId: 'user-1',
        playerTag: '#MAIN1',
        playerName: 'Main',
        leagueKey: 'league-1',
        leagueName: 'League 1',
        ...overrides
    };
}

function makeLinkedAccount(overrides = {}) {
    return {
        playerTag: '#MAIN1',
        tag: '#MAIN1',
        name: 'Main',
        townHallLevel: 16,
        ...overrides
    };
}

function makeInteraction({
    customId,
    componentType = 'button',
    values = [],
    user = {
        id: 'user-1',
        username: 'alice',
        globalName: 'Alice'
    }
} = {}) {
    return {
        customId,
        values,
        user,
        member: {
            displayName: 'Alice Nick'
        },
        message: {
            id: 'source-message-1'
        },
        channelId: 'channel-1',
        guildId: 'guild-1',
        deferred: false,
        replied: false,
        calls: [],
        isButton() {
            return componentType === 'button';
        },
        isStringSelectMenu() {
            return componentType === 'select';
        },
        async deferReply(payload) {
            this.deferred = true;
            this.deferReplyPayload = payload;
            this.calls.push(['deferReply', payload]);
        },
        async deferUpdate() {
            this.deferred = true;
            this.deferUpdateCalled = true;
            this.calls.push(['deferUpdate']);
        },
        async reply(payload) {
            this.replied = true;
            this.replyPayload = payload;
            this.calls.push(['reply', payload]);
        },
        async editReply(payload) {
            this.editReplyPayload = payload;
            this.calls.push(['editReply', payload]);
        },
        async update(payload) {
            this.updatePayload = payload;
            this.calls.push(['update', payload]);
        }
    };
}

afterEach(() => {
    Object.assign(rosterBackend, originalBackend);
    Object.assign(rosterPublicData, originalPublicData);
});

test('CWL signup message reserves a utility row and keeps league buttons within Discord limits', () => {
    const payload = buildCwlLeagueSignupMessagePayload(
        Array.from({ length: 25 }, (_, index) => makeLeagueOption(index + 1)),
        'signup-1',
        0,
        2
    );
    const rows = payload.components.map(row => row.toJSON());
    const leagueButtons = rows.slice(0, 4).flatMap(row => row.components);
    const utilityButtons = rows[4].components;

    assert.equal(rows.length, 5);
    assert(rows.every(row => row.components.length <= 5));
    assert.equal(leagueButtons.length, 20);
    assert.equal(leagueButtons[0].custom_id, 'cwl:v1:choose:signup-1:league-1');
    assert.equal(leagueButtons.at(-1).custom_id, 'cwl:v1:choose:signup-1:league-20');
    assert.deepEqual(
        utilityButtons.map(button => button.label),
        ['My votes', 'Clear vote']
    );
    assert.deepEqual(
        utilityButtons.map(button => button.custom_id),
        ['cwl:v1:my_votes:signup-1', 'cwl:v1:clear_vote:signup-1']
    );

    const customId = buildCwlLeagueCustomId('clear_vote_select', 'signup:with-colon', 'user-1', 0);
    assert.equal(customId, 'cwl:v1:clear_vote_select:signup%3Awith-colon:user-1:0');
    assert.deepEqual(parseCwlLeagueCustomId(customId), {
        action: 'clear_vote_select',
        parts: ['signup:with-colon', 'user-1', '0']
    });
});

test('CWL signup message renders same-league clan options as distinct emoji buttons', () => {
    const payload = buildCwlLeagueSignupMessagePayload([
        {
            optionKey: 'turtle-main',
            leagueKey: 'champion-i',
            leagueName: 'Champion I',
            targetRosterId: 'main',
            targetClanName: 'Turtle Main',
            clanNames: ['Turtle Main']
        },
        {
            optionKey: 'turtle-second',
            leagueKey: 'champion-i',
            leagueName: 'Champion I',
            targetRosterId: 'second',
            targetClanName: 'Turtle Second',
            clanNames: ['Turtle Second']
        }
    ], 'signup-1');
    const rows = payload.components.map(row => row.toJSON());
    const buttons = rows[0].components;
    const infoText = payload.embeds[0].toJSON().fields[0].value;

    assert.equal(resolveCwlLeagueEmoji('Champion League I').id, '1516058496632754287');
    assert.deepEqual(
        buttons.map(button => ({
            customId: button.custom_id,
            label: button.label,
            emojiName: button.emoji?.name,
            emojiId: button.emoji?.id
        })),
        [
            {
                customId: 'cwl:v1:choose:signup-1:turtle-main',
                label: 'Turtle Main',
                emojiName: 'WarChampionI',
                emojiId: '1516058496632754287'
            },
            {
                customId: 'cwl:v1:choose:signup-1:turtle-second',
                label: 'Turtle Second',
                emojiName: 'WarChampionI',
                emojiId: '1516058496632754287'
            }
        ]
    );
    assert.doesNotMatch(buttons[0].label, /<:/);
    assert.match(infoText, /<:WarChampionI:1516058496632754287> Champion I - Turtle Main/);
    assert.match(infoText, /<:WarChampionI:1516058496632754287> Champion I - Turtle Second/);
});

test('My votes replies ephemerally with only the clicking user preferences', async () => {
    const backendPayloads = [];
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async payload => {
        backendPayloads.push(payload);
        return {
            preferences: [
                makePreference(),
                makePreference({
                    discordId: 'other-user',
                    playerTag: '#OTHER',
                    playerName: 'Other',
                    leagueName: 'League Other'
                })
            ]
        };
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('my_votes', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.equal(backendPayloads.length, 1);
    assert.equal(backendPayloads[0].signupId, 'signup-1');
    assert.equal(backendPayloads[0].discordId, 'user-1');
    assert.match(interaction.editReplyPayload.content, /Main/);
    assert.match(interaction.editReplyPayload.content, /League 1/);
    assert.doesNotMatch(interaction.editReplyPayload.content, /Other/);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote clears one saved preference directly for the clicking user', async () => {
    let clearPayload = null;
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({
        preferences: [makePreference()]
    });
    rosterBackend.clearCwlLeaguePreference = async payload => {
        clearPayload = payload;
        return { cleared: true };
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.equal(clearPayload.signupId, 'signup-1');
    assert.equal(clearPayload.discordId, 'user-1');
    assert.equal(clearPayload.playerTag, '#MAIN1');
    assert.equal(clearPayload.source, 'discord-user-clear');
    assert.match(interaction.editReplyPayload.content, /Main/);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote shows a select menu for multiple saved preferences and clears the selected one', async () => {
    const preferences = [
        makePreference(),
        makePreference({
            playerTag: '#ALT22',
            playerName: 'Alt',
            leagueName: 'League 2'
        })
    ];
    const clearPayloads = [];
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({ preferences });
    rosterBackend.clearCwlLeaguePreference = async payload => {
        clearPayloads.push(payload);
        return { cleared: true };
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const buttonInteraction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(buttonInteraction), true);
    assert.deepEqual(buttonInteraction.deferReplyPayload, { flags: 64 });

    const rows = buttonInteraction.editReplyPayload.components.map(row => row.toJSON());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].components.length, 1);
    const select = rows[0].components[0];
    assert.equal(select.custom_id, 'cwl:v1:clear_vote_select:signup-1:user-1:0');
    assert.deepEqual(
        select.options.map(option => option.value),
        ['#MAIN1', '#ALT22']
    );

    const selectInteraction = makeInteraction({
        componentType: 'select',
        customId: select.custom_id,
        values: ['#ALT22']
    });

    assert.equal(await handleCwlLeagueSignupInteraction(selectInteraction), true);
    assert.equal(selectInteraction.deferUpdateCalled, true);
    assert.equal(clearPayloads.length, 1);
    assert.equal(clearPayloads[0].playerTag, '#ALT22');
    assert.equal(clearPayloads[0].discordId, 'user-1');
    assert.match(selectInteraction.editReplyPayload.content, /Alt/);
    assert.deepEqual(selectInteraction.editReplyPayload.components, []);
});

test('Clear vote reports the no-vote state without calling clear or reset', async () => {
    let clearCalled = false;
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({ preferences: [] });
    rosterBackend.clearCwlLeaguePreference = async () => {
        clearCalled = true;
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.equal(clearCalled, false);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.match(interaction.editReplyPayload.content, /do not have any saved CWL league preferences/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('CWL utility actions report stale signup state ephemerally', async () => {
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => {
        const error = new Error('CWL signup is no longer active');
        error.code = 'CWL_SIGNUP_NOT_ACTIVE';
        throw error;
    };

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('my_votes', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.match(interaction.editReplyPayload.content, /no longer active/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote handles backend clear errors without resetting all preferences', async () => {
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({
        preferences: [makePreference()]
    });
    rosterBackend.clearCwlLeaguePreference = async () => {
        throw new Error('backend unavailable');
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.match(interaction.editReplyPayload.content, /Unable to clear/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote treats backend not-found as neutral instead of success', async () => {
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({
        preferences: [makePreference()]
    });
    rosterBackend.clearCwlLeaguePreference = async () => ({
        ok: true,
        status: 'not-found',
        cleared: false
    });
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.match(interaction.editReplyPayload.content, /did not have a saved CWL league preference/i);
    assert.doesNotMatch(interaction.editReplyPayload.content, /no longer has/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote does not claim success when backend reports not-owner', async () => {
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({
        preferences: [makePreference()]
    });
    rosterBackend.clearCwlLeaguePreference = async () => ({
        ok: true,
        status: 'not-owner',
        cleared: false
    });
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.match(interaction.editReplyPayload.content, /belongs to another Discord user/i);
    assert.doesNotMatch(interaction.editReplyPayload.content, /no longer has/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Clear vote reports unknown backend clear results as errors', async () => {
    rosterBackend.getCwlLeaguePreferencesForDiscordUser = async () => ({
        preferences: [makePreference()]
    });
    rosterBackend.clearCwlLeaguePreference = async () => ({
        ok: true,
        status: 'unexpected-noop',
        cleared: false
    });
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('clear_vote', 'signup-1')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.match(interaction.editReplyPayload.content, /did not confirm the clear/i);
    assert.doesNotMatch(interaction.editReplyPayload.content, /no longer has/i);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Choosing a clan option saves the option key while keeping the league key', async () => {
    const signups = {
        signupId: 'signup-1',
        optionsByKey: {
            'turtle-second': {
                optionKey: 'turtle-second',
                leagueKey: 'champion-i',
                leagueName: 'Champion I',
                targetRosterId: 'second',
                targetClanName: 'Turtle Second'
            }
        },
        preferencesByTag: {}
    };
    let setPayload = null;
    rosterPublicData.readLinkedAccountsForDiscordUser = async () => [makeLinkedAccount()];
    rosterPublicData.readCwlLeagueSignups = async () => signups;
    rosterBackend.setCwlLeaguePreference = async payload => {
        setPayload = payload;
        return {
            ok: true,
            status: 'created',
            preference: {
                playerTag: '#MAIN1',
                playerName: 'Main',
                optionKey: 'turtle-second',
                leagueKey: 'champion-i',
                leagueName: 'Champion I',
                targetRosterId: 'second',
                targetClanName: 'Turtle Second'
            }
        };
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('choose', 'signup-1', 'turtle-second')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.equal(setPayload.signupId, 'signup-1');
    assert.equal(setPayload.playerTag, '#MAIN1');
    assert.equal(setPayload.optionKey, 'turtle-second');
    assert.equal(setPayload.leagueKey, 'champion-i');
    assert.match(interaction.editReplyPayload.content, /Champion I - Turtle Second/);
    assert.deepEqual(interaction.editReplyPayload.components, []);
});

test('Choosing a new league for an owned existing preference asks for change confirmation', async () => {
    rosterPublicData.readLinkedAccountsForDiscordUser = async () => [makeLinkedAccount()];
    rosterPublicData.readCwlLeagueSignups = async () => ({
        signupId: 'signup-1',
        optionsByLeagueKey: {
            'league-2': makeLeagueOption(2)
        },
        preferencesByTag: {
            '#MAIN1': makePreference()
        }
    });
    rosterBackend.setCwlLeaguePreference = async () => assert.fail('change must wait for confirmation');
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('choose', 'signup-1', 'league-2')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.deepEqual(interaction.deferReplyPayload, { flags: 64 });
    assert.match(interaction.editReplyPayload.content, /League 1 -> League 2/);
    const rows = interaction.editReplyPayload.components.map(row => row.toJSON());
    assert.equal(rows.length, 1);
    assert.equal(rows[0].components[0].custom_id.startsWith('cwl:v1:chg:signup-1:league-2:%23MAIN1:'), true);
    assert.equal(rows[0].components[0].label, 'Confirm change');
    assert.equal(rows[0].components[1].custom_id, 'cwl:v1:chg_cancel');
});

test('Confirming an owned preference change sends allowChange and reports old to new', async () => {
    const signups = {
        signupId: 'signup-1',
        optionsByLeagueKey: {
            'league-2': makeLeagueOption(2)
        },
        preferencesByTag: {
            '#MAIN1': makePreference()
        }
    };
    let setPayload = null;
    rosterPublicData.readLinkedAccountsForDiscordUser = async () => [makeLinkedAccount()];
    rosterPublicData.readCwlLeagueSignups = async () => signups;
    rosterBackend.setCwlLeaguePreference = async payload => {
        setPayload = payload;
        return {
            ok: true,
            status: 'changed',
            changed: true,
            previousPreference: makePreference(),
            preference: makePreference({
                leagueKey: 'league-2',
                leagueName: 'League 2'
            })
        };
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const chooseInteraction = makeInteraction({
        customId: buildCwlLeagueCustomId('choose', 'signup-1', 'league-2')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(chooseInteraction), true);
    const confirmCustomId = chooseInteraction.editReplyPayload.components[0].toJSON().components[0].custom_id;
    const confirmInteraction = makeInteraction({
        customId: confirmCustomId
    });

    assert.equal(await handleCwlLeagueSignupInteraction(confirmInteraction), true);
    assert.equal(confirmInteraction.deferUpdateCalled, true);
    assert.equal(setPayload.signupId, 'signup-1');
    assert.equal(setPayload.playerTag, '#MAIN1');
    assert.equal(setPayload.leagueKey, 'league-2');
    assert.equal(setPayload.discordId, 'user-1');
    assert.equal(setPayload.allowChange, true);
    assert.match(confirmInteraction.editReplyPayload.content, /League 1 -> League 2/);
    assert.deepEqual(confirmInteraction.editReplyPayload.components, []);
});

test('Choosing a new league cannot change a preference owned by another user', async () => {
    let setCalled = false;
    rosterPublicData.readLinkedAccountsForDiscordUser = async () => [makeLinkedAccount()];
    rosterPublicData.readCwlLeagueSignups = async () => ({
        signupId: 'signup-1',
        optionsByLeagueKey: {
            'league-2': makeLeagueOption(2)
        },
        preferencesByTag: {
            '#MAIN1': makePreference({ discordId: 'other-user' })
        }
    });
    rosterBackend.setCwlLeaguePreference = async () => {
        setCalled = true;
    };
    rosterBackend.resetCwlLeaguePreferences = async () => assert.fail('user vote actions must not reset all preferences');

    const interaction = makeInteraction({
        customId: buildCwlLeagueCustomId('choose', 'signup-1', 'league-2')
    });

    assert.equal(await handleCwlLeagueSignupInteraction(interaction), true);
    assert.equal(setCalled, false);
    assert.match(interaction.editReplyPayload.content, /No linked accounts are available/i);
});
