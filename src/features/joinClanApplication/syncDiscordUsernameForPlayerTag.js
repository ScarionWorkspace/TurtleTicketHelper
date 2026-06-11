const rosterBackend = require('../rosterBackend/rosterBackendClient');

function warnSync(message, playerTag, discordUsername, extra = {}) {
    console.warn(message, {
        tag: playerTag,
        discordUsername: discordUsername || null,
        ...extra
    });
}

function logSyncSuccess(result, playerTag, discordUsername) {
    console.log('Discord identity sync success:', {
        tag: playerTag,
        discordUsername,
        found: result?.found ?? null,
        updated: result?.updated ?? null,
        updatedCount: result?.updatedCount ?? null,
        skippedExistingCount: result?.skippedExistingCount ?? null
    });
}

function logDeleteSuccess(result, playerTag) {
    console.log('Discord identity delete sync success:', {
        tag: playerTag,
        found: result?.found ?? null,
        updated: result?.updated ?? null,
        updatedCount: result?.updatedCount ?? null,
        removedDiscordId: result?.removedDiscordId ?? null,
        removedDiscordUsername: result?.removedDiscordUsername ?? null
    });
}

async function syncDiscordIdentityForPlayerTag(playerTag, discordId, discordUsername) {
    if (!rosterBackend.isRosterBackendConfigured()) {
        warnSync(
            'Skipping Discord identity sync: roster backend config is missing.',
            playerTag,
            discordUsername
        );
        return {
            ok: false,
            skipped: true
        };
    }

    try {
        const result = await rosterBackend.syncDiscordIdentityForPlayerTag({
            playerTag,
            discordId,
            discordUsername
        });

        if (result?.ok === false) {
            warnSync(
                'Discord identity sync failed: roster backend result returned ok:false.',
                playerTag,
                discordUsername,
                { resultOk: result?.ok ?? null }
            );
            return { ok: false };
        }

        if (result?.found === false) {
            warnSync(
                'Discord identity sync completed but no player was found.',
                playerTag,
                discordUsername
            );
        }

        logSyncSuccess(result, playerTag, discordUsername);
        return result;
    } catch (error) {
        console.error('Discord identity sync failed:', {
            tag: playerTag,
            discordUsername,
            errorName: error?.name ?? null,
            errorMessage: error?.message ?? null,
            errorCode: error?.code ?? null,
            status: error?.status ?? null
        });

        warnSync(
            'Discord identity sync failed.',
            playerTag,
            discordUsername
        );

        return { ok: false };
    }
}

async function deleteDiscordIdentityForPlayerTag(playerTag) {
    if (!rosterBackend.isRosterBackendConfigured()) {
        warnSync(
            'Skipping Discord identity delete sync: roster backend config is missing.',
            playerTag,
            ''
        );
        return {
            ok: false,
            skipped: true
        };
    }

    try {
        const result = await rosterBackend.deleteDiscordIdentityForPlayerTag({
            playerTag
        });

        if (result?.ok === false) {
            warnSync(
                'Discord identity delete sync failed: roster backend result returned ok:false.',
                playerTag,
                '',
                { resultOk: result?.ok ?? null }
            );
            return { ok: false };
        }

        if (result?.found === false) {
            warnSync(
                'Discord identity delete sync completed but no matching player or identity was found.',
                playerTag,
                ''
            );
        }

        logDeleteSuccess(result, playerTag);
        return result;
    } catch (error) {
        console.error('Discord identity delete sync failed:', {
            tag: playerTag,
            errorName: error?.name ?? null,
            errorMessage: error?.message ?? null,
            errorCode: error?.code ?? null,
            status: error?.status ?? null
        });

        warnSync(
            'Discord identity delete sync failed.',
            playerTag,
            ''
        );

        return { ok: false };
    }
}

async function syncDiscordUsernameForPlayerTag(playerTag, discordUsername, discordId = null) {
    return syncDiscordIdentityForPlayerTag(playerTag, discordId, discordUsername);
}

module.exports = syncDiscordUsernameForPlayerTag;
module.exports.deleteDiscordIdentityForPlayerTag = deleteDiscordIdentityForPlayerTag;
module.exports.syncDiscordIdentityForPlayerTag = syncDiscordIdentityForPlayerTag;
module.exports.syncDiscordUsernameForPlayerTag = syncDiscordUsernameForPlayerTag;
