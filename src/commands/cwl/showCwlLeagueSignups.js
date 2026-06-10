const { SlashCommandBuilder } = require('discord.js');
const { showCwlLeagueSignupSummary } = require('../../features/cwlLeagueSignups/cwlLeagueSignupFlow');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('show-cwl-league-signups')
        .setDescription('Show all CWL league preferences submitted from the signup message.'),

    async execute(interaction) {
        await showCwlLeagueSignupSummary(interaction);
    }
};
