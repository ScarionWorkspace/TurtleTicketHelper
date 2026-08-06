const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const ENV_MODULE_PATH = '../src/config/env';
const READY_MODULE_PATH = '../src/events/clientReady';
const FLAG_NAME = 'DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP';

const originalEnv = {
    TURTLE_HELPER_SKIP_DOTENV: process.env.TURTLE_HELPER_SKIP_DOTENV,
    [FLAG_NAME]: process.env[FLAG_NAME],
    DISCORD_GUILD_ID: process.env.DISCORD_GUILD_ID
};
const originalConsole = {
    log: console.log,
    error: console.error
};

function restoreEnv() {
    for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
}

function clearModuleCache() {
    delete require.cache[require.resolve(ENV_MODULE_PATH)];
    delete require.cache[require.resolve(READY_MODULE_PATH)];
}

function loadClientReady(flagValue, guildId) {
    clearModuleCache();
    process.env.TURTLE_HELPER_SKIP_DOTENV = '1';

    if (flagValue === undefined) {
        delete process.env[FLAG_NAME];
    } else {
        process.env[FLAG_NAME] = flagValue;
    }

    if (guildId === undefined) delete process.env.DISCORD_GUILD_ID;
    else process.env.DISCORD_GUILD_ID = guildId;

    return require(READY_MODULE_PATH);
}

function createClient() {
    const setCalls = [];
    const guildSetCalls = [];
    const commandPayloads = [
        { name: 'link' },
        { name: 'roster' }
    ];

    return {
        commands: {
            map(callback) {
                return commandPayloads.map(payload => callback({
                    data: {
                        toJSON: () => payload
                    }
                }));
            }
        },
        application: {
            commands: {
                set: async commands => {
                    setCalls.push(commands);
                }
            }
        },
        guilds: {
            cache: new Map([['123456789012345678', {
                commands: {
                    set: async commands => guildSetCalls.push(commands)
                }
            }]])
        },
        channels: {
            cache: new Map()
        },
        user: {
            tag: 'TestBot#0001'
        },
        setCalls,
        guildSetCalls
    };
}

async function withMutedConsole(callback) {
    console.log = () => {};
    console.error = () => {};

    try {
        await callback();
    } finally {
        console.log = originalConsole.log;
        console.error = originalConsole.error;
    }
}

afterEach(() => {
    restoreEnv();
    clearModuleCache();
    console.log = originalConsole.log;
    console.error = originalConsole.error;
});

test('client ready does not register global slash commands by default', async () => {
    const event = loadClientReady();
    const client = createClient();

    await withMutedConsole(() => event.execute(client));

    assert.equal(client.setCalls.length, 0);
});

test('client ready registers global slash commands when explicitly enabled', async () => {
    const event = loadClientReady('true', '123456789012345678');
    const client = createClient();

    await withMutedConsole(() => event.execute(client));

    assert.deepEqual(client.setCalls, [[
        { name: 'link' },
        { name: 'roster' }
    ]]);
    assert.deepEqual(client.guildSetCalls, [[]]);
});

test('client ready treats false startup registration flag as disabled', async () => {
    const event = loadClientReady('false');
    const client = createClient();

    await withMutedConsole(() => event.execute(client));

    assert.equal(client.setCalls.length, 0);
});
