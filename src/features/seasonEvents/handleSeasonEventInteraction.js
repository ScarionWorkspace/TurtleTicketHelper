const {
    isSeasonEventCustomId,
    parseCustomId
} = require('./constants');
const { isSeasonEventAdmin } = require('./permissions');
const {
    handleAccountSelect,
    handleBoundCancelButton,
    handleOptOutButton,
    handleSignupButton,
    handleUpdateButton
} = require('./accountFlow');
const {
    handleAdminSelect,
    handleOptionsButton,
    handleTitleModal
} = require('./adminFlow');
const {
    EPHEMERAL,
    refreshSignupMessage
} = require('./flowUtils');

async function replyOnce(interaction, content) {
    if (!interaction.replied && !interaction.deferred && interaction.isRepliable?.()) {
        await interaction.reply({
            content,
            flags: EPHEMERAL
        });
    }
}

async function handleRefreshButton(interaction, parsed) {
    const isAdmin = isSeasonEventAdmin(interaction.member);

    await interaction.deferUpdate();
    await refreshSignupMessage(interaction, parsed.type, {
        reconcile: isAdmin,
        messageId: interaction.message?.id,
        sourceType: isAdmin ? 'discord-admin' : 'discord-refresh'
    });
}

async function dispatchSeasonEventInteraction(interaction, parsed) {
    if (interaction.isButton()) {
        switch (parsed.action) {
            case 'refresh':
                return handleRefreshButton(interaction, parsed);
            case 'signup':
                return handleSignupButton(interaction, parsed);
            case 'optout':
                return handleOptOutButton(interaction, parsed);
            case 'options':
                return handleOptionsButton(interaction, parsed);
            case 'update':
                return handleUpdateButton(interaction, parsed);
            case 'cancel':
                return handleBoundCancelButton(interaction, parsed);
            default:
                return replyOnce(interaction, 'Unsupported season event action.');
        }
    }

    if (interaction.isStringSelectMenu()) {
        switch (parsed.action) {
            case 'select':
                return handleAccountSelect(interaction, parsed);
            case 'admin':
                return handleAdminSelect(interaction, parsed);
            default:
                return replyOnce(interaction, 'Unsupported season event menu.');
        }
    }

    if (interaction.isModalSubmit() && parsed.action === 'title') {
        return handleTitleModal(interaction, parsed);
    }

    return replyOnce(interaction, 'Unsupported season event interaction.');
}

async function handleSeasonEventInteraction(interaction) {
    if (!isSeasonEventCustomId(interaction.customId)) {
        return false;
    }

    const parsed = parseCustomId(interaction.customId);

    if (!parsed) {
        await replyOnce(interaction, 'Unknown season event action.');
        return true;
    }

    try {
        await dispatchSeasonEventInteraction(interaction, parsed);
    } catch (error) {
        console.error('Season event interaction failed:', {
            action: parsed.action,
            type: parsed.type,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });

        const response = {
            content: 'Season event action failed. Please try again later.',
            components: [],
            flags: EPHEMERAL
        };

        if (interaction.deferred || interaction.replied) {
            await interaction.followUp(response).catch(() => null);
        } else if (interaction.isRepliable?.()) {
            await interaction.reply(response).catch(() => null);
        }
    }

    return true;
}

module.exports = handleSeasonEventInteraction;
