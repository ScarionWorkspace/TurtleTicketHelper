require('dotenv').config();
const { REST, Routes } = require('discord.js');

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        await rest.put(
            Routes.applicationCommands(process.env.DISCORD_CLIENT_ID),
            { body: [] }
        );

        console.log('Alle globalen Commands wurden gelöscht.');
    } catch (error) {
        console.error(error);
    }
})();