const { SlashCommandBuilder } = require('discord.js');
const { sendCwlLeagueSignupMessage } = require('../../features/cwlLeagueSignups/cwlLeagueSignupFlow');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('send-cwl-league-signup')
        .setDescription('Send the CWL league signup message in this channel.'),

    async execute(interaction) {
        await sendCwlLeagueSignupMessage(interaction);
    }
};
