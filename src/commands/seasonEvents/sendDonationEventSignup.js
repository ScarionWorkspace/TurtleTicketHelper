const { SlashCommandBuilder } = require('discord.js');
const { sendSeasonEventSignupMessage } = require('../../features/seasonEvents/sendSignupMessage');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('send-donation-event-signup')
        .setDescription('Send the current donation event signup message in this channel.'),

    async execute(interaction) {
        await sendSeasonEventSignupMessage(interaction, 'donation');
    }
};
