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

    if (interaction.user.id !== allowedUserId) {
        await interaction.reply({
            content: appConfig.joinClan?.notYourMenuMessage || 'This menu is not for you.',
            flags: 64
        });
        return true;
    }

    if (!isStaff(interaction.member)) {
        await interaction.reply({
            content: appConfig.joinClan?.staffOnlyMenuMessage || 'This menu is staff only.',
            flags: 64
        });
        return true;
    }

    const selected = interaction.values[0];
    const clan = appConfig.clanRecommendations?.[selected];

    if (!clan) {
        await interaction.reply({
            content: appConfig.joinClan?.invalidClanSelectionMessage || 'Invalid clan selection.',
            flags: 64
        });
        return true;
    }

    const applicantId = getApplicantIdFromEmbed(interaction);
    const applicantMention = applicantId ? `<@${applicantId}>` : 'Applicant';

    const embed = new EmbedBuilder()
        .setColor(appConfig.joinClan?.recommendationEmbedColor ?? 0x57F287)
        .setTitle(
            `${appConfig.joinClan?.recommendationTitlePrefix || 'Clan Recommendation:'} ${clan.name}`
        )
        .setDescription(
            `${applicantMention}\n\n` +
            `${appConfig.joinClan?.recommendationIntroPrefix || 'We think'} **${clan.name}** ${appConfig.joinClan?.recommendationIntroSuffix || 'is the best fit for you.'}\n\n` +
            `**${appConfig.joinClan?.recommendationReasonLabel || 'Why this clan fits:'}**\n${clan.explanation}\n\n` +
            `**${appConfig.joinClan?.recommendationLinkLabel || 'Clan Link:'}**\n${clan.link}\n\n` +
            `${appConfig.joinClan?.recommendedByPrefix || 'Recommended by'} ${interaction.user}`
        )
        .setTimestamp();

    await interaction.channel.send({
        embeds: [embed]
    });

    await interaction.update({
        content:
            `${appConfig.joinClan?.recommendationSentPrefix || 'Recommendation sent:'} ${clan.name}`,
        components: []
    });

    return true;
};