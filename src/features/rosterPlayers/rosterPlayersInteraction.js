const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const {
    PLAYER_LIST_MAX_CHARS,
    getOrderedRosters,
    formatRawRosterPlayerLines,
    chunkLines
} = require('./rosterPlayersData');
const { buildRosterPlayerMessages } = require('./rosterPlayersMessage');

const EPHEMERAL = 64;
const CUSTOM_ID_PREFIX = 'roster_players:v1';
const ROSTERS_PER_PAGE = 25;
const MODE_PUBLIC_EMBED = 'embed';
const MODE_RAW = 'raw';

function normalizeMode(mode) {
    return mode === MODE_RAW ? MODE_RAW : MODE_PUBLIC_EMBED;
}

function buildCustomId(action, userId, page = 0, mode = MODE_PUBLIC_EMBED) {
    return `${CUSTOM_ID_PREFIX}:${action}:${userId}:${page}:${normalizeMode(mode)}`;
}

function isRosterPlayersCustomId(customId) {
    return String(customId || '').startsWith(`${CUSTOM_ID_PREFIX}:`);
}

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'roster_players' || parts[1] !== 'v1') {
        return null;
    }

    const page = Number.parseInt(parts[4] || '0', 10);

    return {
        action: parts[2] || null,
        userId: parts[3] || null,
        page: Number.isFinite(page) && page >= 0 ? page : 0,
        mode: normalizeMode(parts[5])
    };
}

function truncateOptionText(value, fallback) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    const safeText = text || fallback || 'Roster';

    return safeText.length <= 100 ? safeText : `${safeText.slice(0, 97)}...`;
}

function getTotalPages(rosterCount) {
    return Math.max(1, Math.ceil(rosterCount / ROSTERS_PER_PAGE));
}

function clampPage(page, rosterCount) {
    return Math.min(Math.max(page, 0), getTotalPages(rosterCount) - 1);
}

function buildRosterSelectOption(roster, index) {
    const title = roster.title || roster.id || `Roster ${index + 1}`;

    return new StringSelectMenuOptionBuilder()
        .setLabel(truncateOptionText(title, `Roster ${index + 1}`))
        .setValue(`idx:${index}`);
}

function buildRosterPickerComponents(rosters, userId, page, mode = MODE_PUBLIC_EMBED) {
    const start = page * ROSTERS_PER_PAGE;
    const pageRosters = rosters.slice(start, start + ROSTERS_PER_PAGE);
    const totalPages = getTotalPages(rosters.length);
    const components = [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('select', userId, page, mode))
                .setPlaceholder(
                    totalPages > 1
                        ? `Choose a roster (${page + 1}/${totalPages})`
                        : 'Choose a roster'
                )
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(pageRosters.map((roster, offset) =>
                    buildRosterSelectOption(roster, start + offset)
                ))
        )
    ];

    if (totalPages > 1) {
        components.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(buildCustomId('page', userId, page - 1, mode))
                    .setLabel('Previous')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page <= 0),
                new ButtonBuilder()
                    .setCustomId(buildCustomId('page', userId, page + 1, mode))
                    .setLabel('Next')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(page >= totalPages - 1)
            )
        );
    }

    return components;
}

async function readOrderedRosters() {
    const payload = await rosterPublicData.readActiveRosterPayload();

    return {
        payload,
        rosters: getOrderedRosters(payload)
    };
}

async function editRosterPickerResponse(interaction, page = 0, mode = MODE_PUBLIC_EMBED) {
    const { rosters } = await readOrderedRosters();

    if (rosters.length === 0) {
        await interaction.editReply({
            content: 'No active rosters are available.',
            components: []
        });
        return;
    }

    const currentPage = clampPage(page, rosters.length);

    await interaction.editReply({
        content: 'Choose a roster to list players.',
        components: buildRosterPickerComponents(
            rosters,
            interaction.user.id,
            currentPage,
            mode
        )
    });
}

async function showRosterPicker(interaction, options = {}) {
    await interaction.deferReply({ flags: EPHEMERAL });
    await editRosterPickerResponse(interaction, 0, normalizeMode(options.mode));
}

function parseSelectedRosterIndex(interaction) {
    const selected = interaction.values?.[0] || '';
    const match = selected.match(/^idx:(\d+)$/);

    return match ? Number.parseInt(match[1], 10) : -1;
}

function getRosterTitle(roster) {
    return String(roster?.title || roster?.id || 'Roster').trim() || 'Roster';
}

async function sendPublicRosterMessages(interaction, roster, playerMetrics) {
    if (!interaction.channel || typeof interaction.channel.send !== 'function') {
        return false;
    }

    const messages = buildRosterPlayerMessages(roster, playerMetrics);

    for (const message of messages) {
        await interaction.channel.send(message);
    }

    return true;
}

async function showPrivateRawRosterList(interaction, roster, playerMetrics) {
    const lines = formatRawRosterPlayerLines(roster, playerMetrics);

    if (lines.length === 0) {
        await interaction.editReply({
            content: 'No players are listed for this roster.',
            components: []
        });
        return;
    }

    const chunks = chunkLines(lines, PLAYER_LIST_MAX_CHARS);

    await interaction.editReply({
        content: chunks[0],
        components: []
    });

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({
            content: chunk,
            flags: EPHEMERAL
        });
    }
}

async function handleRosterSelect(interaction, parsed) {
    await interaction.deferUpdate();

    const selectedIndex = parseSelectedRosterIndex(interaction);
    const { payload, rosters } = await readOrderedRosters();
    const roster = selectedIndex >= 0 ? rosters[selectedIndex] : null;
    const playerMetrics = payload?.playerMetrics || {};

    if (!roster) {
        await interaction.editReply({
            content: 'That roster is no longer available.',
            components: []
        });
        return;
    }

    if (parsed.mode === MODE_RAW) {
        await showPrivateRawRosterList(interaction, roster, playerMetrics);
        return;
    }

    const posted = await sendPublicRosterMessages(
        interaction,
        roster,
        playerMetrics
    );

    if (!posted) {
        await interaction.editReply({
            content: 'I could not post the roster in this channel.',
            components: []
        });
        return;
    }

    await interaction.editReply({
        content: `Posted **${getRosterTitle(roster)}** in this channel.`,
        components: []
    });
}

async function handleRosterPage(interaction, parsed) {
    await interaction.deferUpdate();
    await editRosterPickerResponse(interaction, parsed.page, parsed.mode);
}

async function replyNotYourMenu(interaction) {
    await interaction.reply({
        content: 'This roster menu is not for you.',
        flags: EPHEMERAL
    });
}

async function handleRosterPlayersInteraction(interaction) {
    if (!isRosterPlayersCustomId(interaction.customId)) {
        return false;
    }

    const parsed = parseCustomId(interaction.customId);

    if (!parsed) {
        await interaction.reply({
            content: 'Unknown roster action.',
            flags: EPHEMERAL
        });
        return true;
    }

    if (parsed.userId !== interaction.user.id) {
        await replyNotYourMenu(interaction);
        return true;
    }

    if (interaction.isStringSelectMenu() && parsed.action === 'select') {
        await handleRosterSelect(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'page') {
        await handleRosterPage(interaction, parsed);
        return true;
    }

    await interaction.reply({
        content: 'Unsupported roster action.',
        flags: EPHEMERAL
    });
    return true;
}

module.exports = {
    CUSTOM_ID_PREFIX,
    buildCustomId,
    showRosterPicker,
    handleRosterPlayersInteraction
};
