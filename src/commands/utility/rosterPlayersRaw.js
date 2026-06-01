const { SlashCommandBuilder } = require('discord.js');
const { showRosterPicker } = require('../../features/rosterPlayers/rosterPlayersInteraction');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rosterplayersraw')
        .setDescription('Privately list all players from a selected active roster.'),

    async execute(interaction) {
        await showRosterPicker(interaction, { mode: 'raw' });
    }
};
