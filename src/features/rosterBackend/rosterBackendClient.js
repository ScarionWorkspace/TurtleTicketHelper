const {
    ROSTER_BACKEND_URL,
    ROSTER_BOT_SECRET
} = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 60_000;
const DISCORD_IDENTITY_SYNC_TIMEOUT_MS = 180_000;
const CWL_EVENT_REFRESH_TIMEOUT_MS = 180_000;
const SEASON_EVENT_TIMEOUT_MS = 45_000;
const SEASON_EVENT_MAX_ATTEMPTS = 2;
const SEASON_EVENT_RETRY_DELAY_MS = 250;

function normalizeBackendUrl(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        return '';
    }

    try {
        const url = new URL(raw);
        url.hash = '';
        return url.toString().replace(/[\/\\]+$/, '');
    } catch {
        return raw.replace(/[\/\\]+$/, '');
    }
}

function formatUrlForDiagnostics(value) {
    const raw = String(value || '').trim();

    if (!raw) {
        return '';
    }

    try {
        const url = new URL(raw);
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return raw.replace(/[?#].*$/, '');
    }
}

const ROSTER_BACKEND_REQUEST_URL = normalizeBackendUrl(ROSTER_BACKEND_URL);

class RosterBackendError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'RosterBackendError';
        this.status = details.status ?? null;
        this.code = details.code ?? null;
        this.method = details.method ?? null;
        this.attempts = details.attempts ?? null;
    }
}

function isRosterBackendConfigured() {
    return Boolean(ROSTER_BACKEND_REQUEST_URL && ROSTER_BOT_SECRET);
}

function assertRosterBackendConfigured() {
    if (!ROSTER_BACKEND_REQUEST_URL || !ROSTER_BOT_SECRET) {
        throw new RosterBackendError('Roster backend configuration is missing.', {
            code: 'ROSTER_BACKEND_CONFIG_MISSING'
        });
    }
}

