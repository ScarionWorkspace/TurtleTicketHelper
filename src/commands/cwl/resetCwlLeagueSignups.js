const { SlashCommandBuilder } = require('discord.js');
const {
    showResetCwlLeaguePreferencesConfirmation
} = require('../../features/cwlLeagueSignups/cwlLeagueSignupFlow');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('reset-cwl-league-signups')
        .setDescription('Staff only: reset all saved CWL league preferences after confirmation.'),

    async execute(interaction) {
        await showResetCwlLeaguePreferencesConfirmation(interaction);
    }
};
