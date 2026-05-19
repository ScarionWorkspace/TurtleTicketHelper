const { EmbedBuilder } = require('discord.js');
const appConfig = require('../../config/appConfig');

function isStaff(member) {
    if (!member || !member.roles || !member.roles.cache) return false;
    return (appConfig.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId));
}

function getApplicantIdFromEmbed(interaction) {
    const embed = interaction.message?.embeds?.[0];
    const footerText = embed?.footer?.text || '';
    const match = footerText.match(/Applicant ID:\s*(\d+)/i);
    return match ? match[1] : null;
}

module.exports = async function handleRecommendClanSelect(interaction) {
    if (!interaction.isStringSelectMenu()) return false;
    if (!interaction.customId.startsWith('recommend_clan_select:')) return false;

    const allowedUserId = interaction.customId.split(':')[1];
    const recommendationMenuConfig = appConfig.joinClan?.recommendationMenu || {};
    const recommendationEmbedConfig = appConfig.joinClan?.recommendationEmbed || {};
    const recommendationColor =
        appConfig.joinClan?.colors?.recommendationEmbed ?? 0x57F287;

    if (interaction.user.id !== allowedUserId) {
        await interaction.reply({
            content: recommendationMenuConfig.notYourMenuMessage || 'This menu is not for you.',
            flags: 64
        });
        return true;
    }

    if (!isStaff(interaction.member)) {
        await interaction.reply({
            content: recommendationMenuConfig.staffOnlyMessage || 'This menu is staff only.',
            flags: 64
        });
        return true;
    }

    const selected = interaction.values[0];
    const clan = appConfig.clanRecommendations?.[selected];

    if (!clan) {
        await interaction.reply({
            content: recommendationMenuConfig.invalidSelectionMessage || 'Invalid clan selection.',
            flags: 64
        });
        return true;
    }

    const applicantId = getApplicantIdFromEmbed(interaction);
    const applicantMention = applicantId ? `<@${applicantId}>` : 'Applicant';

    const embed = new EmbedBuilder()
        .setColor(recommendationColor)
        .setTitle(
            `${recommendationEmbedConfig.titlePrefix || 'Clan Recommendation:'} ${clan.name}`
        )
        .setDescription(
            `${applicantMention}\n\n` +
            `${recommendationEmbedConfig.introPrefix || 'We think'} **${clan.name}** ${recommendationEmbedConfig.introSuffix || 'is the best fit for you.'}\n\n` +
            `**${recommendationEmbedConfig.linkLabel || 'Clan Link:'}**\n${clan.link}\n\n` +
            `${recommendationEmbedConfig.recommendedByPrefix || 'Recommended by'} ${interaction.user}`
        )
        .setTimestamp();

    await interaction.channel.send({
        embeds: [embed]
    });

    await interaction.update({
        content: `${recommendationMenuConfig.sentMessagePrefix || 'Recommendation sent:'} ${clan.name}`,
        components: []
    });

    return true;
};