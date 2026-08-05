const appConfig = require('../../config/appConfig');

const CUSTOM_ID_PREFIX = 'season_event:v1';
const CUSTOM_ID_V2_PREFIX = 'sev2';
const CUSTOM_ID_MAX_LENGTH = 100;
const ACTION_CODES = {
    refresh: 'r', signup: 's', optout: 'o', options: 'p', select: 'a',
    update: 'u', cancel: 'c', admin: 'd', title: 't', info: 'i'
};
const ACTIONS_BY_CODE = Object.fromEntries(Object.entries(ACTION_CODES).map(([action, code]) => [code, action]));
const TYPE_CODES = { push: 'p', donation: 'd', cwl: 'c' };
const TYPES_BY_CODE = Object.fromEntries(Object.entries(TYPE_CODES).map(([type, code]) => [code, type]));
const MODE_CODES = { signup: 's', update: 'u' };
const MODES_BY_CODE = Object.fromEntries(Object.entries(MODE_CODES).map(([mode, code]) => [code, mode]));
const EVENT_TYPES = {
    push: {
        value: 'push',
        titleKey: 'pushTitle',
        defaultTitle: 'Push Event',
        maxAccounts: 1,
        metricLabel: 'Score'
    },
    donation: {
        value: 'donation',
        titleKey: 'donationTitle',
        defaultTitle: 'Donation Event',
        maxAccounts: 2,
        metricLabel: 'Donos'
    },
    cwl: {
        value: 'cwl',
        titleKey: 'cwlTitle',
        defaultTitle: 'CWL Event',
        maxAccounts: 50,
        metricLabel: 'Stars'
    }
};

function normalizeEventType(type) {
    const normalized = String(type || '').trim().toLowerCase();
    return EVENT_TYPES[normalized] ? normalized : null;
}

function getEventTypeConfig(type) {
    const normalized = normalizeEventType(type);

    if (!normalized) {
        return null;
    }

    const labels = appConfig.seasonEvents?.labels || {};
    const typeConfig = EVENT_TYPES[normalized];

    return {
        ...typeConfig,
        title: labels[typeConfig.titleKey] || typeConfig.defaultTitle
    };
}

function getMaxAccountsForType(type) {
    return getEventTypeConfig(type)?.maxAccounts || 1;
}

function buildCustomId(action, type, ...parts) {
    const normalizedType = normalizeEventType(type) || String(type || '').trim().toLowerCase();
    const context = parts[0] && typeof parts[0] === 'object' && !Array.isArray(parts[0])
        ? parts[0]
        : null;

    if (context) {
        const fields = [
            CUSTOM_ID_V2_PREFIX,
            ACTION_CODES[action] || action,
            TYPE_CODES[normalizedType] || normalizedType,
            context.eventId || '_',
            context.userId || '_',
            context.messageId || '_',
            MODE_CODES[context.mode] || context.mode || '_'
        ].map(part => encodeURIComponent(String(part)));
        const customId = fields.join('|');

        if (customId.length > CUSTOM_ID_MAX_LENGTH) {
            throw new Error(`Season event custom ID exceeds ${CUSTOM_ID_MAX_LENGTH} characters.`);
        }

        return customId;
    }

    const suffix = parts
        .filter(part => part !== null && part !== undefined && part !== '')
        .map(part => encodeURIComponent(String(part)))
        .join(':');

    return `${CUSTOM_ID_PREFIX}:${action}:${normalizedType}${suffix ? `:${suffix}` : ''}`;
}

function isSeasonEventCustomId(customId) {
    const value = String(customId || '');
    return value === CUSTOM_ID_PREFIX || value.startsWith(`${CUSTOM_ID_PREFIX}:`) || value.startsWith(`${CUSTOM_ID_V2_PREFIX}|`);
}

function decodeCustomIdPart(part) {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

function parseCustomId(customId) {
    const value = String(customId || '');

    if (value.startsWith(`${CUSTOM_ID_V2_PREFIX}|`)) {
        const parts = value.split('|').map(decodeCustomIdPart);
        const action = ACTIONS_BY_CODE[parts[1]] || parts[1] || null;
        const type = TYPES_BY_CODE[parts[2]] || normalizeEventType(parts[2]);
        const nullable = part => part && part !== '_' ? part : null;

        if (!action || !type) return null;

        return {
            action,
            type,
            eventId: nullable(parts[3]),
            userId: nullable(parts[4]),
            messageId: nullable(parts[5]),
            mode: MODES_BY_CODE[parts[6]] || nullable(parts[6]),
            parts: parts.slice(3),
            version: 2
        };
    }

    const parts = value.split(':');

    if (parts[0] !== 'season_event' || parts[1] !== 'v1') {
        return null;
    }

    const action = parts[2] || null;
    const type = normalizeEventType(parts[3]);

    if (!action || !type) {
        return null;
    }

    const extraParts = parts.slice(4).map(decodeCustomIdPart);

    return {
        action,
        type,
        eventId: null,
        userId: extraParts[0] || null,
        messageId: extraParts[1] || null,
        mode: extraParts[2] || null,
        parts: extraParts
    };
}

module.exports = {
    CUSTOM_ID_PREFIX,
    CUSTOM_ID_V2_PREFIX,
    EVENT_TYPES,
    normalizeEventType,
    getEventTypeConfig,
    getMaxAccountsForType,
    buildCustomId,
    isSeasonEventCustomId,
    parseCustomId
};
