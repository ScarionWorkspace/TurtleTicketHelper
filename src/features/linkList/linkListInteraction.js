const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const rosterFirebase = require('../rosterFirebase/rosterFirebaseReadClient');
const { fetchClanMembers } = require('../clashApi/fetchClanMembers');
const {
    buildLinkListPlayerRows,
    findRosterByClanTag,
    getRosterTitle,
    getSelectableClanRosters
} = require('./linkListData');
const { buildDiscordPresenceById } = require('./linkListDiscordPresence');
const {
    buildLinkListErrorMessage,
    buildLinkListLoadingMessage,
    buildLinkListMessage
} = require('./linkListMessage');
const {
    CUSTOM_ID_PREFIX,
    MODE_TAGS,
    isLinkListCustomId,
    parseLinkListClanValue,
    parseLinkListRefreshCustomId,
    parseLinkListSwitchCustomId,
    parseLinkListViewCustomId
} = require('./linkListCustomIds');

const EPHEMERAL = 64;
const CLANS_PER_PAGE = 25;

function buildMenuCustomId(action, userId, page = 0) {
    return `${CUSTOM_ID_PREFIX}:menu:${action}:${userId}:${Math.max(0, page)}`;
}

function parseMenuCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'link_list' || parts[1] !== 'v1' || parts[2] !== 'menu') {
        return null;
    }

    const page = Number.parseInt(parts[5] || '0', 10);

    return {
        action: parts[3] || null,
        userId: parts[4] || null,
        page: Number.isFinite(page) && page >= 0 ? page : 0
    };
}

function truncateOptionText(value, fallback) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    const safeText = text || fallback || 'Clan';

    return safeText.length <= 100 ? safeText : `${safeText.slice(0, 97)}...`;
}

function getTotalPages(clanCount) {
    return Math.max(1, Math.ceil(clanCount / CLANS_PER_PAGE));
}

function clampPage(page, clanCount) {
    return Math.min(Math.max(page, 0), getTotalPages(clanCount) - 1);
}

function buildClanSelectOption(roster, index) {
    const clanTag = String(roster?.connectedClanTag || '').trim();
    const label = `${getRosterTitle(roster)} ${clanTag}`.trim();

    return new StringSelectMenuOptionBuilder()
        .setLabel(truncateOptionText(label, `Clan ${index + 1}`))
        .setDescription(truncateOptionText(clanTag || roster?.id, 'Connected clan'))
        .setValue(`idx:${index}`);
}

function buildClanPickerComponents(rosters, userId, page) {
    const start = page * CLANS_PER_PAGE;
    const pageRosters = rosters.slice(start, start + CLANS_PER_PAGE);
    const totalPages = getTotalPages(rosters.length);
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildMenuCustomId('select', userId, page))
                .setPlaceholder(
                    totalPages > 1
                        ? `Choose a clan (${page + 1}/${totalPages})`
                        : 'Choose a clan'
                )
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(pageRosters.map((roster, offset) =>
                    buildClanSelectOption(roster, start + offset)
                ))
        )
    ];

    if (totalPages > 1) {
        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(buildMenuCustomId('page', userId, page - 1))
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page <= 0),
                new ButtonBuilder()
                    .setCustomId(buildMenuCustomId('page', userId, page + 1))
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= totalPages - 1)
            )
        );
    }

    return components;
}

async function readClanRosters() {
    const payload = await rosterFirebase.readActiveRosterPayload();

    return {
        payload,
        rosters: getSelectableClanRosters(payload)
    };
}

async function editClanPickerResponse(interaction, page = 0) {
    const { rosters } = await readClanRosters();

    if (rosters.length === 0) {
        await interaction.editReply({
            content: 'No active clans are available in the roster database.',
            components: []
        });
        return;
    }

    const currentPage = clampPage(page, rosters.length);

    await interaction.editReply({
        content: 'Choose a clan to build the link list from the live Clash member list.',
        components: buildClanPickerComponents(rosters, interaction.user.id, currentPage)
    });
}

async function showLinkListPicker(interaction) {
    await interaction.deferReply({ flags: EPHEMERAL });
    await editClanPickerResponse(interaction, 0);
}

function parseSelectedRosterIndex(interaction) {
    const selected = interaction.values?.[0] || '';
    const match = selected.match(/^idx:(\d+)$/);

    return match ? Number.parseInt(match[1], 10) : -1;
}

