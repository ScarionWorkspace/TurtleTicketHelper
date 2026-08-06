const {
    DISCORD_REGISTER_GLOBAL_COMMANDS_ON_STARTUP,
    DISCORD_GUILD_ID,
    redactKnownSecrets
} = require('../config/env');
const {
    startWarFollowupScheduler
} = require('../features/warFollowup/scheduler');

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
                let guild = DISCORD_GUILD_ID
                    ? client.guilds?.cache?.get?.(DISCORD_GUILD_ID)
                    : null;
                if (!guild && DISCORD_GUILD_ID && typeof client.guilds?.fetch === 'function') {
                    guild = await client.guilds.fetch(DISCORD_GUILD_ID).catch(() => null);
                }
                if (DISCORD_GUILD_ID && !guild?.commands?.set) {
                    throw new Error('The configured guild command scope could not be resolved for duplicate cleanup.');
                }
                if (guild?.commands?.set) await guild.commands.set([]);
                console.log(
                    `Registered ${commands.length} global slash commands` +
                    `${guild ? ' and cleared the configured guild scope to prevent duplicates' : ''}.`
                );
            } catch (error) {
                console.error(`Failed to register global slash commands: ${formatCommandRegistrationError(error)}`);
            }
        } else {
            console.log('Skipped startup global slash command registration. Use npm run deploy:commands to deploy commands explicitly.');
        }

        console.log(`Logged in as ${client.user.tag}`);
        startWarFollowupScheduler(client);
    }
};
