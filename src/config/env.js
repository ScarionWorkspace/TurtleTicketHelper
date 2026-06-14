const path = require('node:path');
const dotenv = require('dotenv');

if (process.env.TURTLE_HELPER_SKIP_DOTENV !== '1') {
    dotenv.config({
        path: [
            path.resolve(__dirname, '..', '..', '.env'),
            path.resolve(__dirname, '..', '..', 'env')
        ],
        quiet: true
    });
}

const SECRET_KEY_PATTERN = /(TOKEN|SECRET|KEY|PASSWORD)/i;
const PLACEHOLDER_PATTERN = /^(your_|replace_|changeme|todo|example|null|undefined)/i;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const OPTIONAL_SNOWFLAKE_ENV_NAMES = [
    'DISCORD_CLIENT_ID',
    'DISCORD_GUILD_ID',
    'TICKET_TOOL_BOT_ID',
    'CLASHPERK_BOT_ID',
    'OPEN_TICKET_CATEGORY_ID',
    'CLOSED_TICKET_CATEGORY_ID'
];
const BOOLEAN_ENV_NAMES = [
    'DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP'
];
const BOOLEAN_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const BOOLEAN_FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

const ENV_DEFINITIONS = {
    DISCORD_TOKEN: {
        aliases: ['DISCORD_BOT_TOKEN'],
        requiredFor: ['bot', 'commands'],
        secret: true
    },
    DISCORD_CLIENT_ID: {
        requiredFor: ['commands']
    },
    DISCORD_GUILD_ID: {
        requiredFor: ['commands']
    },
    DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP: {},
    TICKET_TOOL_BOT_ID: {},
    CLASHPERK_BOT_ID: {},
    OPEN_TICKET_CATEGORY_ID: {},
    CLOSED_TICKET_CATEGORY_ID: {},
    COC_API_TOKEN: {
        aliases: ['CLASH_OF_CLANS_API_KEY'],
        secret: true
    },
    ROSTER_BACKEND_URL: {},
    ROSTER_BOT_SECRET: {
        secret: true
    },
    ROSTER_FIREBASE_DB_URL: {},
    ROSTER_WEBSITE_LEADERBOARD_URL: {}
};

function normalizeEnvValue(value, options = {}) {
    if (value === null || value === undefined) {
        return '';
    }

    let normalized = String(value)
        .trim()
        .replace(/^\uFEFF/, '')
        .replace(/[\u200B-\u200D\u2060]/g, '');

    if (
        (normalized.startsWith('"') && normalized.endsWith('"')) ||
        (normalized.startsWith("'") && normalized.endsWith("'"))
    ) {
        normalized = normalized.slice(1, -1).trim();
    }

    if (options.stripBotPrefix && /^bot\s+/i.test(normalized)) {
        normalized = normalized.replace(/^bot\s+/i, '').trim();
    }

    return normalized;
}

function getRawEnvValue(name) {
    return Object.prototype.hasOwnProperty.call(process.env, name)
        ? process.env[name]
        : undefined;
}

function resolveEnv(name) {
    const definition = ENV_DEFINITIONS[name] || {};
    const keys = [name, ...(definition.aliases || [])];
    const values = keys
        .map(key => ({
            key,
            value: normalizeEnvValue(getRawEnvValue(key), {
                stripBotPrefix: name === 'DISCORD_TOKEN'
            })
        }))
        .filter(entry => entry.value);
    const selected = values[0] || { key: null, value: '' };
    const conflicts = values
        .filter(entry => entry.key !== selected.key && entry.value !== selected.value)
        .map(entry => entry.key);

    return {
        name,
        key: selected.key,
        value: selected.value,
        aliases: definition.aliases || [],
        conflicts,
        secret: definition.secret === true || SECRET_KEY_PATTERN.test(name)
    };
}

function getEnv(name) {
    return resolveEnv(name).value;
}

function parseBooleanEnv(value) {
    const normalized = normalizeEnvValue(value).toLowerCase();

    return BOOLEAN_TRUE_VALUES.has(normalized);
}

function getBooleanEnv(name) {
    return parseBooleanEnv(getEnv(name));
}

function redactValue(value) {
    const text = String(value || '');

    if (!text) {
        return '<missing>';
    }

    return '<redacted>';
}

function redactKnownSecrets(value) {
    let redacted = String(value ?? '');

    for (const name of Object.keys(ENV_DEFINITIONS)) {
        const resolved = resolveEnv(name);

        if (!resolved.secret || !resolved.value) {
            continue;
        }

        redacted = redacted.split(resolved.value).join(`[redacted:${name}]`);
    }

    return redacted;
}

function isPlaceholder(value) {
    return PLACEHOLDER_PATTERN.test(String(value || '').trim());
}

function validateDiscordToken(value) {
    const token = normalizeEnvValue(value, { stripBotPrefix: true });
    const problems = [];

    if (!token) {
        problems.push('missing');
        return problems;
    }

    if (isPlaceholder(token)) {
        problems.push('placeholder value');
    }

    if (/\s/.test(token)) {
        problems.push('contains whitespace');
    }

    if (!/^[A-Za-z0-9._-]+$/.test(token)) {
        problems.push('contains invalid characters');
    }

    if (token.split('.').length < 3) {
        problems.push('does not look like a Discord bot token');
    }

    return problems;
}

function validateSnowflake(name, required = false) {
    const value = getEnv(name);

    if (!value) {
        return required ? [`${name} is missing`] : [];
    }

    return SNOWFLAKE_PATTERN.test(value)
        ? []
        : [`${name} must be a Discord snowflake id`];
}

