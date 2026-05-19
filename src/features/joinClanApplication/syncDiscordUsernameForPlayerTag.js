const {
    ROSTER_BACKEND_URL,
    ROSTER_BOT_SECRET
} = require('../../config/env');

const SYNC_TIMEOUT_MS = 60_000;

function warnSync(message, playerTag, discordUsername) {
    console.warn(message, {
        tag: playerTag,
        discordUsername
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
                discordUsername
            );
            return { ok: false };
        }

        if (payload.result?.ok !== true) {
            warnSync(
                'Discord username sync failed: roster backend result returned ok:false.',
                playerTag,
                discordUsername
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

        return payload.result;
    } catch (error) {
        const message =
            error?.name === 'AbortError'
                ? 'Discord username sync failed: request timed out.'
                : 'Discord username sync failed: request error.';

        warnSync(message, playerTag, discordUsername);
        return { ok: false };
    } finally {
        if (timeoutId) {
            clearTimeout(timeoutId);
        }
    }
}

module.exports = syncDiscordUsernameForPlayerTag;
