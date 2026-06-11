const { COC_API_TOKEN } = require('../../config/env');

const DEFAULT_TIMEOUT_MS = 12_000;
const VALID_TAG_CHARS = /^#[PYLQGRJCUV0289]{3,15}$/i;

function normalizeClashTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned.replace(/O/g, '0');
}

function isValidClashTag(tag) {
    return VALID_TAG_CHARS.test(normalizeClashTag(tag));
}

function toIntegerOrNull(value) {
    const number = Number(value);

    return Number.isFinite(number) ? Math.floor(number) : null;
}

function mapClanMember(member, index) {
    const tag = normalizeClashTag(member?.tag);

    if (!tag) {
        return null;
    }

    return {
        tag,
        name: String(member?.name || '').trim() || tag,
        townHallLevel: toIntegerOrNull(member?.townHallLevel),
        trophies: toIntegerOrNull(member?.trophies),
        clanRank: toIntegerOrNull(member?.clanRank),
        previousClanRank: toIntegerOrNull(member?.previousClanRank),
        role: String(member?.role || '').trim(),
        apiOrder: index
    };
}

function mapClanMembers(items) {
    const seen = new Set();
    const members = [];

    for (const [index, item] of (Array.isArray(items) ? items : []).entries()) {
        const member = mapClanMember(item, index);

        if (!member || seen.has(member.tag)) {
            continue;
        }

        seen.add(member.tag);
        members.push(member);
    }

    return members;
}

async function fetchClanMembers(clanTag, options = {}) {
    if (!COC_API_TOKEN) {
        throw new Error('COC_API_TOKEN is missing in .env');
    }

    const normalizedTag = normalizeClashTag(clanTag);

    if (!isValidClashTag(normalizedTag)) {
        throw new Error('INVALID_CLAN_TAG');
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const fetchImpl = options.fetchImpl || fetch;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    const encodedTag = encodeURIComponent(normalizedTag);
    const url = `https://api.clashofclans.com/v1/clans/${encodedTag}/members?limit=50`;
    let response;

    try {
        response = await fetchImpl(url, {
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
            throw new Error('CLAN_NOT_FOUND');
        }

        throw new Error(`CLASH_API_HTTP_${response.status}`);
    }

    let data;

    try {
        data = await response.json();
    } catch {
        throw new Error('CLASH_API_INVALID_JSON');
    }

    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
        throw new Error('CLASH_API_INVALID_RESPONSE');
    }

    return {
        clanTag: normalizedTag,
        capturedAt: new Date().toISOString(),
        members: mapClanMembers(data.items)
    };
}

module.exports = {
    fetchClanMembers,
    mapClanMembers,
    normalizeClashTag,
    isValidClashTag
};
