const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const { isStaffMember } = require('../permissions/staffPermissions');

const EPHEMERAL_FLAGS = 64;

function invalidateLinkedAccountReads() {
    rosterPublicData.invalidateReadCachePrefix('indexes/linkedAccountsByDiscordId');
    rosterPublicData.invalidateReadCachePrefix('indexes/linkedAccountsByDiscordUsername');
    rosterPublicData.invalidateReadCachePrefix('active/playerMetrics/byTag');
    rosterPublicData.invalidateReadCachePath('active');
    rosterPublicData.invalidateReadCachePath('bootstrap/current');
}

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned.replace(/O/g, '0');
}

function formatDiscordUser(user) {
    const id = String(user?.id || '').trim();
    return id ? `<@${id}>` : 'that Discord user';
}

function getDiscordUsername(user) {
    return String(user?.username || user?.tag || '').trim();
}

async function sendEphemeral(interaction, content) {
    const payload = {
        content,
        flags: EPHEMERAL_FLAGS
    };

    if (interaction.deferred) {
        await interaction.editReply({ content });
        return;
    }

    if (interaction.replied) {
        await interaction.followUp(payload);
        return;
    }

    await interaction.reply(payload);
}

function getBackendErrorMessage(error) {
    return String(error?.message || '').trim();
}

function isBackendConfigMissing(error) {
    return error?.code === 'ROSTER_BACKEND_CONFIG_MISSING' ||
        /backend configuration is missing/i.test(getBackendErrorMessage(error));
}

function isInvalidTagError(error) {
    return error?.code === 'INVALID_PLAYER_TAG' ||
        /invalid player tag/i.test(getBackendErrorMessage(error));
}

function isPlayerNotFoundError(error) {
    return error?.code === 'PLAYER_NOT_FOUND' ||
        /player not found|resource not found/i.test(getBackendErrorMessage(error));
}

function isConflictError(error) {
    return error?.code === 'DISCORD_LINK_CONFLICT' ||
        /already linked|conflict/i.test(getBackendErrorMessage(error));
}

function isMissingLinkError(error) {
    return error?.code === 'DISCORD_LINK_MISSING' ||
        /no backend discord link|missing link/i.test(getBackendErrorMessage(error));
}

function isInvalidBackendResponseError(error) {
    const message = getBackendErrorMessage(error);
    return error?.code === 'INVALID_JSON' ||
        /invalid json|html response|<!doctype|<html[\s>]/i.test(message);
}

function mapRosterLinkError(error, context = {}) {
    const action = context.action === 'delete' ? 'delete that link' : 'save that link';
    const tag = normalizePlayerTag(context.playerTag);
    const message = getBackendErrorMessage(error);

    if (isBackendConfigMissing(error)) {
        return 'Roster backend configuration is missing. Set `ROSTER_BACKEND_URL` and `ROSTER_BOT_SECRET`, then try again.';
    }

    if (isInvalidTagError(error)) {
        return 'Invalid player tag. Use a valid Clash player tag, with or without `#`.';
    }

    if (isPlayerNotFoundError(error)) {
        return tag
            ? `Player not found for ${tag}. Check the tag and try again.`
            : 'Player not found. Check the tag and try again.';
    }

    if (isConflictError(error)) {
        return `Conflict: ${message || 'that Discord user or player is already linked.'} Use \`force:true\` to overwrite existing links.`;
    }

    if (isMissingLinkError(error)) {
        return 'No backend link was found for that lookup.';
    }

    if (isInvalidBackendResponseError(error)) {
        return 'Roster backend returned a non-JSON response. Check the deployed backend URL and backend logs, then try again.';
    }

    if (error?.code === 'PLAYER_LOOKUP_FAILED') {
        return `The backend could not verify that Clash player: ${message || 'player lookup failed'}.`;
    }

    if (message) {
        return `Roster backend failure: could not ${action}: ${message}`;
    }

    return `Roster backend failure: could not ${action}.`;
}

function assertGuildAndStaff(interaction, staffCheck) {
    if (!interaction.guildId) {
        return 'Use this command in a server.';
    }

    if (!staffCheck(interaction.member)) {
        return 'Missing permission: this command is staff only.';
    }

    return '';
}

function assertBackendConfigured(backend) {
    return backend.isRosterBackendConfigured()
        ? ''
        : 'Roster backend configuration is missing. Set `ROSTER_BACKEND_URL` and `ROSTER_BOT_SECRET`, then try again.';
}

