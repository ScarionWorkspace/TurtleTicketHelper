const {
    ROSTER_BOT_SECRET,
    ROSTER_PUBLIC_DATA_URL
} = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_READ_CACHE_TTL_MS = 60_000;
const READ_CACHE_TTL_ENV_NAME = 'ROSTER_PUBLIC_DATA_READ_CACHE_TTL_MS';
const DEFAULT_BOT_DATA_URL = 'https://turtlecoc.4jbf82gng5.workers.dev/api/bot-data';
const ENCODED_KEY_PREFIX = '__FB64__';
const SEASON_EVENT_ROOT = 'events/seasonEvents';
const DONATION_REFRESH_ROOT = 'donationRefresh';
const PLAYER_METRICS_BY_TAG_PATH = 'active/playerMetrics/byTag';
const ACTIVE_ROSTER_PATH = 'active';
const CWL_LEAGUE_SIGNUPS_PATH = 'active/cwlLeagueSignups';
const readCacheByPath = new Map();
const pendingReadsByPath = new Map();

function normalizePublicDataBaseUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\.json$/i, '');
}

function normalizePublicDataUrl(url) {
    const normalized = normalizePublicDataBaseUrl(url);

    if (!normalized || !/^https?:\/\//i.test(normalized)) {
        return '';
    }

    return normalized;
}

function normalizePath(path) {
    return String(path || '')
        .trim()
        .replace(/^\/+|\/+$/g, '')
        .replace(/\.json$/i, '');
}

function keyNeedsEncoding(value) {
    const key = String(value ?? '');

    return key === '' ||
        key.startsWith(ENCODED_KEY_PREFIX) ||
        /[.$#[\]/]/.test(key) ||
        /[\x00-\x1F\x7F]/.test(key);
}

function encodePublicDataObjectKey(value) {
    const key = String(value ?? '');

    if (!keyNeedsEncoding(key)) {
        return key;
    }

    return `${ENCODED_KEY_PREFIX}${Buffer.from(key, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')}`;
}

const encodePublicDataKey = encodePublicDataObjectKey;

function decodePublicDataKey(key) {
    const stringKey = String(key);

    if (!stringKey.startsWith(ENCODED_KEY_PREFIX)) {
        return stringKey;
    }

    const encoded = stringKey.slice(ENCODED_KEY_PREFIX.length);
    const padded = encoded
        .replace(/-/g, '+')
        .replace(/_/g, '/')
        .padEnd(Math.ceil(encoded.length / 4) * 4, '=');

    try {
        return Buffer.from(padded, 'base64').toString('utf8');
    } catch {
        return stringKey;
    }
}

function decodePublicDataKeys(value) {
    if (Array.isArray(value)) {
        return value.map(item => decodePublicDataKeys(item));
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.entries(value).reduce((decoded, [key, nestedValue]) => {
        decoded[decodePublicDataKey(key)] = decodePublicDataKeys(nestedValue);
        return decoded;
    }, {});
}

function getConfiguredPublicDataUrl() {
    return normalizePublicDataUrl(ROSTER_PUBLIC_DATA_URL) ||
        (ROSTER_BOT_SECRET ? DEFAULT_BOT_DATA_URL : '');
}

function buildPublicDataUrl(path) {
    const baseUrl = getConfiguredPublicDataUrl();
    const cleanPath = normalizePath(path);

    if (!baseUrl || !cleanPath) {
        return null;
    }

    return `${baseUrl}/${cleanPath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')}.json`;
}

function buildReadRequest(path) {
    const publicDataUrl = buildPublicDataUrl(path);

    if (publicDataUrl) {
        return {
            url: publicDataUrl,
            source: 'cloudflare',
            headers: ROSTER_BOT_SECRET
                ? { Authorization: `Bearer ${ROSTER_BOT_SECRET}` }
                : {}
        };
    }
    return { url: null, source: 'cloudflare', headers: {} };
}

function parseNonNegativeInteger(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const parsed = Number(value);

    if (!Number.isFinite(parsed) || parsed < 0) {
        return null;
    }

    return Math.floor(parsed);
}

function getReadCacheTtlMs(options = {}) {
    return parseNonNegativeInteger(options.cacheTtlMs) ??
        parseNonNegativeInteger(process.env[READ_CACHE_TTL_ENV_NAME]) ??
        DEFAULT_READ_CACHE_TTL_MS;
}

function isCacheableReadValue(value) {
    return value !== null && value !== undefined;
}

function cloneJsonValue(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }

    if (typeof structuredClone === 'function') {
        return structuredClone(value);
    }

    return JSON.parse(JSON.stringify(value));
}

async function fetchJsonPathUncached(url, timeoutMs, headers = {}) {
    if (!url) {
        return null;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: controller.signal
        });

        if (!response.ok) {
            return null;
        }

        const text = await response.text();

        if (!text || text === 'null') {
            return null;
        }

        try {
            return decodePublicDataKeys(JSON.parse(text));
        } catch {
            return null;
        }
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
    }
}

