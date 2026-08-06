'use strict';

const PREFIX = 'wfu';
const VERSION = '1';
const MAX_CUSTOM_ID_LENGTH = 100;

function encodeSegment(value) {
    return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64url');
}

function decodeSegment(value) {
    try {
        return Buffer.from(String(value || ''), 'base64url').toString('utf8');
    } catch {
        return '';
    }
}

function buildCustomId(actionRaw, ...values) {
    const action = String(actionRaw || '').trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,24}$/.test(action)) throw new Error('Invalid war follow-up action ID.');
    const customId = [PREFIX, VERSION, action, ...values.map(encodeSegment)].join(':');
    if (customId.length > MAX_CUSTOM_ID_LENGTH) {
        throw new Error(`War follow-up custom ID exceeds ${MAX_CUSTOM_ID_LENGTH} characters.`);
    }
    return customId;
}

function isWarFollowupCustomId(value) {
    return String(value || '').startsWith(`${PREFIX}:${VERSION}:`);
}

function parseCustomId(value) {
    const parts = String(value || '').split(':');
    if (parts[0] !== PREFIX || parts[1] !== VERSION || !parts[2]) return null;
    return {
        action: parts[2],
        values: parts.slice(3).map(decodeSegment)
    };
}

module.exports = {
    PREFIX,
    VERSION,
    MAX_CUSTOM_ID_LENGTH,
    encodeSegment,
    decodeSegment,
    buildCustomId,
    isWarFollowupCustomId,
    parseCustomId
};
