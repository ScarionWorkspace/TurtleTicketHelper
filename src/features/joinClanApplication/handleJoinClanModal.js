const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { fetchPlayerData, normalizePlayerTag } = require('./fetchPlayerData');
const {
    syncDiscordIdentityForPlayerTag
} = require('./syncDiscordUsernameForPlayerTag');
const appConfig = require('../../config/appConfig');

function buildPlayerProfileLink(playerTag) {
    const cleanTag = String(playerTag || '')
        .trim()
        .toUpperCase()
        .replace('#', '');

    return `https://link.clashofclans.com/en/?action=OpenPlayerProfile&tag=${cleanTag}`;
}

async function updateGroupedRoles(member, roleIdsToClear, roleIdToAdd, reason) {
    const clearIds = roleIdsToClear.filter(Boolean);
    const addId = roleIdToAdd || null;

    if (clearIds.length > 0) {
        const idsToRemove = clearIds.filter(roleId => member.roles.cache.has(roleId));
        if (idsToRemove.length > 0) {
            await member.roles.remove(idsToRemove, reason);
        }
    }

    if (addId && !member.roles.cache.has(addId)) {
        await member.roles.add(addId, reason);
    }
}

async function applyJoinClanRoles(member, accountCountKey, continentKey, townHallLevel) {
    const joinClanConfig = appConfig.joinClan || {};
    const accountCountOptions = joinClanConfig.accountCountOptions || {};
    const continentOptions = joinClanConfig.continentOptions || {};
    const townHallRoles = joinClanConfig.townHallRoles || {};
    const reason = joinClanConfig.roleUpdateReason || 'Join clan application role update';

    const accountRoleIds = Object.values(accountCountOptions)
        .map(option => option.roleId)
        .filter(Boolean);

    const continentRoleIds = Object.values(continentOptions)
        .map(option => option.roleId)
        .filter(Boolean);

    const townHallRoleIds = Object.values(townHallRoles)
        .filter(Boolean);

    const selectedAccountRoleId = accountCountOptions[accountCountKey]?.roleId || null;
    const selectedContinentRoleId = continentOptions[continentKey]?.roleId || null;
    const selectedTownHallRoleId = townHallRoles[String(townHallLevel)] || null;

    await updateGroupedRoles(member, accountRoleIds, selectedAccountRoleId, reason);
    await updateGroupedRoles(member, continentRoleIds, selectedContinentRoleId, reason);
    await updateGroupedRoles(member, townHallRoleIds, selectedTownHallRoleId, reason);
}

module.exports = async function handleJoinClanModal(interaction) {
    try {
        if (interaction.customId !== 'join_clan_application_modal') return;

        const rawPlayerTag = interaction.fields.getTextInputValue('player_tag').trim();
        const accountCount = interaction.fields.getStringSelectValues('account_count')[0];
        const continent = interaction.fields.getStringSelectValues('continent')[0];

        await interaction.deferReply({ flags: 64 });

        const normalizedTag = normalizePlayerTag(rawPlayerTag);
        const playerData = await fetchPlayerData(normalizedTag);
        const playerProfileLink = buildPlayerProfileLink(playerData.tag ?? normalizedTag);

        void syncDiscordIdentityForPlayerTag(
            playerData.tag || normalizedTag,
            interaction.user.id,
            interaction.user.username
        );

        const { colors, application, recommendationMenu } = appConfig.joinClan;
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
                    value: `\`${playerData.tag ?? normalizedTag}\`\n[Open In-Game](${playerProfileLink})`,
                    inline: false
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
                    value: appConfig.joinClan.accountCountOptions[accountCount]?.label || 'Unknown',
                    inline: true
                },
                {
                    name: fields.continent,
                    value: appConfig.joinClan.continentOptions[continent]?.label || 'Unknown',
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

        if (interaction.member && interaction.member.roles) {
            await applyJoinClanRoles(
                interaction.member,
                accountCount,
                continent,
                playerData.townHallLevel
            );
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