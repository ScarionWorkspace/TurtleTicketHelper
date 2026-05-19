const {
    ActionRowBuilder,
    StringSelectMenuBuilder
} = require('discord.js');

const appConfig = require('../../config/appConfig');

function isStaff(member) {
    if (!member || !member.roles || !member.roles.cache) return false;
    return (appConfig.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId));
}

module.exports = async function handleRecommendClanButton(interaction) {
    if (interaction.customId !== 'recommend_clan') return false;

    const recommendationMenuConfig = appConfig.joinClan?.recommendationMenu || {};
    const clanRecommendations = appConfig.clanRecommendations || {};

    if (!isStaff(interaction.member)) {
        await interaction.reply({
            content: recommendationMenuConfig.staffOnlyMessage || 'This button is staff only.',
            flags: 64
        });
        return true;
    }

    const clanOptions = Object.entries(clanRecommendations).map(([key, clan]) => ({
        label: clan.name,
        value: key,
        description: clan.description || `Recommend ${clan.name}`
    }));

    const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(`recommend_clan_select:${interaction.user.id}`)
            .setPlaceholder(
                recommendationMenuConfig.placeholder || 'Choose a clan recommendation'
            )
            .addOptions(clanOptions)
    );

    await interaction.reply({
        content:
            recommendationMenuConfig.openMessage ||
            'Select which clan you want to recommend:',
        components: [row],
        flags: 64
    });

    return true;
};