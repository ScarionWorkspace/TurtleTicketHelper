const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const { test } = require('node:test');

const ENV_KEYS = [
    'DISCORD_TOKEN',
    'DISCORD_BOT_TOKEN',
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'COC_API_TOKEN',
    'CLASH_OF_CLANS_API_KEY',
    'ROSTER_BOT_SECRET'
];

const VALID_TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccc';

function cleanEnv(overrides = {}) {
    const env = { ...process.env };

    for (const key of ENV_KEYS) {
        delete env[key];
    }

    return {
        ...env,
        ...overrides
    };
}

function runNode(code, env) {
    return spawnSync(process.execPath, ['-e', code], {
        cwd: process.cwd(),
        env: cleanEnv(env),
        encoding: 'utf8'
    });
}

test('bot config fails fast when Discord token is missing', () => {
    const result = runNode(
        "const { assertBotConfig } = require('./src/config/env'); assertBotConfig();"
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DISCORD_TOKEN missing/);
});

test('bot config accepts documented compatibility token alias', () => {
    execFileSync(
        process.execPath,
        [
            '-e',
            "const { DISCORD_TOKEN, assertBotConfig } = require('./src/config/env'); assertBotConfig(); console.log(DISCORD_TOKEN);"
        ],
        {
            cwd: process.cwd(),
            env: cleanEnv({
                DISCORD_BOT_TOKEN: VALID_TOKEN
            }),
            encoding: 'utf8'
        }
    );
});

test('command config validates Discord ids before REST calls', () => {
    const result = runNode(
        "const { assertCommandConfig } = require('./src/config/env'); assertCommandConfig();",
        {
            DISCORD_TOKEN: VALID_TOKEN,
            DISCORD_CLIENT_ID: 'not-a-snowflake',
            DISCORD_GUILD_ID: '234567890123456789'
        }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /DISCORD_CLIENT_ID must be a Discord snowflake id/);
});

test('bot config rejects placeholder token values', () => {
    const result = runNode(
        "const { assertBotConfig } = require('./src/config/env'); assertBotConfig();",
        {
            DISCORD_TOKEN: 'your_discord_bot_token_here'
        }
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /placeholder value/);
});