async function readJsonPath(path, options = {}) {
    const cleanPath = normalizePath(path);
    const requestConfig = buildReadRequest(cleanPath);

    if (!requestConfig.url) {
        return null;
    }

    const ttlMs = getReadCacheTtlMs(options);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const cacheKey = `${requestConfig.source}:${cleanPath}`;
    const cached = readCacheByPath.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
        return cloneJsonValue(cached.value);
    }

    if (cached) {
        readCacheByPath.delete(cacheKey);
    }

    let pending = pendingReadsByPath.get(cacheKey);

    if (!pending) {
        pending = fetchJsonPathUncached(requestConfig.url, timeoutMs, requestConfig.headers)
            .then(value => {
                if (ttlMs > 0 && isCacheableReadValue(value)) {
                    readCacheByPath.set(cacheKey, {
                        value: cloneJsonValue(value),
                        expiresAt: Date.now() + ttlMs
                    });
                }

                return value;
            })
            .finally(() => {
                if (pendingReadsByPath.get(cacheKey) === pending) {
                    pendingReadsByPath.delete(cacheKey);
                }
            });
        pendingReadsByPath.set(cacheKey, pending);
    }

    return cloneJsonValue(await pending);
}

function invalidateReadCachePath(path) {
    const cleanPath = normalizePath(path);
    if (!cleanPath) return;
    for (const key of [...readCacheByPath.keys()]) {
        if (key.endsWith(`:${cleanPath}`)) readCacheByPath.delete(key);
    }
    for (const key of [...pendingReadsByPath.keys()]) {
        if (key.endsWith(`:${cleanPath}`)) pendingReadsByPath.delete(key);
    }
}

function invalidateReadCachePrefix(prefix) {
    const cleanPrefix = normalizePath(prefix);
    if (!cleanPrefix) return;
    const marker = `:${cleanPrefix}`;
    for (const key of [...readCacheByPath.keys()]) {
        if (key.includes(marker) || key.startsWith(`${key.split(':')[0]}:${cleanPrefix}/`)) readCacheByPath.delete(key);
    }
    for (const key of [...pendingReadsByPath.keys()]) {
        if (key.includes(marker) || key.startsWith(`${key.split(':')[0]}:${cleanPrefix}/`)) pendingReadsByPath.delete(key);
    }
}

