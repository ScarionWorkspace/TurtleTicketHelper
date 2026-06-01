const { decodeFirebaseKeys } = require('../rosterFirebase/rosterFirebaseReadClient');

const ROSTER_SECTIONS = ['main', 'subs', 'missing'];
const PLAYER_LIST_MAX_CHARS = 1900;

function normalizeClashTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned;
}

function normalizePlayerTag(tag) {
    let cleaned = normalizeClashTag(tag);

    if (!cleaned) {
        return '';
    }

    return cleaned.replace(/O/g, '0');
}

function asArray(value) {
    if (!value) {
        return [];
    }

    if (Array.isArray(value)) {
        return value.filter(Boolean);
    }

    if (typeof value === 'object') {
        return Object.values(value).filter(Boolean);
    }

    return [];
}

function normalizeActiveRosterPayload(payload) {
    const decoded = decodeFirebaseKeys(payload);

    return decoded && typeof decoded === 'object' ? decoded : {};
}

function getRosterId(value, fallback = '') {
    if (value === null || value === undefined) {
        return fallback;
    }

    if (typeof value === 'object') {
        return String(value.id || value.rosterId || value.key || fallback || '').trim();
    }

    return String(value).trim();
}

function buildRosterMap(rosters) {
    const entries = Array.isArray(rosters)
        ? rosters.map((roster, index) => [getRosterId(roster, String(index)), roster])
        : Object.entries(rosters || {});

    return entries.reduce((map, [key, roster]) => {
        if (!roster || typeof roster !== 'object') {
            return map;
        }

        const id = getRosterId(roster, key);

        if (!id) {
            return map;
        }

        map.set(id, {
            ...roster,
            id
        });
        return map;
    }, new Map());
}

function getOrderedRosters(payload) {
    const activePayload = normalizeActiveRosterPayload(payload);
    const rosterMap = buildRosterMap(activePayload.rosters);
    const ordered = [];
    const seen = new Set();

    for (const orderEntry of asArray(activePayload.rosterOrder)) {
        const rosterId = getRosterId(orderEntry);

        if (!rosterId || seen.has(rosterId) || !rosterMap.has(rosterId)) {
            continue;
        }

        ordered.push(rosterMap.get(rosterId));
        seen.add(rosterId);
    }

    for (const [rosterId, roster] of rosterMap.entries()) {
        if (!seen.has(rosterId)) {
            ordered.push(roster);
        }
    }

    return ordered;
}

function getRosterPlayers(roster) {
    if (!roster || typeof roster !== 'object') {
        return [];
    }

    return ROSTER_SECTIONS.flatMap(sectionName => asArray(roster[sectionName]));
}

function getPlayerTag(player) {
    if (typeof player === 'string') {
        return normalizePlayerTag(player);
    }

    return normalizePlayerTag(
        player?.tag ||
        player?.playerTag ||
        player?.accountTag ||
        player?.clashTag ||
        ''
    );
}

function getPlayerName(player) {
    if (!player || typeof player !== 'object') {
        return 'Unknown player';
    }

    return String(player.name || '').trim() || 'Unknown player';
}

function buildPlayerMetricsByTag(playerMetrics) {
    const decodedPlayerMetrics = decodeFirebaseKeys(playerMetrics);
    const source =
        decodedPlayerMetrics?.byTag && typeof decodedPlayerMetrics.byTag === 'object'
            ? decodedPlayerMetrics.byTag
            : {};

    return Object.entries(source).reduce((metricsByTag, [key, metric]) => {
        const tag = normalizePlayerTag(metric?.identity?.tag || key);

        if (tag) {
            metricsByTag[tag] = metric;
        }

        return metricsByTag;
    }, {});
}

function getDiscordIdForPlayer(player, metricsByTag) {
    const tag = getPlayerTag(player);
    const discordId = tag ? metricsByTag[tag]?.identity?.discordId : null;

    return String(discordId || '').trim();
}

function formatRosterPlayerLines(roster, playerMetrics) {
    const metricsByTag = buildPlayerMetricsByTag(playerMetrics);

    return getRosterPlayers(roster).map(player => {
        const name = getPlayerName(player);
        const discordId = getDiscordIdForPlayer(player, metricsByTag);

        return `${name} / ${discordId ? `<@${discordId}>` : 'no linked Discord ID'}`;
    });
}

function formatRawRosterPlayerLines(roster, playerMetrics) {
    return formatRosterPlayerLines(roster, playerMetrics).map(line => `- ${line}`);
}

function chunkLines(lines, maxChars = PLAYER_LIST_MAX_CHARS) {
    const chunks = [];
    let current = '';

    for (const line of lines) {
        const text = String(line);
        const next = current ? `${current}\n${text}` : text;

        if (current && next.length > maxChars) {
            chunks.push(current);
            current = text;
            continue;
        }

        current = next;
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}

module.exports = {
    PLAYER_LIST_MAX_CHARS,
    normalizeClashTag,
    normalizePlayerTag,
    normalizeActiveRosterPayload,
    getOrderedRosters,
    getRosterPlayers,
    formatRosterPlayerLines,
    formatRawRosterPlayerLines,
    chunkLines
};
