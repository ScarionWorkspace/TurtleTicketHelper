const { decodePublicDataKeys } = require('../rosterPublicData/rosterPublicDataReadClient');
const {
    getOrderedRosters,
    normalizePlayerTag
} = require('../rosterPlayers/rosterPlayersData');
const {
    isValidClashTag,
    normalizeClashTag
} = require('../clashApi/fetchClanMembers');

const ACTIVE_ROSTER_SECTIONS = ['main', 'subs'];
const ROSTER_SECTIONS = ['main', 'subs', 'missing'];

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

function getRosterTitle(roster) {
    return String(roster?.title || roster?.id || 'Clan').trim() || 'Clan';
}

function getSelectableClanRosters(payload) {
    const seenClanTags = new Set();
    const rosters = [];

    for (const roster of getOrderedRosters(payload)) {
        const clanTag = normalizeClashTag(roster?.connectedClanTag);

        if (!clanTag || !isValidClashTag(clanTag) || seenClanTags.has(clanTag)) {
            continue;
        }

        seenClanTags.add(clanTag);
        rosters.push(roster);
    }

    return rosters;
}

function findRosterByClanTag(payload, clanTag) {
    const wantedTag = normalizeClashTag(clanTag);

    if (!wantedTag) {
        return null;
    }

    return getSelectableClanRosters(payload).find(roster =>
        normalizeClashTag(roster?.connectedClanTag) === wantedTag
    ) || null;
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
        return '';
    }

    return String(player.name || '').trim();
}

function buildPlayerMetricsByTag(playerMetrics) {
    const decodedPlayerMetrics = decodePublicDataKeys(playerMetrics);
    const source =
        decodedPlayerMetrics?.byTag && typeof decodedPlayerMetrics.byTag === 'object'
            ? decodedPlayerMetrics.byTag
            : decodedPlayerMetrics && typeof decodedPlayerMetrics === 'object'
                ? decodedPlayerMetrics
                : {};

    return Object.entries(source).reduce((metricsByTag, [key, metric]) => {
        const tag = normalizePlayerTag(metric?.identity?.tag || metric?.latestSnapshot?.tag || key);

        if (tag && metric && typeof metric === 'object') {
            metricsByTag[tag] = metric;
        }

        return metricsByTag;
    }, {});
}

function buildRosterLookupByTag(roster) {
    const lookup = new Map();
    let activeOrder = 0;
    let poolOrder = 0;

    for (const sectionName of ROSTER_SECTIONS) {
        const isActiveSection = ACTIVE_ROSTER_SECTIONS.includes(sectionName);

        for (const player of asArray(roster?.[sectionName])) {
            const tag = getPlayerTag(player);

            if (!tag || lookup.has(tag)) {
                if (isActiveSection) {
                    activeOrder++;
                }

                poolOrder++;
                continue;
            }

            lookup.set(tag, {
                tag,
                player,
                sectionName,
                activeOrder: isActiveSection ? activeOrder : null,
                poolOrder
            });

            if (isActiveSection) {
                activeOrder++;
            }

            poolOrder++;
        }
    }

    return lookup;
}

function normalizeLiveClanMembers(liveMembers) {
    const seen = new Set();
    const members = [];

    for (const [index, member] of (Array.isArray(liveMembers) ? liveMembers : []).entries()) {
        const tag = normalizePlayerTag(member?.tag);

        if (!tag || seen.has(tag)) {
            continue;
        }

        seen.add(tag);
        members.push({
            tag,
            name: String(member?.name || '').trim() || tag,
            clanRank: Number.isFinite(Number(member?.clanRank))
                ? Math.floor(Number(member.clanRank))
                : null,
            apiOrder: Number.isFinite(Number(member?.apiOrder))
                ? Math.floor(Number(member.apiOrder))
                : index
        });
    }

    return members;
}

function readIdentity(metric) {
    const identity = metric?.identity && typeof metric.identity === 'object'
        ? metric.identity
        : {};

    return {
        discordId: String(identity.discordId || '').trim(),
        discordUsername: String(identity.discordUsername || '').trim(),
        name: String(identity.name || '').trim()
    };
}

function readLatestSnapshot(metric) {
    const latest = metric?.latestSnapshot && typeof metric.latestSnapshot === 'object'
        ? metric.latestSnapshot
        : {};

    return {
        name: String(latest.name || '').trim()
    };
}

