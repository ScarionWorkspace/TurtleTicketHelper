const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder
} = require('discord.js');

const appConfig = require('../../config/appConfig');

module.exports = async function handleJoinClanButton(interaction) {
    try {
        if (interaction.customId !== 'join_clan_apply') return;

        const modal = new ModalBuilder()
            .setCustomId('join_clan_application_modal')
            .setTitle(appConfig.joinClan.modal.title);

        const playerTagInput = new TextInputBuilder()
            .setCustomId('player_tag')
            .setLabel(appConfig.joinClan.modal.playerTagLabel)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(appConfig.joinClan.modal.playerTagPlaceholder)
            .setRequired(true)
            .setMinLength(3)
            .setMaxLength(20);

        const accountsInput = new TextInputBuilder()
            .setCustomId('account_count')
            .setLabel(appConfig.joinClan.modal.accountCountLabel)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(appConfig.joinClan.modal.accountCountPlaceholder)
            .setRequired(true)
            .setMaxLength(20);

        const continentInput = new TextInputBuilder()
            .setCustomId('continent')
            .setLabel(appConfig.joinClan.modal.continentLabel)
            .setStyle(TextInputStyle.Short)
            .setPlaceholder(appConfig.joinClan.modal.continentPlaceholder)
            .setRequired(true)
            .setMaxLength(50);

        modal.addComponents(
            new ActionRowBuilder().addComponents(playerTagInput),
            new ActionRowBuilder().addComponents(accountsInput),
            new ActionRowBuilder().addComponents(continentInput)
        );

        await interaction.showModal(modal);
    } catch (error) {
        console.error('Join Clan button failed:', error);
    }
};