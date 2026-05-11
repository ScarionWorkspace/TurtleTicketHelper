const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { fetchPlayerData, normalizePlayerTag } = require('./fetchPlayerData');
const appConfig = require('../../config/appConfig');

module.exports = async function handleJoinClanModal(interaction) {
    try {
        if (interaction.customId !== 'join_clan_application_modal') return;

        const rawPlayerTag = interaction.fields.getTextInputValue('player_tag').trim();
        const accountCount = interaction.fields.getTextInputValue('account_count').trim();
        const continent = interaction.fields.getTextInputValue('continent').trim();

        await interaction.deferReply({ flags: 64 });

        const normalizedTag = normalizePlayerTag(rawPlayerTag);
        const playerData = await fetchPlayerData(normalizedTag);

        const { colors, application, recommendationMenu, prompt } = appConfig.joinClan;
        const fields = application.fields;

        const embed = new EmbedBuilder()
            .setColor(colors.applicationEmbed)
            .setTitle(application.title)
            .setDescription(`${application.descriptionPrefix} ${interaction.user}`);

        if (playerData.currentLeagueIcon) {
            embed.setThumbnail(playerData.currentLeagueIcon);
        }

        embed
            .addFields(
                {
                    name: fields.applicant,
                    value: `${interaction.user}`,
                    inline: true
                },
                {
                    name: fields.playerName,
                    value: String(playerData.name ?? 'Unknown'),
                    inline: true
                },
                {
                    name: fields.playerTag,
                    value: `\`${playerData.tag ?? normalizedTag}\``,
                    inline: true
                },
                {
                    name: fields.townHall,
                    value: String(playerData.townHallLevel ?? 'Unknown'),
                    inline: true
                },
                {
                    name: fields.league,
                    value: String(playerData.currentLeague ?? 'Unknown'),
                    inline: true
                },
                {
                    name: fields.warStars,
                    value: String(playerData.warStars ?? 'Unknown'),
                    inline: true
                },
                {
                    name: fields.accounts,
                    value: String(accountCount || 'Unknown'),
                    inline: true
                },
                {
                    name: fields.continent,
                    value: String(continent || 'Unknown'),
                    inline: true
                },
                {
                    name: '\u200b',
                    value: '\u200b',
                    inline: true
                },
                {
                    name: fields.currentClan,
                    value: playerData.clanTag
                        ? `${playerData.clanName ?? 'Unknown'} (\`${playerData.clanTag}\`)`
                        : String(playerData.clanName ?? 'No Clan'),
                    inline: false
                }
            )
            .setFooter({
                text: `${application.applicantFooterPrefix} ${interaction.user.id}`
            })
            .setTimestamp();

        const applicationRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('recommend_clan')
                .setLabel(recommendationMenu.buttonLabel)
                .setStyle(ButtonStyle.Primary)
        );

        await interaction.channel.send({
            embeds: [embed],
            components: [applicationRow]
        });

        const disabledRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('join_clan_apply')
                .setLabel(application.submittedButtonLabel)
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(true)
        );

        if (interaction.message) {
            await interaction.message.edit({
                components: [disabledRow]
            });
        }

        await interaction.editReply({
            content: application.successMessage
        });
    } catch (error) {
        console.error('Join Clan modal failed:', error);

        const application = appConfig.joinClan.application;

        const content =
            error.message === 'PLAYER_NOT_FOUND'
                ? application.playerNotFoundMessage
                : error.message === 'INVALID_PLAYER_TAG'
                    ? application.invalidPlayerTagMessage
                    : application.genericErrorMessage;

        if (interaction.deferred) {
            await interaction.editReply({ content });
        } else if (!interaction.replied) {
            await interaction.reply({
                content,
                flags: 64
            });
        }
    }
};