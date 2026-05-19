const {
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    LabelBuilder
} = require('discord.js');
const appConfig = require('../../config/appConfig');

module.exports = async function handleJoinClanButton(interaction) {
    if (!interaction.isButton()) return false;
    if (interaction.customId !== 'join_clan_apply') return false;

    const modalConfig = appConfig.joinClan.modal;
    const accountCountOptions = appConfig.joinClan.accountCountOptions || {};
    const continentOptions = appConfig.joinClan.continentOptions || {};

    const modal = new ModalBuilder()
        .setCustomId('join_clan_application_modal')
        .setTitle(modalConfig.title);

    const playerTagInput = new TextInputBuilder()
        .setCustomId('player_tag')
        .setPlaceholder(modalConfig.playerTagPlaceholder)
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMinLength(3)
        .setMaxLength(15);

    const accountCountSelect = new StringSelectMenuBuilder()
        .setCustomId('account_count')
        .setPlaceholder(modalConfig.accountCountPlaceholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            Object.entries(accountCountOptions).map(([value, option]) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(option.label)
                    .setDescription(option.description)
                    .setValue(value)
            )
        );

    const continentSelect = new StringSelectMenuBuilder()
        .setCustomId('continent')
        .setPlaceholder(modalConfig.continentPlaceholder)
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(
            Object.entries(continentOptions).map(([value, option]) =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(option.label)
                    .setDescription(option.description)
                    .setValue(value)
            )
        );

    modal.addLabelComponents(
        new LabelBuilder()
            .setLabel(modalConfig.playerTagLabel)
            .setTextInputComponent(playerTagInput),

        new LabelBuilder()
            .setLabel(modalConfig.accountCountLabel)
            .setStringSelectMenuComponent(accountCountSelect),

        new LabelBuilder()
            .setLabel(modalConfig.continentLabel)
            .setStringSelectMenuComponent(continentSelect)
    );

    await interaction.showModal(modal);
    return true;
};