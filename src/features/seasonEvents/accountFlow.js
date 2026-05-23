const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const {
    buildCustomId,
    getEventTypeConfig,
    getMaxAccountsForType
} = require('./constants');
const {
    getEventAvailabilityStatus,
    readLinkedAccountsForDiscordUser,
    readParticipantByDiscordId,
    normalizeAccount,
    normalizePlayerTag
} = require('./eventData');
const {
    EPHEMERAL,
    buildDiscordUser,
    getResultStatus,
    getSourceMessageId,
    refreshSignupMessage,
    resolveEventForMutation
} = require('./flowUtils');
const { getStatusMessage } = require('./statusMessages');

function normalizeLinkedAccounts(accounts) {
    const seen = new Set();

    return accounts
        .map(account => {
            const normalized = normalizeAccount(account);

            return {
                playerTag: normalized.tag,
                name: normalized.name,
                townHall: normalized.townHall
            };
        })
        .filter(account => {
            if (!account.playerTag || seen.has(account.playerTag)) {
                return false;
            }

            seen.add(account.playerTag);
            return true;
        })
        .slice(0, 25);
}

function buildAccountPickerComponents(type, userId, messageId, accounts, mode) {
    const maxAccounts = getMaxAccountsForType(type);

    return [
        new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('select', type, userId, messageId, mode))
                .setPlaceholder(`Choose up to ${maxAccounts} account${maxAccounts === 1 ? '' : 's'}`)
                .setMinValues(1)
                .setMaxValues(Math.max(1, Math.min(maxAccounts, accounts.length)))
                .addOptions(accounts.map(account =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(`${account.townHall ? `TH${account.townHall}` : 'TH ?'} ${account.name}`.slice(0, 100))
                        .setDescription(account.playerTag.slice(0, 100))
                        .setValue(account.playerTag)
                ))
        )
    ];
}

function buildManageComponents(type, userId, messageId) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buildCustomId('update', type, userId, messageId))
                .setLabel('Update accounts')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(buildCustomId('cancel', type, userId, messageId))
                .setLabel('Cancel signup')
                .setStyle(ButtonStyle.Danger)
        )
    ];
}

async function showAccountPicker(interaction, type, accounts, messageId, mode, content = null) {
    const normalizedAccounts = normalizeLinkedAccounts(accounts);
    const typeConfig = getEventTypeConfig(type);

    if (normalizedAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('not-linked'),
            components: []
        });
        return;
    }

    await interaction.editReply({
        content:
            content ||
            `Choose the account${getMaxAccountsForType(type) === 1 ? '' : 's'} for ${typeConfig.title}.`,
        components: buildAccountPickerComponents(
            type,
            interaction.user.id,
            messageId,
            normalizedAccounts,
            mode
        )
    });
}

function getParticipantStatus(participant) {
    return String(participant?.status || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, '_');
}

async function showManageResponse(interaction, type, messageId, result) {
    await interaction.editReply({
        content: getStatusMessage(getResultStatus(result, 'already-signed-up')),
        components: buildManageComponents(type, interaction.user.id, messageId)
    });
}

function validateSelectedTags(type, values) {
    const playerTags = values.map(normalizePlayerTag).filter(Boolean);
    const uniqueTags = [...new Set(playerTags)];

    if (uniqueTags.length !== playerTags.length) {
        return { ok: false, status: 'duplicate-player-tags' };
    }

    if (uniqueTags.length > getMaxAccountsForType(type)) {
        return { ok: false, status: 'too-many-accounts' };
    }

    return { ok: true, playerTags: uniqueTags };
}

async function handleSignupButton(interaction, parsed) {
    const messageId = interaction.message?.id || null;

    await interaction.deferReply({ flags: EPHEMERAL });

    const { event, eventId, source } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        'discord-button'
    );

    if (!event || !eventId) {
        await interaction.editReply({ content: getStatusMessage('event-not-found') });
        return;
    }

    const unavailableStatus = getEventAvailabilityStatus(event);

    if (unavailableStatus) {
        await interaction.editReply({ content: getStatusMessage(unavailableStatus) });
        return;
    }

    const discordUser = buildDiscordUser(interaction);
    const participant = await readParticipantByDiscordId(eventId, discordUser.id);

    if (getParticipantStatus(participant) === 'signed_up') {
        await showManageResponse(
            interaction,
            parsed.type,
            messageId,
            { status: 'already-signed-up' }
        );
        return;
    }

    const linkedAccounts = await readLinkedAccountsForDiscordUser(discordUser);

    if (linkedAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('not-linked'),
            components: []
        });
        return;
    }

    if (linkedAccounts.length > 1) {
        await showAccountPicker(interaction, parsed.type, linkedAccounts, messageId, 'signup');
        return;
    }

    const result = await rosterBackend.registerSeasonEventSignup({
        eventId,
        discordUser,
        playerTags: [linkedAccounts[0].playerTag],
        source
    });
    const status = getResultStatus(result, 'signed-up');

    if (status === 'already-signed-up' || status === 'accounts-differ-use-update-endpoint') {
        await showManageResponse(interaction, parsed.type, messageId, result);
        return;
    }

    if (status !== 'signed-up' && status !== 'updated') {
        await interaction.editReply({
            content: getStatusMessage(status, 'Unable to complete signup.')
        });
        return;
    }

    await refreshSignupMessage(interaction, parsed.type, { messageId });
    await interaction.editReply({
        content: getStatusMessage(status),
        components: []
    });
}

