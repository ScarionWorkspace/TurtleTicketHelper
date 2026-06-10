const {
    ActionRowBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const appConfig = require('../../config/appConfig');
const { buildCustomId } = require('./constants');
const {
    extractLeaderboardRows,
    getActiveParticipants,
    loadEventForRendering
} = require('./eventData');
const { buildInteractionSource } = require('./interactionSource');
const { isSeasonEventAdmin } = require('./permissions');
const { getStatusMessage } = require('./statusMessages');
const {
    EPHEMERAL,
    getResultStatus,
    getSourceMessageId,
    refreshSignupMessage,
    resolveEventForMutation
} = require('./flowUtils');

const ADMIN_ACTIONS = [
    ['Open signups', 'open_signups', 'Allow signups for the current event.'],
    ['Close signups', 'close_signups', 'Stop new signup changes.'],
    ['Close event', 'close_event', 'Set the event status to closed.'],
    ['Archive event', 'archive_event', 'Set the event status to archived.'],
    ['Refresh message', 'refresh_message', 'Re-render the signup message.'],
    ['Show event status', 'show_status', 'Show the current event state.'],
    ['Show leaderboard', 'show_leaderboard', 'Show compact leaderboard rows.'],
    ['Edit title', 'edit_title', 'Update the public event title.'],
    ['Edit info', 'edit_info', 'Update the public signup info text.']
];

function buildAdminOptionsRow(type, userId, messageId) {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(buildCustomId('admin', type, userId, messageId))
            .setPlaceholder('Choose an event action')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                ADMIN_ACTIONS.map(([label, value, description]) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(label)
                        .setDescription(description)
                        .setValue(value)
                )
            )
    );
}

function getPatchForAdminAction(action) {
    switch (action) {
        case 'open_signups':
            return { signupsOpen: true };
        case 'close_signups':
            return { signupsOpen: false };
        case 'close_event':
            return { status: 'closed', signupsOpen: false };
        case 'archive_event':
            return { status: 'archived', signupsOpen: false };
        default:
            return null;
    }
}

function formatEventStatus(event) {
    const activeCount = getActiveParticipants(event).length ||
        event?.confirmedCount ||
        event?.participantCount ||
        event?.signupCount ||
        0;

    return [
        `Title: ${event?.title || 'Untitled event'}`,
        `Status: ${event?.status || 'unknown'}`,
        `Visibility: ${event?.visibility || 'default'}`,
        `Signups open: ${event?.signupsOpen === false ? 'no' : 'yes'}`,
        `Confirmed: ${activeCount}`
    ].join('\n');
}

function truncatePlaceholder(value, maxLength = 100) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function getInfoPlaceholder(type) {
    const configured = appConfig.seasonEvents?.infoMessages?.[type];
    return truncatePlaceholder(configured || 'Public signup info message');
}

function getLeaderboardScoreLabel(row, type) {
    const explicit =
        row?.scoreLabel ||
        row?.metricLabel ||
        row?.displayScore ||
        row?.scoreText ||
        null;

    if (explicit) {
        return String(explicit);
    }

    if (type === 'push') {
        const leagueLabel =
            row?.currentLeagueLabel ||
            row?.currentLeagueName ||
            row?.leagueName ||
            row?.leagueLabel ||
            '';
        const trophies = row?.currentTrophies ?? row?.score ?? row?.value ?? null;

        if (trophies !== null && trophies !== undefined && trophies !== '') {
            return leagueLabel ? `${leagueLabel} - ${trophies} trophies` : `${trophies} trophies`;
        }
    }

    return row?.score ??
        row?.metric ??
        row?.value ??
        'pending';
}

function formatLeaderboardRows(leaderboard, type) {
    const rows = extractLeaderboardRows(leaderboard)
        .slice(0, appConfig.seasonEvents?.maxLeaderboardRows || 10);

    if (rows.length === 0) {
        return 'No leaderboard rows are available yet.';
    }

    return rows.map((row, index) => {
        const score = getLeaderboardScoreLabel(row, type);
        const name =
            row?.displayName ||
            row?.playerName ||
            row?.name ||
            row?.accountName ||
            row?.account?.name ||
            'Unknown';
        const tag =
            row?.playerTag ||
            row?.tag ||
            row?.accountTag ||
            row?.account?.tag ||
            row?.accounts?.[0]?.tag ||
            '';
        const rank = row?.rank || index + 1;

        return `${rank}. ${score} - ${name}${tag ? ` (${tag})` : ''}`;
    }).join('\n');
}

