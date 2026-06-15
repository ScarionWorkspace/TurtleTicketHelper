const assert = require('node:assert/strict');
const { setTimeout: sleep } = require('node:timers/promises');
const { afterEach, test } = require('node:test');

const CLIENT_MODULE_PATH = '../src/features/rosterFirebase/rosterFirebaseReadClient';
const ENV_MODULE_PATH = '../src/config/env';
const ENV_KEYS = [
    'TURTLE_HELPER_SKIP_DOTENV',
    'ROSTER_FIREBASE_DB_URL',
    'ROSTER_FIREBASE_READ_CACHE_TTL_MS'
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

function loadClient(env = {}) {
    clearClientModules();
    process.env.TURTLE_HELPER_SKIP_DOTENV = '1';
    process.env.ROSTER_FIREBASE_DB_URL = 'https://example.firebaseio.com';
    process.env.ROSTER_FIREBASE_READ_CACHE_TTL_MS = '60000';

    for (const [key, value] of Object.entries(env)) {
        process.env[key] = value;
    }

    return require(CLIENT_MODULE_PATH);
}

function makeJsonResponse(value, ok = true) {
    return {
        ok,
        text: async () => JSON.stringify(value)
    };
}

afterEach(() => {
    global.fetch = originalFetch;
    clearClientModules();
    restoreEnv();
});

test('readJsonPath caches successful JSON reads by normalized Firebase path', async () => {
    const requestedUrls = [];
    const client = loadClient();

    global.fetch = async url => {
        requestedUrls.push(url);
        return makeJsonResponse({
            roster: {
                name: 'Alpha'
            }
        });
    };

    const first = await client.readJsonPath('/active.json');
    first.roster.name = 'Mutated';
    const second = await client.readJsonPath('active');

    assert.equal(requestedUrls.length, 1);
    assert.equal(requestedUrls[0], 'https://example.firebaseio.com/active.json');
    assert.deepEqual(second, {
        roster: {
            name: 'Alpha'
        }
    });
});

test('readJsonPath refreshes the cached value after the TTL expires', async () => {
    let requestCount = 0;
    const client = loadClient({
        ROSTER_FIREBASE_READ_CACHE_TTL_MS: '5'
    });

    global.fetch = async () => {
        requestCount += 1;
        return makeJsonResponse({
            requestCount
        });
    };

    assert.deepEqual(await client.readJsonPath('active'), { requestCount: 1 });
    await sleep(20);
    assert.deepEqual(await client.readJsonPath('active'), { requestCount: 2 });
    assert.equal(requestCount, 2);
});

test('readJsonPath does not cache failed reads', async () => {
    let requestCount = 0;
    const client = loadClient();

    global.fetch = async () => {
        requestCount += 1;

        if (requestCount === 1) {
            return makeJsonResponse(null, false);
        }

        return makeJsonResponse({
            okAfterRetry: true
        });
    };

    assert.equal(await client.readJsonPath('active'), null);
    assert.deepEqual(await client.readJsonPath('active'), { okAfterRetry: true });
    assert.equal(requestCount, 2);
});

test('readJsonPath de-duplicates concurrent reads for the same normalized path', async () => {
    let requestCount = 0;
    let releaseFetch;
    const fetchGate = new Promise(resolve => {
        releaseFetch = resolve;
    });
    const client = loadClient();

    global.fetch = async () => {
        requestCount += 1;
        await fetchGate;
        return makeJsonResponse({
            shared: true
        });
    };

    const firstRead = client.readJsonPath('/active');
    const secondRead = client.readJsonPath('active.json');

    assert.equal(requestCount, 1);
    releaseFetch();

    assert.deepEqual(await firstRead, { shared: true });
    assert.deepEqual(await secondRead, { shared: true });
    assert.equal(requestCount, 1);
});

test('readLinkedAccountsForDiscordUser prefers Discord ID over username collisions', async () => {
    const client = loadClient();

    global.fetch = async () => makeJsonResponse({
        '#2LUCULP': {
            identity: {
                tag: '#2LUCULP',
                name: 'Alpha',
                discordId: '111',
                discordUsername: 'shared'
            }
        },
        '#9PYLQG': {
            identity: {
                tag: '#9PYLQG',
                name: 'Bravo',
                discordId: '222',
                discordUsername: 'shared'
            }
        },
        '#8CCVV': {
            identity: {
                tag: '#8CCVV',
                name: 'Legacy',
                discordUsername: 'shared'
            }
        }
    });

    const accounts = await client.readLinkedAccountsForDiscordUser({
        id: '222',
        username: 'shared'
    });

    assert.deepEqual(accounts.map(account => [account.tag, account.matchType]), [
        ['#9PYLQG', 'discordId']
    ]);
});

test('readLinkedAccountsForDiscordUser falls back only to legacy username-only identities', async () => {
    const client = loadClient();

    global.fetch = async () => makeJsonResponse({
        '#2LUCULP': {
            identity: {
                tag: '#2LUCULP',
                name: 'Alpha',
                discordId: '111',
                discordUsername: 'legacy'
            }
        },
        '#8CCVV': {
            identity: {
                tag: '#8CCVV',
                name: 'Legacy',
                discordUsername: 'legacy'
            }
        }
    });

    const accounts = await client.readLinkedAccountsForDiscordUser({
        id: '999',
        username: 'legacy'
    });

    assert.deepEqual(accounts.map(account => [account.tag, account.matchType]), [
        ['#8CCVV', 'discordUsername']
    ]);
});
