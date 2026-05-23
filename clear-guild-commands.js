require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationGuildCommands(
                process.env.DISCORD_CLIENT_ID,
                process.env.DISCORD_GUILD_ID
            ),
            { body: [] }
        );

        console.log('Alle Guild-Commands wurden gelöscht.');
    } catch (error) {
        console.error(error);
    }
})();