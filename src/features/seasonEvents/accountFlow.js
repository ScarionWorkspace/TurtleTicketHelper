const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const {
    buildCustomId,
    getEventTypeConfig,
    getMaxAccountsForType
} = require('./constants');
const {
    getEventAvailabilityStatus,
    isCwlEventTargetResolved,
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

async function refreshSignupMessageAfterMutationBestEffort(interaction, type, options) {
    try {
        return await refreshSignupMessage(interaction, type, options);
    } catch (error) {
        console.warn('Season event mutation succeeded but signup message refresh failed.', {
            eventType: type,
            eventId: options?.seedEvent?.eventId || options?.seedEvent?.id || null,
            errorName: error?.name || null,
            errorMessage: error?.message || null
        });
        return false;
    }
}

function invalidateSeasonEventReads(eventId, type) {
    if (eventId) {
        const encoded = rosterPublicData.encodePublicDataObjectKey(eventId);
        rosterPublicData.invalidateReadCachePrefix(`events/seasonEvents/byId/${encoded}`);
        rosterPublicData.invalidateReadCachePrefix(`events/seasonEvents/cwlAggregates/byEvent/${encoded}`);
    }
    rosterPublicData.invalidateReadCachePath(type === 'cwl' ? 'events/seasonEvents/currentCwl' : 'events/seasonEvents/current');
    rosterPublicData.invalidateReadCachePath('bootstrap/current');
}

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

    const { event, eventId, source, context } = await resolveEventForMutation(
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

    if (parsed.type === 'cwl' && !isCwlEventTargetResolved(event)) {
        await interaction.editReply({ content: getStatusMessage('cwl-target-unresolved') });
        return;
    }

    const discordUser = buildDiscordUser(interaction);
    const participant = context.participant;

    if (getParticipantStatus(participant) === 'signed_up') {
        await showManageResponse(
            interaction,
            parsed.type,
            messageId,
            { status: 'already-signed-up' }
        );
        return;
    }

    const linkedAccounts = context.linkedAccounts;
    const eligibleAccounts = context.eligibleAccounts;

    if (linkedAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('not-linked'),
            components: []
        });
        return;
    }

    if (eligibleAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('accounts-outside-event-roster'),
            components: []
        });
        return;
    }

    if (eligibleAccounts.length > 1) {
        await showAccountPicker(interaction, parsed.type, eligibleAccounts, messageId, 'signup');
        return;
    }

    const result = await rosterBackend.registerSeasonEventSignup({
        eventId,
        discordUser,
        playerTags: [normalizeAccount(eligibleAccounts[0]).tag],
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

    invalidateSeasonEventReads(eventId, parsed.type);
    await refreshSignupMessageAfterMutationBestEffort(interaction, parsed.type, { messageId, seedEvent: result?.event || event });
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

    const result = await rosterBackend.cancelSeasonEventSignup({
        eventId,
        discordUser: buildDiscordUser(interaction),
        source
    });

    invalidateSeasonEventReads(eventId, parsed.type);
    await refreshSignupMessageAfterMutationBestEffort(interaction, parsed.type, { messageId, seedEvent: result?.event || event });
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
    const { event, eventId, source, context } = await resolveEventForMutation(
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
    const participant = context.participant;

    if (getParticipantStatus(participant) !== 'signed_up') {
        await interaction.editReply({
            content: getStatusMessage('participant-not-active'),
            components: []
        });
        return;
    }

    const linkedAccounts = context.linkedAccounts;
    const eligibleAccounts = context.eligibleAccounts;

    if (parsed.type === 'cwl' && !isCwlEventTargetResolved(event)) {
        await interaction.editReply({
            content: getStatusMessage('cwl-target-unresolved'),
            components: buildManageComponents(parsed.type, interaction.user.id, messageId)
        });
        return;
    }

    if (linkedAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('not-linked'),
            components: buildManageComponents(parsed.type, interaction.user.id, messageId)
        });
        return;
    }

    if (linkedAccounts.length > 0 && eligibleAccounts.length === 0) {
        await interaction.editReply({
            content: getStatusMessage('accounts-outside-event-roster'),
            components: buildManageComponents(parsed.type, interaction.user.id, messageId)
        });
        return;
    }

    await showAccountPicker(
        interaction,
        parsed.type,
        eligibleAccounts,
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
    const { event, eventId, source, context } = await resolveEventForMutation(
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
    const linkedAccounts = normalizeLinkedAccounts(context.linkedAccounts);
    const eligibleAccounts = normalizeLinkedAccounts(context.eligibleAccounts);
    const linkedTags = new Set(linkedAccounts.map(account => account.playerTag));
    const eligibleTags = new Set(eligibleAccounts.map(account => account.playerTag));
    const hasUnlinkedTag = validation.playerTags.some(tag => !linkedTags.has(tag));
    const hasOutsideRosterTag = validation.playerTags.some(tag => linkedTags.has(tag) && !eligibleTags.has(tag));

    if (hasUnlinkedTag) {
        await interaction.editReply({
            content: getStatusMessage('player-tag-not-linked'),
            components: []
        });
        return;
    }

    if (parsed.type === 'cwl' && !isCwlEventTargetResolved(event)) {
        await interaction.editReply({
            content: getStatusMessage('cwl-target-unresolved'),
            components: parsed.mode === 'update' ? buildManageComponents(parsed.type, interaction.user.id, messageId) : []
        });
        return;
    }

    if (hasOutsideRosterTag) {
        await interaction.editReply({
            content: getStatusMessage('player-tag-outside-event-roster'),
            components: parsed.mode === 'update' ? buildManageComponents(parsed.type, interaction.user.id, messageId) : []
        });
        return;
    }

    if (parsed.mode === 'update') {
        const participant = context.participant;

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

    invalidateSeasonEventReads(eventId, parsed.type);
    await refreshSignupMessageAfterMutationBestEffort(interaction, parsed.type, { messageId, seedEvent: result?.event || event });
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