function normalizeType(type) {
    return String(type || '').trim().toLowerCase();
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

async function readCurrentSeasonEventPointer(type, options = {}) {
    const current = await readJsonPath(`${SEASON_EVENT_ROOT}/current`, options);
    const eventType = normalizeType(type);

    return current && typeof current === 'object'
        ? current[eventType] || null
        : null;
}

function readCurrentCwlSeasonEventPointer(options = {}) {
    return readJsonPath(`${SEASON_EVENT_ROOT}/currentCwl`, options);
}

function readLatestCompletedCwlSeasonEventPointer(options = {}) {
    return readJsonPath(`${SEASON_EVENT_ROOT}/latestCompletedCwl`, options);
}

function readCwlSeasonEventAggregate(eventId, kind = 'live', options = {}) {
    const normalizedKind = String(kind || '').trim().toLowerCase();

    if (!eventId || (normalizedKind !== 'live' && normalizedKind !== 'final')) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/cwlAggregates/byEvent/${encodePublicDataObjectKey(eventId)}/${normalizedKind}`,
        options
    );
}

async function readSeasonEventById(eventId, options = {}) {
    if (!eventId) {
        return null;
    }

    const basePath = `${SEASON_EVENT_ROOT}/byId/${encodePublicDataObjectKey(eventId)}`;
    const includeParticipantsByDiscordId =
        options.includeParticipantsByDiscordId === true ||
        options.includeParticipants === true;
    const fieldNames = [
        'eventId',
        'type',
        'seasonId',
        'title',
        'description',
        'status',
        'visibility',
        'signupsOpen',
        'startsAt',
        'endsAt',
        'settings',
        'cwlTrackingState',
        'cwl',
        'participantCount',
        'activeParticipantCount',
        'accountCount'
    ];

    if (includeParticipantsByDiscordId) {
        fieldNames.push('participantsByDiscordId');
    }

    const event = await readJsonPath(basePath, options);

    if (!event || typeof event !== 'object') {
        return null;
    }

    return fieldNames.reduce((projected, fieldName) => {
        const value = event[fieldName];

        if (value !== null && value !== undefined) {
            projected[fieldName] = value;
        }

        return projected;
    }, {});
}

async function readSeasonEventParticipantByDiscordId(eventId, discordId, options = {}) {
    if (!eventId || !discordId) {
        return null;
    }

    const event = await readJsonPath(`${SEASON_EVENT_ROOT}/byId/${encodePublicDataObjectKey(eventId)}`, options);
    const participants = event?.participantsByDiscordId;

    return participants && typeof participants === 'object'
        ? participants[String(discordId)] || null
        : null;
}

async function readSeasonEventParticipantsByDiscordId(eventId, options = {}) {
    if (!eventId) {
        return null;
    }

    const event = await readJsonPath(`${SEASON_EVENT_ROOT}/byId/${encodePublicDataObjectKey(eventId)}`, options);

    return event?.participantsByDiscordId && typeof event.participantsByDiscordId === 'object'
        ? event.participantsByDiscordId
        : null;
}

async function readSeasonEventParticipantByTag(eventId, playerTag, options = {}) {
    const tag = normalizePlayerTag(playerTag);

    if (!eventId || !tag) {
        return null;
    }

    const event = await readJsonPath(`${SEASON_EVENT_ROOT}/byId/${encodePublicDataObjectKey(eventId)}`, options);
    const participants = event?.participantsByTag;

    return participants && typeof participants === 'object'
        ? participants[tag] || null
        : null;
}

function readSeasonEventsBySeason(seasonId, options = {}) {
    if (!seasonId) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/bySeason/${encodePublicDataObjectKey(seasonId)}`,
        options
    );
}

async function readSeasonEventBySeasonAndType(seasonId, type, options = {}) {
    if (!seasonId) {
        return null;
    }

    const bySeason = await readSeasonEventsBySeason(seasonId, options);

    return bySeason && typeof bySeason === 'object'
        ? bySeason[normalizeType(type)] || null
        : null;
}

function readCurrentSeasonState(options = {}) {
    return readJsonPath(`${SEASON_EVENT_ROOT}/seasonState/current`, options);
}

async function readActivePlayerMetricsByTag(playerTag, options = {}) {
    const tag = normalizePlayerTag(playerTag);

    if (!tag) {
        return null;
    }

    const byTag = await readAllActivePlayerMetricsByTag(options);

    return byTag && typeof byTag === 'object'
        ? byTag[tag] || null
        : null;
}

function readAllActivePlayerMetricsByTag(options = {}) {
    return readJsonPath(PLAYER_METRICS_BY_TAG_PATH, options);
}

function readDonationRefreshSeasonOverlay(seasonId, options = {}) {
    const id = String(seasonId || '').trim();

    if (!id) {
        return null;
    }

    return readJsonPath(
        `${DONATION_REFRESH_ROOT}/bySeason/${encodePublicDataObjectKey(id)}`,
        options
    );
}

function readActiveRosterPayload(options = {}) {
    return readJsonPath(ACTIVE_ROSTER_PATH, options);
}

function readCwlLeagueSignups(options = {}) {
    return readJsonPath(CWL_LEAGUE_SIGNUPS_PATH, options);
}

