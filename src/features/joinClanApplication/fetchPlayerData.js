const { COC_API_TOKEN } = require('../../config/env');

const VALID_TAG_CHARS = /^[#PYLQGRJCUV0289]+$/i;
const DEFAULT_TIMEOUT_MS = 12_000;

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    cleaned = cleaned.replace(/O/g, '0');

    return cleaned;
}

function isValidPlayerTag(tag) {
    return VALID_TAG_CHARS.test(tag);
}

async function fetchPlayerData(playerTag, options = {}) {
    if (!COC_API_TOKEN) {
        throw new Error('COC_API_TOKEN is missing in .env');
    }

    const normalizedTag = normalizePlayerTag(playerTag);

    if (!isValidPlayerTag(normalizedTag)) {
        throw new Error('INVALID_PLAYER_TAG');
    }

    const encodedTag = encodeURIComponent(normalizedTag);
    const url = `https://api.clashofclans.com/v1/players/${encodedTag}`;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let response;

    try {
        response = await fetch(url, {
            headers: {
                Authorization: `Bearer ${COC_API_TOKEN}`,
                Accept: 'application/json'
            },
            signal: controller.signal
        });
    } catch (error) {
        if (error?.name === 'AbortError') {
            throw new Error('CLASH_API_TIMEOUT');
        }

        throw new Error('CLASH_API_REQUEST_FAILED');
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) {
        if (response.status === 404) {
            throw new Error('PLAYER_NOT_FOUND');
        }

        throw new Error(`CLASH_API_HTTP_${response.status}`);
    }

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error('CLASH_API_INVALID_JSON');
    }

    if (!data || typeof data !== 'object') {
        throw new Error('CLASH_API_INVALID_RESPONSE');
    }

    return {
        tag: data.tag || normalizedTag,
        name: data.name || 'Unknown',
        townHallLevel: data.townHallLevel ?? 'Unknown',
        expLevel: data.expLevel ?? 'Unknown',
        trophies: data.trophies ?? 'Unknown',
        bestTrophies: data.bestTrophies ?? 'Unknown',
        warStars: data.warStars ?? 'Unknown',
        attackWins: data.attackWins ?? 'Unknown',
        defenseWins: data.defenseWins ?? 'Unknown',
        donations: data.donations ?? 'Unknown',
        donationsReceived: data.donationsReceived ?? 'Unknown',
        clanName: data.clan?.name || 'No Clan',
        clanTag: data.clan?.tag || null,
        currentLeague: data.leagueTier?.name || 'Unknown',
        currentLeagueIcon: data.leagueTier?.iconUrls?.large || null
    };
}

module.exports = {
    fetchPlayerData,
    normalizePlayerTag,
    isValidPlayerTag
};
