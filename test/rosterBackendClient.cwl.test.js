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

function makeTextResponse(text, contentType = 'text/plain') {
    return {
        ok: true,
        status: 200,
        headers: {
            get: () => contentType
        },
        text: async () => text
    };
}

function makeErrorResponse(status, text, contentType = 'text/html; charset=utf-8') {
    return {
        ok: false,
        status,
        headers: {
            get: () => contentType
        },
        text: async () => text
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

test('backend client reports HTML responses without exposing raw markup', async () => {
    const client = loadClient();

    global.fetch = async () => makeTextResponse(
        '<!doctype html><html><body>Apps Script error page</body></html>',
        'text/html; charset=utf-8'
    );

    await assert.rejects(
        () => client.linkDiscordIdentityForPlayerTag({
            playerTag: '#PYYQQ',
            discordId: '222222222222222222',
            discordUsername: 'bravo'
        }),
        error => {
            assert.equal(error.code, 'INVALID_JSON');
            assert.match(error.message, /HTML response instead of JSON/);
            assert.doesNotMatch(error.message, /<html/i);
            return true;
        }
    );
});

test('season event calls retry a transient Apps Script HTML error', async () => {
    const client = loadClient();
    let attempts = 0;

    global.fetch = async () => {
        attempts += 1;

        if (attempts === 1) {
            return makeErrorResponse(
                403,
                '<!doctype html><html><body>Temporary Apps Script error</body></html>'
            );
        }

        return makeJsonResponse({
            ok: true,
            result: {
                status: 'ok',
                event: { eventId: 'donation-current' }
            }
        });
    };

    const result = await client.getSeasonEventMutationContext({
        eventType: 'donation',
        discordUser: { id: 'user-1' }
    });

    assert.equal(attempts, 2);
    assert.equal(result.status, 'ok');
    assert.equal(result.event.eventId, 'donation-current');
});

test('season event calls identify Apps Script authorization HTML and do not retry it', async () => {
    const client = loadClient();
    let attempts = 0;

    global.fetch = async () => {
        attempts += 1;
        return makeErrorResponse(
            403,
            '<!doctype html><html lang="de"><head><title>Zugriff verweigert</title></head><body>Sie benötigen Zugriff.</body></html>'
        );
    };

    await assert.rejects(
        () => client.getSeasonEventMutationContext({
            eventType: 'donation',
            discordUser: { id: 'user-1' }
        }),
        error => {
            assert.equal(error.code, 'BACKEND_AUTHORIZATION_REQUIRED');
            assert.equal(error.status, 403);
            assert.equal(error.method, 'getSeasonEventMutationContext');
            assert.equal(error.attempts, 1);
            assert.match(error.message, /owner must reauthorize/i);
            assert.doesNotMatch(error.message, /<html/i);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('season event calls do not retry a Worker JSON authorization error', async () => {
    const client = loadClient();
    let attempts = 0;

    global.fetch = async () => {
        attempts += 1;
        return makeErrorResponse(
            503,
            JSON.stringify({
                ok: false,
                code: 'APPS_SCRIPT_AUTHORIZATION_REQUIRED',
                error: 'Apps Script authorization is required.'
            }),
            'application/json; charset=utf-8'
        );
    };

    await assert.rejects(
        () => client.getSeasonEventMutationContext({
            eventType: 'push',
            discordUser: { id: 'user-1' }
        }),
        error => {
            assert.equal(error.code, 'APPS_SCRIPT_AUTHORIZATION_REQUIRED');
            assert.equal(error.status, 503);
            assert.equal(error.method, 'getSeasonEventMutationContext');
            assert.equal(error.attempts, 1);
            return true;
        }
    );
    assert.equal(attempts, 1);
});

test('season event calls expose the method and attempt count after retries are exhausted', async () => {
    const client = loadClient();
    let attempts = 0;

    global.fetch = async () => {
        attempts += 1;
        return makeErrorResponse(
            503,
            '<!doctype html><html><body>Apps Script unavailable</body></html>'
        );
    };

    await assert.rejects(
        () => client.registerSeasonEventSignup({
            eventId: 'donation-current',
            discordUser: { id: 'user-1' },
            playerTags: ['#PLAYER']
        }),
        error => {
            assert.equal(error.code, 'INVALID_JSON');
            assert.equal(error.status, 503);
            assert.equal(error.method, 'registerSeasonEventSignup');
            assert.equal(error.attempts, 2);
            return true;
        }
    );
    assert.equal(attempts, 2);
});
