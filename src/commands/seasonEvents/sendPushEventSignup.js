const { SlashCommandBuilder } = require('discord.js');
const { sendSeasonEventSignupMessage } = require('../../features/seasonEvents/sendSignupMessage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('send-push-event-signup')
        .setDescription('Send the current push event signup message in this channel.'),

    async execute(interaction) {
        await sendSeasonEventSignupMessage(interaction, 'push');
    }
};
