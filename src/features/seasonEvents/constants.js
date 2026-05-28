const appConfig = require('../../config/appConfig');

const CUSTOM_ID_PREFIX = 'season_event:v1';
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
    const suffix = parts
        .filter(part => part !== null && part !== undefined && part !== '')
        .map(part => encodeURIComponent(String(part)))
        .join(':');

    return `${CUSTOM_ID_PREFIX}:${action}:${normalizedType}${suffix ? `:${suffix}` : ''}`;
}

function isSeasonEventCustomId(customId) {
    const value = String(customId || '');
    return value === CUSTOM_ID_PREFIX || value.startsWith(`${CUSTOM_ID_PREFIX}:`);
}

function decodeCustomIdPart(part) {
    try {
        return decodeURIComponent(part);
    } catch {
        return part;
    }
}

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');

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
        userId: extraParts[0] || null,
        messageId: extraParts[1] || null,
        mode: extraParts[2] || null,
        parts: extraParts
    };
}

module.exports = {
    CUSTOM_ID_PREFIX,
    EVENT_TYPES,
    normalizeEventType,
    getEventTypeConfig,
    getMaxAccountsForType,
    buildCustomId,
    isSeasonEventCustomId,
    parseCustomId
};