async function parseJsonResponse(response, context = {}) {
    const text = await response.text();

    if (!text) {
        return null;
    }

    try {
        return JSON.parse(text);
    } catch {
        const contentType = String(response.headers?.get?.('content-type') || '').trim();
        const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 160);
        const htmlResponse = /text\/html/i.test(contentType) || /^<!doctype\b/i.test(snippet) || /^<html[\s>]/i.test(snippet);
        const requestUrl = formatUrlForDiagnostics(context.requestUrl);
        const responseUrl = formatUrlForDiagnostics(response.url);
        const urlDetails = [
            requestUrl ? `Request URL: ${requestUrl}.` : '',
            responseUrl && responseUrl !== requestUrl ? `Final URL: ${responseUrl}.` : ''
        ].filter(Boolean);
        const detail = htmlResponse
            ? [
                'Roster backend returned an HTML response instead of JSON.',
                Number.isFinite(response.status) ? `Status: ${response.status}.` : '',
                contentType ? `Content-Type: ${contentType}.` : '',
                ...urlDetails,
                'Check ROSTER_BACKEND_URL and the deployed Apps Script logs.'
            ].filter(Boolean).join(' ')
            : [
                'Roster backend returned invalid JSON.',
                Number.isFinite(response.status) ? `Status: ${response.status}.` : '',
                contentType ? `Content-Type: ${contentType}.` : '',
                ...urlDetails,
                snippet ? `Response started with: ${snippet}` : ''
            ].filter(Boolean).join(' ');
        throw new RosterBackendError(detail, {
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
        const response = await fetch(ROSTER_BACKEND_REQUEST_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${ROSTER_BOT_SECRET}`,
                'Content-Type': 'application/json',
                'X-Discord-Bot-Secret': ROSTER_BOT_SECRET
            },
            body: JSON.stringify({
                method: methodName,
                methodName,
                args
            }),
            signal: controller.signal
        });

        const payload = await parseJsonResponse(response, {
            requestUrl: ROSTER_BACKEND_REQUEST_URL
        });

        if (!response.ok) {
            throw new RosterBackendError(payload?.error || 'Roster backend returned a non-2xx response.', {
                status: response.status,
                code: payload?.code || payload?.errorCode || 'HTTP_ERROR'
            });
        }

        if (payload && Object.prototype.hasOwnProperty.call(payload, 'ok')) {
            if (payload.ok !== true) {
                throw new RosterBackendError(payload.error || 'Roster backend returned ok:false.', {
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

function isTransientSeasonEventError(error) {
    const code = String(error?.code || '').trim().toUpperCase();
    const status = Number(error?.status);

    return code === 'TIMEOUT' ||
        code === 'REQUEST_FAILED' ||
        (code === 'INVALID_JSON' && (status === 403 || status === 429 || status >= 500)) ||
        status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function callSeasonEventMethod(methodName, payload = {}, options = {}) {
    const maxAttempts = Math.max(1, Number(options.maxAttempts) || SEASON_EVENT_MAX_ATTEMPTS);
    const requestOptions = {
        ...options,
        timeoutMs: options.timeoutMs ?? SEASON_EVENT_TIMEOUT_MS
    };
    delete requestOptions.maxAttempts;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
            return await callRosterBackendMethod(
                methodName,
                [payload || {}, ROSTER_BOT_SECRET],
                requestOptions
            );
        } catch (error) {
            error.method = error.method || methodName;
            error.attempts = attempt;

            if (attempt >= maxAttempts || !isTransientSeasonEventError(error)) {
                throw error;
            }

            await wait(SEASON_EVENT_RETRY_DELAY_MS);
        }
    }

    throw new RosterBackendError('Roster backend request failed.', {
        code: 'REQUEST_FAILED',
        method: methodName,
        attempts: maxAttempts
    });
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
        {
            timeoutMs: DISCORD_IDENTITY_SYNC_TIMEOUT_MS,
            ...options
        }
    );
}

function linkDiscordIdentityForPlayerTag(payload = {}, options = {}) {
    return callRosterBackendMethod(
        'linkDiscordIdentityForPlayerTag',
        [{
            playerTag: payload.playerTag,
            discordId: payload.discordId,
            discordUsername: payload.discordUsername,
            force: payload.force === true,
            botSecret: ROSTER_BOT_SECRET
        }],
        {
            timeoutMs: DISCORD_IDENTITY_SYNC_TIMEOUT_MS,
            ...options
        }
    );
}

function deleteDiscordIdentityForPlayerTag(payload = {}, options = {}) {
    return callRosterBackendMethod(
        'deleteDiscordIdentityForPlayerTag',
        [{
            playerTag: payload.playerTag,
            botSecret: ROSTER_BOT_SECRET
        }],
        {
            timeoutMs: DISCORD_IDENTITY_SYNC_TIMEOUT_MS,
            ...options
        }
    );
}

function deleteDiscordIdentityLink(payload = {}, options = {}) {
    return callRosterBackendMethod(
        'deleteDiscordIdentityLink',
        [{
            playerTag: payload.playerTag,
            discordId: payload.discordId,
            discordUsername: payload.discordUsername,
            botSecret: ROSTER_BOT_SECRET
        }],
        {
            timeoutMs: DISCORD_IDENTITY_SYNC_TIMEOUT_MS,
            ...options
        }
    );
}

function reconcileCurrentSeasonEvents(payload = {}, options = {}) {
    return callSeasonEventMethod('reconcileCurrentSeasonEvents', payload, options);
}

function getCurrentSeasonEvents(payload = {}, options = {}) {
    return callSeasonEventMethod('getCurrentSeasonEvents', payload, options);
}

function ensureCurrentCwlSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod('ensureCurrentCwlSeasonEvent', payload, options);
}

function refreshCurrentCwlSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod(
        'refreshCurrentCwlSeasonEvent',
        payload,
        {
            timeoutMs: CWL_EVENT_REFRESH_TIMEOUT_MS,
            ...options
        }
    );
}

function getCurrentCwlSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod('getCurrentCwlSeasonEvent', payload, options);
}

function getSeasonEvent(payload = {}, options = {}) {
    return callSeasonEventMethod('getSeasonEvent', payload, options);
}

function getSeasonEventMutationContext(payload = {}, options = {}) {
    return callSeasonEventMethod('getSeasonEventMutationContext', payload, options);
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

function getCwlLeagueSignupOptions(payload = {}, options = {}) {
    return callSeasonEventMethod('getCwlLeagueSignupOptions', payload, options);
}

function setCwlLeaguePreference(payload = {}, options = {}) {
    return callSeasonEventMethod('setCwlLeaguePreference', payload, options);
}

function getCwlLeaguePreferencesForDiscordUser(payload = {}, options = {}) {
    return callSeasonEventMethod('getCwlLeaguePreferencesForDiscordUser', payload, options);
}

function getCwlLeagueSignupContextForDiscordUser(payload = {}, options = {}) {
    return callSeasonEventMethod('getCwlLeagueSignupContextForDiscordUser', payload, options);
}

function clearCwlLeaguePreference(payload = {}, options = {}) {
    return callSeasonEventMethod('clearCwlLeaguePreference', payload, options);
}

function resetCwlLeaguePreferences(payload = {}, options = {}) {
    return callSeasonEventMethod('resetCwlLeaguePreferences', payload, options);
}

module.exports = {
    RosterBackendError,
    isRosterBackendConfigured,
    deleteDiscordIdentityForPlayerTag,
    deleteDiscordIdentityLink,
    linkDiscordIdentityForPlayerTag,
    syncDiscordIdentityForPlayerTag,
    reconcileCurrentSeasonEvents,
    getCurrentSeasonEvents,
    ensureCurrentCwlSeasonEvent,
    refreshCurrentCwlSeasonEvent,
    getCurrentCwlSeasonEvent,
    getSeasonEvent,
    getSeasonEventMutationContext,
    registerSeasonEventSignup,
    updateSeasonEventParticipantAccounts,
    cancelSeasonEventSignup,
    updateSeasonEvent,
    getSeasonEventLeaderboard,
    getCurrentSeasonEventLeaderboards,
    getCwlLeagueSignupOptions,
    setCwlLeaguePreference,
    getCwlLeaguePreferencesForDiscordUser,
    getCwlLeagueSignupContextForDiscordUser,
    clearCwlLeaguePreference,
    resetCwlLeaguePreferences
};