function metricToLinkedAccount(metric, fallbackTag, matchType) {
    const identity = metric?.identity || {};
    const latest = metric?.latestSnapshot || {};
    const tag = normalizePlayerTag(identity.tag || fallbackTag);

    if (!tag) {
        return null;
    }

    return {
        tag,
        playerTag: tag,
        name: identity.name || latest.name || tag,
        townHall: latest.townHallLevel || latest.th || null,
        townHallLevel: latest.townHallLevel || latest.th || null,
        trophies: latest.trophies ?? null,
        leagueName: latest.league?.name || latest.leagueTier?.name || null,
        discordId: identity.discordId || null,
        discordUsername: identity.discordUsername || null,
        matchType
    };
}

async function readLinkedAccountsForDiscordUser(discordUser, options = {}) {
    const discordId = String(discordUser?.id || discordUser?.discordId || '').trim();
    const discordUsername = String(
        discordUser?.username ||
        discordUser?.discordUsername ||
        ''
    ).trim();
    const [byDiscordId, byDiscordUsername] = await Promise.all([
        discordId ? readJsonPath('indexes/linkedAccountsByDiscordId', options) : null,
        discordUsername ? readJsonPath('indexes/linkedAccountsByDiscordUsername', options) : null
    ]);

    const indexedIdMatches = byDiscordId && typeof byDiscordId === 'object'
        ? byDiscordId[discordId]
        : null;

    if (Array.isArray(indexedIdMatches) && indexedIdMatches.length > 0) {
        return indexedIdMatches.map(account => ({
            ...account,
            tag: normalizePlayerTag(account?.tag || account?.playerTag),
            playerTag: normalizePlayerTag(account?.playerTag || account?.tag),
            matchType: 'discordId'
        })).filter(account => account.tag);
    }

    const indexedUsernameMatches = byDiscordUsername && typeof byDiscordUsername === 'object'
        ? byDiscordUsername[discordUsername]
        : null;

    if (Array.isArray(indexedUsernameMatches) && indexedUsernameMatches.length === 1) {
        return indexedUsernameMatches.map(account => ({
            ...account,
            tag: normalizePlayerTag(account?.tag || account?.playerTag),
            playerTag: normalizePlayerTag(account?.playerTag || account?.tag),
            matchType: 'discordUsername'
        })).filter(account => account.tag);
    }

    const metricsByTag = await readAllActivePlayerMetricsByTag(options);

    if (!metricsByTag || typeof metricsByTag !== 'object') {
        return [];
    }

    const entries = Object.entries(metricsByTag);
    const idMatches = entries
        .filter(([, metric]) => discordId && String(metric?.identity?.discordId || '') === discordId)
        .map(([tag, metric]) => metricToLinkedAccount(metric, tag, 'discordId'))
        .filter(Boolean);

    if (idMatches.length > 0) {
        return idMatches;
    }

    if (!discordUsername) {
        return [];
    }

    const usernameMatches = entries
        .filter(([, metric]) => {
            const identity = metric?.identity || {};
            return !String(identity.discordId || '').trim() &&
                identity.discordUsername === discordUsername;
        })
        .map(([tag, metric]) => metricToLinkedAccount(metric, tag, 'discordUsername'))
        .filter(Boolean);

    return usernameMatches.length === 1 ? usernameMatches : [];
}

module.exports = {
    normalizePublicDataBaseUrl,
    normalizePath,
    encodePublicDataObjectKey,
    encodePublicDataKey,
    decodePublicDataKeys,
    readJsonPath,
    readCurrentSeasonEventPointer,
    readCurrentCwlSeasonEventPointer,
    readLatestCompletedCwlSeasonEventPointer,
    readCwlSeasonEventAggregate,
    readSeasonEventById,
    readSeasonEventParticipantByDiscordId,
    readSeasonEventParticipantsByDiscordId,
    readSeasonEventParticipantByTag,
    readSeasonEventsBySeason,
    readSeasonEventBySeasonAndType,
    readCurrentSeasonState,
    readActiveRosterPayload,
    readCwlLeagueSignups,
    readActivePlayerMetricsByTag,
    readAllActivePlayerMetricsByTag,
    readDonationRefreshSeasonOverlay,
    readLinkedAccountsForDiscordUser,
    invalidateReadCachePath,
    invalidateReadCachePrefix
};
