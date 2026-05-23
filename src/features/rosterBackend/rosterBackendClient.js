const {
    ROSTER_BACKEND_URL,
    ROSTER_BOT_SECRET
} = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 60_000;

class RosterBackendError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'RosterBackendError';
        this.status = details.status ?? null;
        this.code = details.code ?? null;
    }
}

function isRosterBackendConfigured() {
    return Boolean(ROSTER_BACKEND_URL && ROSTER_BOT_SECRET);
}

function assertRosterBackendConfigured() {
    if (!ROSTER_BACKEND_URL || !ROSTER_BOT_SECRET) {
        throw new RosterBackendError('Roster backend configuration is missing.', {
            code: 'ROSTER_BACKEND_CONFIG_MISSING'
        });
    }
}

async function parseJsonResponse(response) {
    const text = await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        throw new RosterBackendError('Roster backend returned invalid JSON.', {
            status: response.status,
            code: 'INVALID_JSON'
        });
    }
}

async function callRosterBackendMethod(methodName, args, options = {}) {
    assertRosterBackendConfigured();

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(ROSTER_BACKEND_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                method: methodName,
                methodName,
                args
            }),
            signal: controller.signal
        });

        const payload = await parseJsonResponse(response);

        if (!response.ok) {
            throw new RosterBackendError('Roster backend returned a non-2xx response.', {
                status: response.status,
                code: 'HTTP_ERROR'
            });
        }

        if (payload && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
            if (payload.ok !== true) {
                throw new RosterBackendError('Roster backend returned ok:false.', {
                    status: response.status,
                    code: payload.code || payload.errorCode || 'BACKEND_NOT_OK'
                });
            }

            if (Object.prototype.hasOwnProperty.call(payload, 'result')) {
                return payload.result;
            }

            return payload;
        }

        return payload;
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new RosterBackendError('Roster backend request timed out.', {
                code: 'TIMEOUT'
            });
        }

        if (error instanceof RosterBackendError) {
            throw error;
        }

        throw new RosterBackendError('Roster backend request failed.', {
            code: 'REQUEST_FAILED'
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

function callSeasonEventMethod(methodName, payload = {}, options = {}) {
    return callRosterBackendMethod(
        methodName,
        [payload || {}, ROSTER_BOT_SECRET],
        options
    );
}

function syncDiscordIdentityForPlayerTag(payload = {}, options = {}) {
    return callRosterBackendMethod(
        'syncDiscordIdentityForPlayerTag',
        [{
            playerTag: payload.playerTag,
            discordId: payload.discordId,
            discordUsername: payload.discordUsername,
            botSecret: ROSTER_BOT_SECRET
        }],
        options
    );
}

function reconcileCurrentSeasonEvents(payload = {}, options = {}) {
    return callSeasonEventMethod('reconcileCurrentSeasonEvents', payload, options);
}

function getCurrentSeasonEvents(payload = {}, options = {}) {
    return callSeasonEventMethod('getCurrentSeasonEvents', payload, options);
}

function getSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod('getSeasonEvent', payload, options);
}

function registerSeasonEventSignup(payload = {}, options = {}) {
    return callSeasonEventMethod('registerSeasonEventSignup', payload, options);
}

function updateSeasonEventParticipantAccounts(payload = {}, options = {}) {
    return callSeasonEventMethod(
        'updateSeasonEventParticipantAccounts',
        payload,
        options
    );
}

function cancelSeasonEventSignup(payload = {}, options = {}) {
    return callSeasonEventMethod('cancelSeasonEventSignup', payload, options);
}

function updateSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod('updateSeasonEvent', payload, options);
}

function getSeasonEventLeaderboard(payload = {}, options = {}) {
    return callSeasonEventMethod('getSeasonEventLeaderboard', payload, options);
}

function getCurrentSeasonEventLeaderboards(payload = {}, options = {}) {
    return callSeasonEventMethod(
        'getCurrentSeasonEventLeaderboards',
        payload,
        options
    );
}

module.exports = {
    RosterBackendError,
    isRosterBackendConfigured,
    syncDiscordIdentityForPlayerTag,
    reconcileCurrentSeasonEvents,
    getCurrentSeasonEvents,
    getSeasonEvent,
    registerSeasonEventSignup,
    updateSeasonEventParticipantAccounts,
    cancelSeasonEventSignup,
    updateSeasonEvent,
    getSeasonEventLeaderboard,
    getCurrentSeasonEventLeaderboards
};