const { afterEach, test } = require('node:test');
const assert = require('node:assert/strict');

const CLIENT_MODULE_PATH = '../src/features/rosterBackend/rosterBackendClient';
const ENV_MODULE_PATH = '../src/config/env';
const ENV_KEYS = [
    'TURTLE_HELPER_SKIP_DOTENV',
    'ROSTER_BACKEND_URL',
    'ROSTER_BOT_SECRET'
];
const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = global.fetch;

function restoreEnv() {
    for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalEnv[key];
        }
    }
}

function clearClientModules() {
    delete require.cache[require.resolve(CLIENT_MODULE_PATH)];
    delete require.cache[require.resolve(ENV_MODULE_PATH)];
}

function loadClient() {
    clearClientModules();
    process.env.TURTLE_HELPER_SKIP_DOTENV = '1';
    process.env.ROSTER_BACKEND_URL = 'https://backend.example/api';
    process.env.ROSTER_BOT_SECRET = 'secret';

    return require(CLIENT_MODULE_PATH);
}

function makeJsonResponse(value) {
    return {
        ok: true,
        status: 200,
        headers: {
            get: () => 'application/json'
        },
        text: async () => JSON.stringify(value)
    };
}

afterEach(() => {
    global.fetch = originalFetch;
    clearClientModules();
    restoreEnv();
});

test('CWL user preference backend wrappers call user-scoped methods', async () => {
    const bodies = [];
    const client = loadClient();

    global.fetch = async (url, init) => {
        assert.equal(url, 'https://backend.example/api');
        bodies.push(JSON.parse(init.body));
        return makeJsonResponse({
            ok: true,
            result: {
                ok: true
            }
        });
    };

    assert.deepEqual(
        await client.getCwlLeaguePreferencesForDiscordUser({ signupId: 'signup-1', discordId: 'user-1' }),
        { ok: true }
    );
    assert.deepEqual(
        await client.clearCwlLeaguePreference({ signupId: 'signup-1', discordId: 'user-1', playerTag: '#MAIN1' }),
        { ok: true }
    );

    assert.deepEqual(
        bodies.map(body => body.method),
        ['getCwlLeaguePreferencesForDiscordUser', 'clearCwlLeaguePreference']
    );
    assert.deepEqual(
        bodies.map(body => body.methodName),
        ['getCwlLeaguePreferencesForDiscordUser', 'clearCwlLeaguePreference']
    );
    assert.deepEqual(bodies[0].args, [
        {
            signupId: 'signup-1',
            discordId: 'user-1'
        },
        'secret'
    ]);
    assert.deepEqual(bodies[1].args, [
        {
            signupId: 'signup-1',
            discordId: 'user-1',
            playerTag: '#MAIN1'
        },
        'secret'
    ]);
    assert(!bodies.some(body => body.method === 'resetCwlLeaguePreferences'));
});
