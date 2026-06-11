const { SlashCommandBuilder } = require('discord.js');
const { showLinkListPicker } = require('../../features/linkList/linkListInteraction');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('link-list')
        .setDescription('List linked and unlinked Discord users for a selected clan.'),

    async execute(interaction) {
        await showLinkListPicker(interaction);
    }
};