async function cancelSignup(interaction, parsed, messageId) {
    const { event, eventId, source } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        'discord-cancel'
    );

    if (!event || !eventId) {
        return 'event-not-found';
    }

    const participant = await readParticipantByDiscordId(eventId, interaction.user.id);
    const participantStatus = getParticipantStatus(participant);

    if (participantStatus === 'cancelled') {
        return 'already-cancelled';
    }

    if (participantStatus !== 'signed_up') {
        return 'not-signed-up';
    }

    const result = await rosterBackend.cancelSeasonEventSignup({
        eventId,
        discordUser: buildDiscordUser(interaction),
        source
    });

    await refreshSignupMessage(interaction, parsed.type, { messageId });
    return getResultStatus(result, 'cancelled');
}

async function handleOptOutButton(interaction, parsed) {
    await interaction.deferReply({ flags: EPHEMERAL });

    const status = await cancelSignup(interaction, parsed, interaction.message?.id || null);

    await interaction.editReply({
        content: getStatusMessage(status, 'Unable to cancel signup.')
    });
}

async function handleBoundCancelButton(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This signup action is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferUpdate();

    const status = await cancelSignup(
        interaction,
        parsed,
        getSourceMessageId(interaction, parsed)
    );

    await interaction.editReply({
        content: getStatusMessage(status, 'Unable to cancel signup.'),
        components: []
    });
}

async function handleUpdateButton(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This signup action is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferUpdate();

    const messageId = getSourceMessageId(interaction, parsed);
    const { event, eventId, source } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        'discord-account-update'
    );

    if (!event || !eventId) {
        await interaction.editReply({
            content: getStatusMessage('participant-not-active'),
            components: []
        });
        return;
    }

    const discordUser = buildDiscordUser(interaction);
    const participant = await readParticipantByDiscordId(eventId, discordUser.id);

    if (getParticipantStatus(participant) !== 'signed_up') {
        await interaction.editReply({
            content: getStatusMessage('participant-not-active'),
            components: []
        });
        return;
    }

    const linkedAccounts = await readLinkedAccountsForDiscordUser(discordUser);

    await showAccountPicker(
        interaction,
        parsed.type,
        linkedAccounts,
        messageId,
        'update',
        `Choose the account${getMaxAccountsForType(parsed.type) === 1 ? '' : 's'} to use for this event.`
    );
}

async function handleAccountSelect(interaction, parsed) {
    if (parsed.userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This account menu is not for you.',
            flags: EPHEMERAL
        });
        return;
    }

    const validation = validateSelectedTags(parsed.type, interaction.values || []);

    if (!validation.ok) {
        await interaction.reply({
            content: getStatusMessage(validation.status),
            flags: EPHEMERAL
        });
        return;
    }

    await interaction.deferUpdate();

    const messageId = getSourceMessageId(interaction, parsed);
    const { event, eventId, source } = await resolveEventForMutation(
        interaction,
        parsed.type,
        messageId,
        parsed.mode === 'update' ? 'discord-account-update' : 'discord-button'
    );

    if (!event || !eventId) {
        await interaction.editReply({
            content: getStatusMessage('event-not-found'),
            components: []
        });
        return;
    }

    const unavailableStatus = parsed.mode === 'update'
        ? null
        : getEventAvailabilityStatus(event);

    if (unavailableStatus) {
        await interaction.editReply({
            content: getStatusMessage(unavailableStatus),
            components: []
        });
        return;
    }

    const discordUser = buildDiscordUser(interaction);
    const linkedAccounts = normalizeLinkedAccounts(
        await readLinkedAccountsForDiscordUser(discordUser)
    );
    const linkedTags = new Set(linkedAccounts.map(account => account.playerTag));
    const hasUnlinkedTag = validation.playerTags.some(tag => !linkedTags.has(tag));

    if (hasUnlinkedTag) {
        await interaction.editReply({
            content: getStatusMessage('player-tag-not-linked'),
            components: []
        });
        return;
    }

    if (parsed.mode === 'update') {
        const participant = await readParticipantByDiscordId(eventId, discordUser.id);

        if (getParticipantStatus(participant) !== 'signed_up') {
            await interaction.editReply({
                content: getStatusMessage('participant-not-active'),
                components: []
            });
            return;
        }
    }

    const payload = {
        eventId,
        discordUser,
        playerTags: validation.playerTags,
        source
    };
    const result = parsed.mode === 'update'
        ? await rosterBackend.updateSeasonEventParticipantAccounts(payload)
        : await rosterBackend.registerSeasonEventSignup(payload);
    const status = getResultStatus(
        result,
        parsed.mode === 'update' ? 'updated' : 'signed-up'
    );

    if (status === 'already-signed-up' || status === 'accounts-differ-use-update-endpoint') {
        await showManageResponse(interaction, parsed.type, messageId, result);
        return;
    }

    await refreshSignupMessage(interaction, parsed.type, { messageId });
    await interaction.editReply({
        content: getStatusMessage(status),
        components: []
    });
}

module.exports = {
    handleSignupButton,
    handleOptOutButton,
    handleBoundCancelButton,
    handleUpdateButton,
    handleAccountSelect
};
