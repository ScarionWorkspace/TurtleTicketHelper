const path = require('node:path');
const { REST, Routes } = require('discord.js');
const {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID,
    DISCORD_GUILD_ID,
    assertCommandConfig,
    getConfigWarnings,
    redactKnownSecrets
} = require('./src/config/env');
const { loadCommands } = require('./src/utils/loadCommands');

const DEPLOYMENT_SCOPES = new Set(['guild', 'global']);

function normalizeDeploymentScope(value) {
    const scope = String(value || '').trim().toLowerCase();

    if (!scope) {
        return '';
    }

    if (!DEPLOYMENT_SCOPES.has(scope)) {
        throw new Error('Invalid command deployment scope. Use "guild" or "global".');
    }

    return scope;
}

function resolveDeploymentScope(argv = process.argv.slice(2), env = process.env) {
    let scope = normalizeDeploymentScope(env.DISCORD_COMMAND_DEPLOYMENT_SCOPE);

    for (const arg of argv) {
        if (arg === '--guild' || arg === 'guild') {
            scope = 'guild';
            continue;
        }

        if (arg === '--global' || arg === 'global') {
            scope = 'global';
            continue;
        }

        if (arg.startsWith('--scope=')) {
            scope = normalizeDeploymentScope(arg.slice('--scope='.length));
            continue;
        }

        throw new Error(`Unknown command deployment argument: ${arg}`);
    }

    return scope || 'guild';
}

function logFailure(error) {
    const details = {
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
        status: error?.status || null
    };

    console.error(`Command deployment failed: ${redactKnownSecrets(JSON.stringify(details, null, 2))}`);
}

function getCommandRoute(scope) {
    if (scope === 'global') {
        return Routes.applicationCommands(DISCORD_CLIENT_ID);
    }

    return Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID);
}

async function main(argv = process.argv.slice(2)) {
    const scope = resolveDeploymentScope(argv);

    assertCommandConfig({
        requireGuildId: scope !== 'global'
    });

    for (const warning of getConfigWarnings()) {
        console.warn(`Config warning: ${warning}`);
    }

    const commandsPath = path.join(__dirname, 'src', 'commands');
    const commands = loadCommands(commandsPath).map(({ command }) => command.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    console.log(`Started refreshing ${commands.length} ${scope} application commands.`);

    await rest.put(
        getCommandRoute(scope),
        { body: commands }
    );

    console.log(`Successfully reloaded ${commands.length} ${scope} application commands.`);
}

if (require.main === module) {
    main().catch(error => {
        logFailure(error);
        process.exitCode = 1;
    });
}

module.exports = {
    main,
    normalizeDeploymentScope,
    resolveDeploymentScope
};
