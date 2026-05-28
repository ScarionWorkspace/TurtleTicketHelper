const { REST, Routes } = require('discord.js');
const {
    DISCORD_TOKEN,
    DISCORD_CLIENT_ID,
    DISCORD_GUILD_ID,
    assertCommandConfig,
    redactKnownSecrets
} = require('./src/config/env');

function logFailure(error) {
    const details = {
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
        status: error?.status || null
    };

    console.error(`Failed to clear guild commands: ${redactKnownSecrets(JSON.stringify(details, null, 2))}`);
}

async function main() {
    assertCommandConfig();

    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID),
        { body: [] }
    );

    console.log('All guild commands were deleted.');
}

main().catch(error => {
    logFailure(error);
    process.exitCode = 1;
});