function getDiscordServerPresence(discordPresenceById, discordId) {
    const key = String(discordId || '').trim();

    if (!key || !discordPresenceById || typeof discordPresenceById !== 'object') {
        return null;
    }

    if (!Object.prototype.hasOwnProperty.call(discordPresenceById, key)) {
        return null;
    }

    const presence = discordPresenceById[key];

    if (typeof presence === 'boolean' || presence === null) {
        return presence;
    }

    if (presence && typeof presence === 'object' && typeof presence.inServer === 'boolean') {
        return presence.inServer;
    }

    return null;
}

function buildLinkListPlayerRows(roster, playerMetrics, liveMembers, options = {}) {
    const metricsByTag = buildPlayerMetricsByTag(playerMetrics);
    const rosterLookupByTag = buildRosterLookupByTag(roster);
    const discordPresenceById = options.discordPresenceById || {};

    return normalizeLiveClanMembers(liveMembers).map(member => {
        const metric = metricsByTag[member.tag] || null;
        const identity = readIdentity(metric);
        const latest = readLatestSnapshot(metric);
        const rosterEntry = rosterLookupByTag.get(member.tag) || null;
        const rosterPlayerName = getPlayerName(rosterEntry?.player);
        const inGameName =
            member.name ||
            latest.name ||
            identity.name ||
            rosterPlayerName ||
            member.tag;
        const linked = Boolean(identity.discordId || identity.discordUsername);
        const inDiscordServer = linked
            ? getDiscordServerPresence(discordPresenceById, identity.discordId)
            : null;

        return {
            tag: member.tag,
            inGameName,
            discordId: identity.discordId,
            discordUsername: identity.discordUsername,
            linked,
            inDiscordServer,
            sourceSection: rosterEntry?.sectionName || 'live',
            activeRosterOrder: rosterEntry?.activeOrder,
            rosterPoolOrder: rosterEntry?.poolOrder,
            clanRank: member.clanRank,
            liveOrder: member.apiOrder
        };
    });
}

function getSortBucket(row) {
    if (Number.isInteger(row?.activeRosterOrder)) {
        return {
            bucket: 0,
            order: row.activeRosterOrder
        };
    }

    if (Number.isFinite(row?.clanRank) && row.clanRank > 0) {
        return {
            bucket: 1,
            order: row.clanRank
        };
    }

    return {
        bucket: 2,
        order: Number.isFinite(row?.liveOrder) ? row.liveOrder : Number.MAX_SAFE_INTEGER
    };
}

function compareLinkListRows(left, right) {
    const leftSort = getSortBucket(left);
    const rightSort = getSortBucket(right);

    if (leftSort.bucket !== rightSort.bucket) {
        return leftSort.bucket - rightSort.bucket;
    }

    if (leftSort.order !== rightSort.order) {
        return leftSort.order - rightSort.order;
    }

    return String(left?.tag || '').localeCompare(String(right?.tag || ''));
}

function buildLinkListModel(roster, playerMetrics, liveMembers, options = {}) {
    const rows = buildLinkListPlayerRows(roster, playerMetrics, liveMembers, options);
    const linked = rows
        .filter(row => row.linked && row.inDiscordServer !== false)
        .sort(compareLinkListRows);
    const linkedNotInServer = rows
        .filter(row => row.linked && row.inDiscordServer === false)
        .sort(compareLinkListRows);
    const notLinked = rows.filter(row => !row.linked).sort(compareLinkListRows);

    return {
        clanTag: normalizeClashTag(roster?.connectedClanTag),
        rosterTitle: getRosterTitle(roster),
        linked,
        linkedNotInServer,
        notLinked,
        total: rows.length
    };
}

module.exports = {
    ACTIVE_ROSTER_SECTIONS,
    ROSTER_SECTIONS,
    asArray,
    getRosterTitle,
    getSelectableClanRosters,
    findRosterByClanTag,
    getPlayerTag,
    getPlayerName,
    buildPlayerMetricsByTag,
    buildRosterLookupByTag,
    normalizeLiveClanMembers,
    getDiscordServerPresence,
    buildLinkListPlayerRows,
    compareLinkListRows,
    buildLinkListModel
};
