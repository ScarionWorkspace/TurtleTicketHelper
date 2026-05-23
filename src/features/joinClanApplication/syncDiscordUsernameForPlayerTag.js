const rosterBackend = require('../rosterBackend/rosterBackendClient');

function warnSync(message, playerTag, discordUsername, extra = {}) {
    console.warn(message, {
        tag: playerTag,
        discordUsername,
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

async function syncDiscordUsernameForPlayerTag(playerTag, discordUsername, discordId = null) {
    return syncDiscordIdentityForPlayerTag(playerTag, discordId, discordUsername);
}

module.exports = syncDiscordUsernameForPlayerTag;
module.exports.syncDiscordIdentityForPlayerTag = syncDiscordIdentityForPlayerTag;
module.exports.syncDiscordUsernameForPlayerTag = syncDiscordUsernameForPlayerTag;