function buildLinkSuccessMessage(result, user, playerTag) {
    const tag = normalizePlayerTag(result?.tag || playerTag);
    const playerName = String(result?.playerName || result?.name || '').trim();
    const playerLabel = playerName && tag ? `${playerName} (${tag})` : (tag || 'that player');
    if (result?.alreadyLinked === true) {
        return `${playerLabel} is already linked to ${formatDiscordUser(user)}.`;
    }

    const resolvedCount = Number(result?.conflictsResolvedCount) || 0;
    const resolvedText = resolvedCount > 0
        ? ` Resolved ${resolvedCount} conflicting link${resolvedCount === 1 ? '' : 's'}.`
        : '';

    return `Linked ${formatDiscordUser(user)} to ${playerLabel}.${resolvedText}`;
}

function buildDeleteSuccessMessage(result, user, playerTag) {
    const removedLinks = Array.isArray(result?.removedLinks) ? result.removedLinks : [];
    const removedTags = (Array.isArray(result?.removedPlayerTags) ? result.removedPlayerTags : [])
        .map(normalizePlayerTag)
        .filter(Boolean);
    const tags = removedTags.length
        ? removedTags
        : removedLinks.map(link => normalizePlayerTag(link?.tag || link?.playerTag)).filter(Boolean);
    const uniqueTags = [...new Set(tags)];
    const count = Number(result?.deletedCount) || uniqueTags.length || 1;

    if (user) {
        const tagText = uniqueTags.length ? `: ${uniqueTags.join(', ')}` : '.';
        return `Deleted ${count} backend link${count === 1 ? '' : 's'} for ${formatDiscordUser(user)}${tagText}`;
    }

    const tag = normalizePlayerTag(playerTag || uniqueTags[0] || result?.tag);
    const removedId = String(result?.removedDiscordId || removedLinks[0]?.discordId || '').trim();
    const removedUsername = String(result?.removedDiscordUsername || removedLinks[0]?.discordUsername || '').trim();
    const removedUserText = removedId
        ? ` Removed <@${removedId}>.`
        : removedUsername
            ? ` Removed ${removedUsername}.`
            : '';

    return `Deleted backend link for ${tag || 'that player'}.${removedUserText}`;
}

async function handleLinkCommand(interaction, options = {}) {
    const backend = options.rosterBackend || rosterBackend;
    const staffCheck = options.isStaffMember || isStaffMember;
    const guardError = assertGuildAndStaff(interaction, staffCheck) || assertBackendConfigured(backend);

    if (guardError) {
        await sendEphemeral(interaction, guardError);
        return;
    }

    const user = interaction.options.getUser('user', true);
    const playerTag = normalizePlayerTag(interaction.options.getString('player_tag', true));
    const force = interaction.options.getBoolean('force') === true;

    await interaction.deferReply({ flags: EPHEMERAL_FLAGS });

    try {
        const result = await backend.linkDiscordIdentityForPlayerTag({
            playerTag,
            discordId: String(user?.id || '').trim(),
            discordUsername: getDiscordUsername(user),
            force
        });

        invalidateLinkedAccountReads();
        await interaction.editReply({
            content: buildLinkSuccessMessage(result, user, playerTag)
        });
    } catch (error) {
        await interaction.editReply({
            content: mapRosterLinkError(error, {
                action: 'link',
                playerTag
            })
        });
    }
}

async function handleLinkDeleteCommand(interaction, options = {}) {
    const backend = options.rosterBackend || rosterBackend;
    const staffCheck = options.isStaffMember || isStaffMember;
    const guardError = assertGuildAndStaff(interaction, staffCheck) || assertBackendConfigured(backend);

    if (guardError) {
        await sendEphemeral(interaction, guardError);
        return;
    }

    const user = interaction.options.getUser('user', false);
    const rawPlayerTag = interaction.options.getString('player_tag', false);
    const hasUser = Boolean(user);
    const hasPlayerTag = Boolean(String(rawPlayerTag || '').trim());

    if (hasUser === hasPlayerTag) {
        await sendEphemeral(interaction, 'Provide exactly one of `user` or `player_tag`.');
        return;
    }

    const playerTag = hasPlayerTag ? normalizePlayerTag(rawPlayerTag) : '';

    await interaction.deferReply({ flags: EPHEMERAL_FLAGS });

    try {
        const result = await backend.deleteDiscordIdentityLink({
            playerTag,
            discordId: hasUser ? String(user?.id || '').trim() : '',
            discordUsername: hasUser ? getDiscordUsername(user) : ''
        });

        invalidateLinkedAccountReads();
        await interaction.editReply({
            content: buildDeleteSuccessMessage(result, user, playerTag)
        });
    } catch (error) {
        await interaction.editReply({
            content: mapRosterLinkError(error, {
                action: 'delete',
                playerTag
            })
        });
    }
}

module.exports = {
    buildDeleteSuccessMessage,
    buildLinkSuccessMessage,
    handleLinkCommand,
    handleLinkDeleteCommand,
    mapRosterLinkError,
    normalizePlayerTag
};
