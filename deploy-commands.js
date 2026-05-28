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

function logFailure(error) {
    const details = {
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
        status: error?.status || null
    };

    console.error(`Command deployment failed: ${redactKnownSecrets(JSON.stringify(details, null, 2))}`);
}

async function main() {
    assertCommandConfig();

    for (const warning of getConfigWarnings()) {
        console.warn(`Config warning: ${warning}`);
    }

    const commandsPath = path.join(__dirname, 'src', 'commands');
    const commands = loadCommands(commandsPath).map(({ command }) => command.data.toJSON());
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    console.log(`Started refreshing ${commands.length} guild application commands.`);

    await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
        { body: commands }
    );

    console.log(`Successfully reloaded ${commands.length} guild application commands.`);
}

main().catch(error => {
    logFailure(error);
    process.exitCode = 1;
});