async function updateCurrentEvent(interaction, parsed, patch) {
    const messageId = getSourceMessageId(interaction, parsed);
    const { event, eventId, source } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        'discord-admin'
    );

    if (!event || !eventId) {
        return 'event-not-found';
    }

    const result = await rosterBackend.updateSeasonEvent({
        eventId,
        patch,
        source
    });

    await refreshSignupMessage(interaction, parsed.type, {
        reconcile: true,
        messageId,
        sourceType: 'discord-admin'
    });

    return getResultStatus(result, 'updated');
}

async function handleOptionsButton(interaction, parsed) {
    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This event menu is staff only.',
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.reply({
        content: 'Season event options:',
        components: [
            buildAdminOptionsRow(parsed.type, interaction.user.id, interaction.message?.id)
        ],
        flags: EPHEMERAL
    });
}

async function handleAdminShowStatus(interaction, parsed) {
    const messageId = getSourceMessageId(interaction, parsed);
    const { event } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        'discord-admin'
    );

    await interaction.editReply({
        content: event
            ? `\`\`\`text\n${formatEventStatus(event)}\n\`\`\``
            : getStatusMessage('event-not-found'),
        components: []
    });
}

async function handleAdminShowLeaderboard(interaction, parsed) {
    const messageId = getSourceMessageId(interaction, parsed);
    const source = buildInteractionSource(
        interaction,
        parsed.type,
        messageId,
        'discord-admin'
    );
    const { leaderboard } = await loadEventForRendering(parsed.type, { source });

    await interaction.editReply({
        content: `\`\`\`text\n${formatLeaderboardRows(leaderboard, parsed.type)}\n\`\`\``,
        components: []
    });
}

async function showTitleModal(interaction, parsed) {
    const modal = new ModalBuilder()
        .setCustomId(buildCustomId(
            'title',
            parsed.type,
            interaction.user.id,
            getSourceMessageId(interaction, parsed)
        ))
        .setTitle('Edit event title');
    const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Event title')
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80);

    modal.addComponents(new ActionRowBuilder().addComponents(titleInput));
    await interaction.showModal(modal);
}

async function showInfoModal(interaction, parsed) {
    const modal = new ModalBuilder()
        .setCustomId(buildCustomId(
            'info',
            parsed.type,
            interaction.user.id,
            getSourceMessageId(interaction, parsed)
        ))
        .setTitle('Edit signup info');
    const infoInput = new TextInputBuilder()
        .setCustomId('info')
        .setLabel('Signup info message')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(900)
        .setPlaceholder(getInfoPlaceholder(parsed.type));

    modal.addComponents(new ActionRowBuilder().addComponents(infoInput));
    await interaction.showModal(modal);
}

async function handleAdminSelect(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This event menu is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This event menu is staff only.',
            flags: EPHEMERAL
        });
        return;
    }

    const action = interaction.values?.[0];

    if (action === 'edit_title') {
        await showTitleModal(interaction, parsed);
        return;
    }

    if (action === 'edit_info') {
        await showInfoModal(interaction, parsed);
        return;
    }

    await interaction.deferUpdate();

    if (action === 'refresh_message') {
        await refreshSignupMessage(interaction, parsed.type, {
            reconcile: true,
            messageId: getSourceMessageId(interaction, parsed),
            sourceType: 'discord-admin'
        });
        await interaction.editReply({
            content: 'Signup message refreshed.',
            components: []
        });
        return;
    }

    if (action === 'show_status') {
        await handleAdminShowStatus(interaction, parsed);
        return;
    }

    if (action === 'show_leaderboard') {
        await handleAdminShowLeaderboard(interaction, parsed);
        return;
    }

    const patch = getPatchForAdminAction(action);

    if (!patch) {
        await interaction.editReply({
            content: 'Unsupported event option.',
            components: []
        });
        return;
    }

    const status = await updateCurrentEvent(interaction, parsed, patch);

    await interaction.editReply({
        content: getStatusMessage(status, 'Event updated.'),
        components: []
    });
}

async function handleTitleModal(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This title form is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This title form is staff only.',
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferReply({ flags: EPHEMERAL });

    const title = interaction.fields.getTextInputValue('title').trim();

    if (!title) {
        await interaction.editReply({ content: 'Please provide a title.' });
        return;
    }

    const status = await updateCurrentEvent(interaction, parsed, { title });

    await interaction.editReply({
        content: getStatusMessage(status, 'Event title updated.')
    });
}

async function handleInfoModal(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This info form is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This info form is staff only.',
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferReply({ flags: EPHEMERAL });

    const description = interaction.fields.getTextInputValue('info').trim();
    const status = await updateCurrentEvent(interaction, parsed, { description });

    await interaction.editReply({
        content: getStatusMessage(status, description ? 'Event info updated.' : 'Event info cleared.')
    });
}

module.exports = {
    handleOptionsButton,
    handleAdminSelect,
    handleTitleModal,
    handleInfoModal
};
