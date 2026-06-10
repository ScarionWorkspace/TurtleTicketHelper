const { ROSTER_FIREBASE_DB_URL } = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 12_000;
const FB64_PREFIX = '__FB64__';
const SEASON_EVENT_ROOT = 'events/seasonEvents';
const PLAYER_METRICS_BY_TAG_PATH = 'active/playerMetrics/byTag';
const ACTIVE_ROSTER_PATH = 'active';
const CWL_LEAGUE_SIGNUPS_PATH = 'active/cwlLeagueSignups';

function normalizeDatabaseUrl(url) {
    return String(url || '')
        .trim()
        .replace(/\/+$/, '')
        .replace(/\.json$/i, '');
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
        key.startsWith(FB64_PREFIX) ||
        /[.$#[\]/]/.test(key) ||
        /[\x00-\x1F\x7F]/.test(key);
}

function encodeFirebaseObjectKey(value) {
    const key = String(value ?? '');

    if (!keyNeedsEncoding(key)) {
        return key;
    }

    return `${FB64_PREFIX}${Buffer.from(key, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '')}`;
}

const encodeFirebaseKey = encodeFirebaseObjectKey;

function decodeFirebaseKey(key) {
    const stringKey = String(key);

    if (!stringKey.startsWith(FB64_PREFIX)) {
        return stringKey;
    }

    const encoded = stringKey.slice(FB64_PREFIX.length);
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

function decodeFirebaseKeys(value) {
    if (Array.isArray(value)) {
        return value.map(item => decodeFirebaseKeys(item));
    }

    if (!value || typeof value !== 'object') {
        return value;
    }

    return Object.entries(value).reduce((decoded, [key, nestedValue]) => {
        decoded[decodeFirebaseKey(key)] = decodeFirebaseKeys(nestedValue);
        return decoded;
    }, {});
}

function buildFirebaseUrl(path) {
    const baseUrl = normalizeDatabaseUrl(ROSTER_FIREBASE_DB_URL);
    const cleanPath = normalizePath(path);

    if (!baseUrl || !cleanPath) {
        return null;
    }

    return `${baseUrl}/${cleanPath
        .split('/')
        .map(segment => encodeURIComponent(segment))
        .join('/')}.json`;
}

async function readJsonPath(path, options = {}) {
    const url = buildFirebaseUrl(path);

    if (!url) {
        return null;
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            method: 'GET',
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
            return decodeFirebaseKeys(JSON.parse(text));
        } catch {
            return null;
        }
    } catch {
        return null;
    } finally {
        clearTimeout(timeoutId);
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

function readCurrentSeasonEventPointer(type, options = {}) {
    return readJsonPath(`${SEASON_EVENT_ROOT}/current/${normalizeType(type)}`, options);
}

function readSeasonEventById(eventId, options = {}) {
    if (!eventId) {
        return null;
    }

    const basePath = `${SEASON_EVENT_ROOT}/byId/${encodeFirebaseObjectKey(eventId)}`;
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
        'participantCount',
        'activeParticipantCount',
        'accountCount'
    ];

    if (includeParticipantsByDiscordId) {
        fieldNames.push('participantsByDiscordId');
    }

    return Promise.all(
        fieldNames.map(fieldName => readJsonPath(`${basePath}/${fieldName}`, options))
    ).then(values => {
        if (values.every(value => value === null || value === undefined)) {
            return null;
        }

        return fieldNames.reduce((event, fieldName, index) => {
            const value = values[index];

            if (value !== null && value !== undefined) {
                event[fieldName] = value;
            }

            return event;
        }, {});
    });
}

function readSeasonEventParticipantByDiscordId(eventId, discordId, options = {}) {
    if (!eventId || !discordId) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/byId/${encodeFirebaseObjectKey(eventId)}/participantsByDiscordId/${discordId}`,
        options
    );
}

function readSeasonEventParticipantsByDiscordId(eventId, options = {}) {
    if (!eventId) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/byId/${encodeFirebaseObjectKey(eventId)}/participantsByDiscordId`,
        options
    );
}

function readSeasonEventParticipantByTag(eventId, playerTag, options = {}) {
    const tag = normalizePlayerTag(playerTag);

    if (!eventId || !tag) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/byId/${encodeFirebaseObjectKey(eventId)}/participantsByTag/${encodeFirebaseObjectKey(tag)}`,
        options
    );
}

function readSeasonEventsBySeason(seasonId, options = {}) {
    if (!seasonId) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/bySeason/${encodeFirebaseObjectKey(seasonId)}`,
        options
    );
}

function readSeasonEventBySeasonAndType(seasonId, type, options = {}) {
    if (!seasonId) {
        return null;
    }

    return readJsonPath(
        `${SEASON_EVENT_ROOT}/bySeason/${encodeFirebaseObjectKey(seasonId)}/${normalizeType(type)}`,
        options
    );
}

function readCurrentSeasonState(options = {}) {
    return readJsonPath(`${SEASON_EVENT_ROOT}/seasonState/current`, options);
}

function readActivePlayerMetricsByTag(playerTag, options = {}) {
    const tag = normalizePlayerTag(playerTag);

    if (!tag) {
        return null;
    }

    return readJsonPath(
        `${PLAYER_METRICS_BY_TAG_PATH}/${encodeFirebaseObjectKey(tag)}`,
        options
    );
}

function readAllActivePlayerMetricsByTag(options = {}) {
    return readJsonPath(PLAYER_METRICS_BY_TAG_PATH, options);
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
    const metricsByTag = await readAllActivePlayerMetricsByTag(options);

    if (!metricsByTag || typeof metricsByTag !== 'object') {
        return [];
    }

    const entries = Object.entries(metricsByTag);
    const idMatches = entries
        .filter(([, metric]) => String(metric?.identity?.discordId || '') === discordId)
        .map(([tag, metric]) => metricToLinkedAccount(metric, tag, 'discordId'))
        .filter(Boolean);

    if (idMatches.length > 0) {
        return idMatches;
    }

    if (!discordUsername) {
        return [];
    }

    const usernameMatches = entries
        .filter(([, metric]) => metric?.identity?.discordUsername === discordUsername)
        .map(([tag, metric]) => metricToLinkedAccount(metric, tag, 'discordUsername'))
        .filter(Boolean);

    return usernameMatches.length === 1 ? usernameMatches : [];
}

module.exports = {
    normalizeDatabaseUrl,
    normalizePath,
    encodeFirebaseObjectKey,
    encodeFirebaseKey,
    decodeFirebaseKeys,
    readJsonPath,
    readCurrentSeasonEventPointer,
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
    readLinkedAccountsForDiscordUser
};
