const CUSTOM_ID_PREFIX = 'link_list:v1';
const MODE_TAGS = 'tags';
const MODE_NAMES = 'names';

function normalizeMode(mode) {
    return mode === MODE_NAMES ? MODE_NAMES : MODE_TAGS;
}

function normalizeCustomIdClanTag(clanTag) {
    return String(clanTag || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/^#/, '')
        .replace(/O/g, '0');
}

function buildLinkListViewCustomId(clanTag, mode) {
    const cleanClanTag = normalizeCustomIdClanTag(clanTag);

    return `${CUSTOM_ID_PREFIX}:view:${normalizeMode(mode)}:${cleanClanTag}`;
}

function buildLinkListSwitchCustomId(mode) {
    return `${CUSTOM_ID_PREFIX}:switch:${normalizeMode(mode)}`;
}

function buildLinkListRefreshCustomId(clanTag, mode) {
    const cleanClanTag = normalizeCustomIdClanTag(clanTag);

    return `${CUSTOM_ID_PREFIX}:refresh:${normalizeMode(mode)}:${cleanClanTag}`;
}

function buildLinkListClanValue(clanTag) {
    return `clan:${normalizeCustomIdClanTag(clanTag)}`;
}

function parseLinkListViewCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'link_list' || parts[1] !== 'v1' || parts[2] !== 'view') {
        return null;
    }

    const clanTag = normalizeCustomIdClanTag(parts[4]);

    if (!clanTag) {
        return null;
    }

    return {
        action: 'view',
        mode: normalizeMode(parts[3]),
        clanTag: `#${clanTag}`
    };
}

function parseLinkListSwitchCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'link_list' || parts[1] !== 'v1' || parts[2] !== 'switch') {
        return null;
    }

    return {
        action: 'switch',
        mode: normalizeMode(parts[3])
    };
}

function parseLinkListRefreshCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'link_list' || parts[1] !== 'v1' || parts[2] !== 'refresh') {
        return null;
    }

    const clanTag = normalizeCustomIdClanTag(parts[4]);

    if (!clanTag) {
        return null;
    }

    return {
        action: 'refresh',
        mode: normalizeMode(parts[3]),
        clanTag: `#${clanTag}`
    };
}

function parseLinkListClanValue(value) {
    const parts = String(value || '').split(':');

    if (parts[0] !== 'clan') {
        return '';
    }

    const clanTag = normalizeCustomIdClanTag(parts[1]);

    return clanTag ? `#${clanTag}` : '';
}

function isLinkListCustomId(customId) {
    return String(customId || '').startsWith(`${CUSTOM_ID_PREFIX}:`);
}

module.exports = {
    CUSTOM_ID_PREFIX,
    MODE_TAGS,
    MODE_NAMES,
    normalizeMode,
    normalizeCustomIdClanTag,
    buildLinkListViewCustomId,
    buildLinkListSwitchCustomId,
    buildLinkListRefreshCustomId,
    buildLinkListClanValue,
    parseLinkListViewCustomId,
    parseLinkListSwitchCustomId,
    parseLinkListRefreshCustomId,
    parseLinkListClanValue,
    isLinkListCustomId
};
