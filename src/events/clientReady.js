const {
    DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP,
    redactKnownSecrets
} = require('../config/env');

function formatCommandRegistrationError(error) {
    return redactKnownSecrets(JSON.stringify({
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
        status: error?.status || null
    }, null, 2));
}

module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        if (DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP) {
            try {
                const commands = client.commands.map(command => command.data.toJSON());
                await client.application.commands.set(commands);
                console.log(
                    `Registered ${commands.length} global slash commands on startup because DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP is enabled.`
                );
            } catch (error) {
                console.error(`Failed to register global slash commands: ${formatCommandRegistrationError(error)}`);
            }
        } else {
            console.log('Skipped startup global slash command registration. Use npm run deploy:commands to deploy commands explicitly.');
        }

        console.log(`Logged in as ${client.user.tag}`);
    }
};