function formatLinkListError(error) {
    const message = String(error?.message || '');
    const code = String(error?.code || '');

    if (
        code === '50013' ||
        code === '50001' ||
        /missing permissions/i.test(message) ||
        /missing access/i.test(message)
    ) {
        return 'I do not have permission to post or edit the link list in this channel.';
    }

    if (message === 'COC_API_TOKEN is missing in .env') {
        return 'The Clash API token is not configured, so I cannot read live clan members.';
    }

    if (message === 'INVALID_CLAN_TAG') {
        return 'The selected roster has an invalid clan tag.';
    }

    if (message === 'CLAN_NOT_FOUND') {
        return 'The Clash API could not find that clan tag.';
    }

    if (message === 'CLASH_API_TIMEOUT') {
        return 'The live Clash member request timed out. Please try again.';
    }

    if (message === 'CLASH_API_REQUEST_FAILED') {
        return 'The live Clash member request failed before the API returned a response.';
    }

    if (message === 'CLASH_API_INVALID_JSON' || message === 'CLASH_API_INVALID_RESPONSE') {
        return 'The Clash API returned an unexpected response for the clan member list.';
    }

    if (/^CLASH_API_HTTP_(401|403)$/.test(message)) {
        return 'The Clash API rejected the configured token.';
    }

    if (/^CLASH_API_HTTP_429$/.test(message)) {
        return 'The Clash API rate limit was reached. Please try again shortly.';
    }

    if (/^CLASH_API_HTTP_5\d\d$/.test(message)) {
        return 'The Clash API is temporarily unavailable. Please try again shortly.';
    }

    return 'Could not build the link list from the live Clash member list.';
}

async function buildMessageForRoster(guild, roster, playerMetrics, mode, clanRosters = []) {
    const clanSnapshot = await fetchClanMembers(roster.connectedClanTag);
    const rows = buildLinkListPlayerRows(
        roster,
        playerMetrics,
        clanSnapshot.members
    );
    const discordPresenceById = await buildDiscordPresenceById(guild, rows);

    return buildLinkListMessage(
        roster,
        playerMetrics,
        clanSnapshot.members,
        mode,
        {
            clanRosters,
            discordPresenceById
        }
    );
}

async function editMessageSafely(message, payload) {
    if (!message || typeof message.edit !== 'function') {
        return;
    }

    try {
        await message.edit(payload);
    } catch (error) {
        console.warn('Could not edit link-list status message:', {
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null
        });
    }
}

async function editInteractionReplySafely(interaction, payload) {
    if (!interaction || typeof interaction.editReply !== 'function') {
        return;
    }

    try {
        await interaction.editReply(payload);
    } catch (error) {
        console.warn('Could not edit link-list interaction reply:', {
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null
        });
    }
}

async function sendPublicLinkListMessage(interaction, roster, playerMetrics, clanRosters) {
    if (!interaction.channel || typeof interaction.channel.send !== 'function') {
        return false;
    }

    const placeholder = await interaction.channel.send(buildLinkListLoadingMessage(roster));

    try {
        const message = await buildMessageForRoster(
            interaction.guild,
            roster,
            playerMetrics,
            MODE_TAGS,
            clanRosters
        );

        await placeholder.edit(message);
    } catch (error) {
        await editMessageSafely(
            placeholder,
            buildLinkListErrorMessage(roster, formatLinkListError(error))
        );
        throw error;
    }

    return true;
}

async function handleClanSelect(interaction) {
    await interaction.deferUpdate();

    const selectedIndex = parseSelectedRosterIndex(interaction);
    const { payload, rosters } = await readClanRosters();
    const roster = selectedIndex >= 0 ? rosters[selectedIndex] : null;

    if (!roster) {
        await interaction.editReply({
            content: 'That clan is no longer available.',
            components: []
        });
        return;
    }

    try {
        await interaction.editReply({
            content: `Building **${getRosterTitle(roster)}** link list. This can take a few seconds.`,
            components: []
        });

        const posted = await sendPublicLinkListMessage(
            interaction,
            roster,
            payload?.playerMetrics || {},
            rosters
        );

        if (!posted) {
            await interaction.editReply({
                content: 'I could not post the link list in this channel.',
                components: []
            });
            return;
        }

        await interaction.editReply({
            content: `Posted **${getRosterTitle(roster)}** link list in this channel.`,
            components: []
        });
    } catch (error) {
        console.error('Failed to build link list:', {
            clanTag: roster?.connectedClanTag || null,
            errorName: error?.name || null,
            errorMessage: error?.message || null
        });

        await interaction.editReply({
            content: formatLinkListError(error),
            components: []
        });
    }
}

