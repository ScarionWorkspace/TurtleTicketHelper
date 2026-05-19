const {
    ROSTER_BACKEND_URL,
    ROSTER_BOT_SECRET
} = require('../../config/env');

const SYNC_TIMEOUT_MS = 60_000;

function warnSync(message, playerTag, discordUsername, extra = {}) {
    console.warn(message, {
        tag: playerTag,
        discordUsername,
        ...extra
    });
}

function logSyncSuccess(result, playerTag, discordUsername) {
    console.log('Discord username sync success:', {
        tag: playerTag,
        discordUsername,
        found: result?.found ?? null,
        updated: result?.updated ?? null,
        updatedCount: result?.updatedCount ?? null,
        skippedExistingCount: result?.skippedExistingCount ?? null
    });
}

async function syncDiscordUsernameForPlayerTag(playerTag, discordUsername) {
    if (!ROSTER_BACKEND_URL || !ROSTER_BOT_SECRET) {
        warnSync(
            'Skipping Discord username sync: roster backend config is missing.',
            playerTag,
            discordUsername
        );
        return {
            ok: false,
            skipped: true
        };
    }

    let timeoutId;

    try {
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), SYNC_TIMEOUT_MS);

        const response = await fetch(ROSTER_BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                method: 'syncDiscordUsernameForPlayerTag',
                args: [playerTag, discordUsername, ROSTER_BOT_SECRET]
            }),
            signal: controller.signal
        });

        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unable to read response body');

            console.error('Discord username sync failed: non-2xx response details', {
                status: response.status,
                statusText: response.statusText,
                body: errorText,
                tag: playerTag,
                discordUsername
            });

            warnSync(
                'Discord username sync failed: roster backend returned a non-2xx response.',
                playerTag,
                discordUsername
            );
            return { ok: false };
        }

        let payload;

        try {
            payload = await response.json();
        } catch {
            warnSync(
                'Discord username sync failed: roster backend returned invalid JSON.',
                playerTag,
                discordUsername
            );
            return { ok: false };
        }

        if (payload?.ok !== true) {
            warnSync(
                'Discord username sync failed: roster backend returned ok:false.',
                playerTag,
                discordUsername,
                { payloadOk: payload?.ok ?? null }
            );
            return { ok: false };
        }

        if (payload.result?.ok !== true) {
            warnSync(
                'Discord username sync failed: roster backend result returned ok:false.',
                playerTag,
                discordUsername,
                { resultOk: payload?.result?.ok ?? null }
            );
            return { ok: false };
        }

        if (payload.result.found === false) {
            warnSync(
                'Discord username sync completed but no player was found.',
                playerTag,
                discordUsername
            );
        }

        logSyncSuccess(payload.result, playerTag, discordUsername);
        return payload.result;
    } catch (error) {
        const isTimeout = error?.name === 'AbortError';

        console.error(
            isTimeout
                ? 'Discord username sync failed: request timed out.'
                : 'Discord username sync failed: request error.',
            {
                tag: playerTag,
                discordUsername,
                errorName: error?.name ?? null,
                errorMessage: error?.message ?? null
            }
        );

        warnSync(
            isTimeout
                ? 'Discord username sync failed: request timed out.'
                : 'Discord username sync failed: request error.',
            playerTag,
            discordUsername
        );

        return { ok: false };
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

module.exports = syncDiscordUsernameForPlayerTag;