function getConfigReport() {
    return Object.keys(ENV_DEFINITIONS).map(name => {
        const resolved = resolveEnv(name);

        return {
            name,
            source: resolved.key,
            aliases: resolved.aliases,
            configured: Boolean(resolved.value),
            value: resolved.secret ? redactValue(resolved.value) : resolved.value,
            conflicts: resolved.conflicts
        };
    });
}

function getConfigWarnings() {
    const warnings = [];

    for (const entry of getConfigReport()) {
        if (entry.conflicts.length > 0) {
            warnings.push(
                `${entry.name} has multiple configured values (${[
                    entry.source,
                    ...entry.conflicts
                ].join(', ')}). Using ${entry.source}.`
            );
        }
    }

    for (const alias of ENV_DEFINITIONS.DISCORD_TOKEN.aliases) {
        if (getRawEnvValue(alias) && !getRawEnvValue('DISCORD_TOKEN')) {
            warnings.push(
                `${alias} is supported for compatibility, but DISCORD_TOKEN is the preferred name.`
            );
        }
    }

    for (const alias of ENV_DEFINITIONS.COC_API_TOKEN.aliases) {
        if (getRawEnvValue(alias) && !getRawEnvValue('COC_API_TOKEN')) {
            warnings.push(
                `${alias} is supported for compatibility, but COC_API_TOKEN is the preferred name.`
            );
        }
    }

    for (const name of OPTIONAL_SNOWFLAKE_ENV_NAMES) {
        const value = getEnv(name);

        if (value && !SNOWFLAKE_PATTERN.test(value)) {
            warnings.push(`${name} is set but does not look like a Discord snowflake id.`);
        }
    }

    for (const name of BOOLEAN_ENV_NAMES) {
        const value = getEnv(name).toLowerCase();

        if (value && !BOOLEAN_TRUE_VALUES.has(value) && !BOOLEAN_FALSE_VALUES.has(value)) {
            warnings.push(`${name} should be one of: true, false, 1, 0, yes, no, on, off.`);
        }
    }

    if (!getEnv('OPEN_TICKET_CATEGORY_ID') || !getEnv('CLOSED_TICKET_CATEGORY_ID')) {
        warnings.push('Ticket rename/delete automation needs OPEN_TICKET_CATEGORY_ID and CLOSED_TICKET_CATEGORY_ID.');
    }

    if (!getEnv('COC_API_TOKEN')) {
        warnings.push('Join clan application lookup needs COC_API_TOKEN.');
    }

    if (Boolean(getEnv('ROSTER_BACKEND_URL')) !== Boolean(getEnv('ROSTER_BOT_SECRET'))) {
        warnings.push('Roster backend integration needs both ROSTER_BACKEND_URL and ROSTER_BOT_SECRET.');
    }

    if (!getEnv('CLASHPERK_BOT_ID')) {
        warnings.push('ClashPerk link sync needs CLASHPERK_BOT_ID.');
    }

    return warnings;
}

function assertBotConfig() {
    const problems = validateDiscordToken(getEnv('DISCORD_TOKEN'))
        .map(problem => `DISCORD_TOKEN ${problem}`);

    if (problems.length > 0) {
        throw new Error(`Invalid Discord bot configuration: ${problems.join(', ')}.`);
    }
}

function assertCommandConfig(options = {}) {
    const problems = [
        ...validateDiscordToken(getEnv('DISCORD_TOKEN')).map(problem => `DISCORD_TOKEN ${problem}`),
        ...validateSnowflake('DISCORD_CLIENT_ID', true)
    ];

    if (options.requireGuildId !== false) {
        problems.push(...validateSnowflake('DISCORD_GUILD_ID', true));
    }

    if (problems.length > 0) {
        throw new Error(`Invalid command deployment configuration: ${problems.join(', ')}.`);
    }
}

module.exports = {
    DISCORD_TOKEN: getEnv('DISCORD_TOKEN'),
    DISCORD_CLIENT_ID: getEnv('DISCORD_CLIENT_ID'),
    DISCORD_GUILD_ID: getEnv('DISCORD_GUILD_ID'),
    DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP: getBooleanEnv('DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP'),
    TICKET_TOOL_BOT_ID: getEnv('TICKET_TOOL_BOT_ID'),
    CLASHPERK_BOT_ID: getEnv('CLASHPERK_BOT_ID'),
    OPEN_TICKET_CATEGORY_ID: getEnv('OPEN_TICKET_CATEGORY_ID'),
    CLOSED_TICKET_CATEGORY_ID: getEnv('CLOSED_TICKET_CATEGORY_ID'),
    COC_API_TOKEN: getEnv('COC_API_TOKEN'),
    ROSTER_BACKEND_URL: getEnv('ROSTER_BACKEND_URL'),
    ROSTER_BOT_SECRET: getEnv('ROSTER_BOT_SECRET'),
    ROSTER_FIREBASE_DB_URL: getEnv('ROSTER_FIREBASE_DB_URL'),
    ROSTER_WEBSITE_LEADERBOARD_URL: getEnv('ROSTER_WEBSITE_LEADERBOARD_URL'),
    assertBotConfig,
    assertCommandConfig,
    getConfigReport,
    getConfigWarnings,
    normalizeEnvValue,
    parseBooleanEnv,
    redactKnownSecrets,
    validateDiscordToken
};