async function handleClanPage(interaction, parsed) {
    await interaction.deferUpdate();
    await editClanPickerResponse(interaction, parsed.page);
}

async function handleViewButton(interaction, parsed) {
    await interaction.deferUpdate();

    const payload = await rosterFirebase.readActiveRosterPayload();
    const clanRosters = getSelectableClanRosters(payload);
    const roster = findRosterByClanTag(payload, parsed.clanTag);

    if (!roster) {
        await interaction.followUp({
            content: 'That clan is no longer available in the roster database.',
            flags: EPHEMERAL
        });
        return;
    }

    try {
        await interaction.editReply(buildLinkListLoadingMessage(roster));

        const message = await buildMessageForRoster(
            interaction.guild,
            roster,
            payload?.playerMetrics || {},
            parsed.mode,
            clanRosters
        );

        await interaction.editReply(message);
    } catch (error) {
        console.error('Failed to update link list:', {
            clanTag: parsed.clanTag,
            errorName: error?.name || null,
            errorMessage: error?.message || null
        });

        await editInteractionReplySafely(
            interaction,
            buildLinkListErrorMessage(roster, formatLinkListError(error))
        );

        await interaction.followUp({
            content: formatLinkListError(error),
            flags: EPHEMERAL
        });
    }
}

async function handleClanSwitchSelect(interaction, parsed) {
    await interaction.deferUpdate();

    const selectedClanTag = parseLinkListClanValue(interaction.values?.[0] || '');

    if (!selectedClanTag) {
        await interaction.followUp({
            content: 'That clan selection is invalid.',
            flags: EPHEMERAL
        });
        return;
    }

    const payload = await rosterFirebase.readActiveRosterPayload();
    const clanRosters = getSelectableClanRosters(payload);
    const roster = findRosterByClanTag(payload, selectedClanTag);

    if (!roster) {
        await interaction.followUp({
            content: 'That clan is no longer available in the roster database.',
            flags: EPHEMERAL
        });
        return;
    }

    try {
        await interaction.editReply(buildLinkListLoadingMessage(roster));

        const message = await buildMessageForRoster(
            interaction.guild,
            roster,
            payload?.playerMetrics || {},
            parsed.mode,
            clanRosters
        );

        await interaction.editReply(message);
    } catch (error) {
        console.error('Failed to switch link list clan:', {
            clanTag: selectedClanTag,
            errorName: error?.name || null,
            errorMessage: error?.message || null
        });

        await editInteractionReplySafely(
            interaction,
            buildLinkListErrorMessage(roster, formatLinkListError(error))
        );

        await interaction.followUp({
            content: formatLinkListError(error),
            flags: EPHEMERAL
        });
    }
}

async function replyNotYourMenu(interaction) {
    await interaction.reply({
        content: 'This clan menu is not for you.',
        flags: EPHEMERAL
    });
}

async function handleLinkListInteraction(interaction) {
    if (!isLinkListCustomId(interaction.customId)) {
        return false;
    }

    const viewParsed = parseLinkListViewCustomId(interaction.customId);

    if (viewParsed && interaction.isButton()) {
        await handleViewButton(interaction, viewParsed);
        return true;
    }

    const refreshParsed = parseLinkListRefreshCustomId(interaction.customId);

    if (refreshParsed && interaction.isButton()) {
        await handleViewButton(interaction, refreshParsed);
        return true;
    }

    const switchParsed = parseLinkListSwitchCustomId(interaction.customId);

    if (switchParsed && interaction.isStringSelectMenu()) {
        await handleClanSwitchSelect(interaction, switchParsed);
        return true;
    }

    const menuParsed = parseMenuCustomId(interaction.customId);

    if (!menuParsed) {
        await interaction.reply({
            content: 'Unknown link-list action.',
            flags: EPHEMERAL
        });
        return true;
    }

    if (menuParsed.userId !== interaction.user.id) {
        await replyNotYourMenu(interaction);
        return true;
    }

    if (interaction.isStringSelectMenu() && menuParsed.action === 'select') {
        await handleClanSelect(interaction);
        return true;
    }

    if (interaction.isButton() && menuParsed.action === 'page') {
        await handleClanPage(interaction, menuParsed);
        return true;
    }

    await interaction.reply({
        content: 'Unsupported link-list action.',
        flags: EPHEMERAL
    });
    return true;
}

module.exports = {
    buildMenuCustomId,
    showLinkListPicker,
    formatLinkListError,
    handleLinkListInteraction
};
