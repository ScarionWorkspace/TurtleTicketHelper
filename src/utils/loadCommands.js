const fs = require('node:fs');
const path = require('node:path');

function loadCommands(commandsPath) {
    const commands = [];

    if (!fs.existsSync(commandsPath)) {
        return commands;
    }

    const commandFolders = fs.readdirSync(commandsPath);

    for (const folder of commandFolders) {
        const folderPath = path.join(commandsPath, folder);

        if (!fs.statSync(folderPath).isDirectory()) {
            continue;
        }

        const commandFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

        for (const file of commandFiles) {
            const filePath = path.join(folderPath, file);
            const command = require(filePath);

            if (command?.data && typeof command.execute === 'function') {
                commands.push({
                    command,
                    filePath
                });
            } else {
                console.warn(`Command at ${filePath} is missing "data" or "execute".`);
            }
        }
    }

    return commands;
}

module.exports = {
    loadCommands
};
