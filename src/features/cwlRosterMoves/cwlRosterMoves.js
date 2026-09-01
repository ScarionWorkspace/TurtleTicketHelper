const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const {
    buildPlayerMetricsByTag,
    getDiscordIdForPlayer,
    getOrderedRosters,
    getPlayerName,
    getPlayerTag,
    getRosterPlayers
} = require('../rosterPlayers/rosterPlayersData');
const {
    fetchClanMembers,
    normalizeClashTag
} = require('../clashApi/fetchClanMembers');

const EPHEMERAL = 64;
const MESSAGE_MAX_CHARS = 1900;
const MAX_USER_MENTIONS_PER_MESSAGE = 100;
const DISCORD_ID_PATTERN = /^\d{17,20}$/;

function isCwlDestinationRoster(roster) {
    return String(roster?.trackingMode || '').trim().toLowerCase() === 'cwl' &&
        Boolean(normalizeClashTag(roster?.connectedClanTag));
}

function getCwlDestinationRosters(payload) {
    return getOrderedRosters(payload).filter(isCwlDestinationRoster);
}

function selectCwlDestinationRosters(payload, rosterId = '') {
    const rosters = getCwlDestinationRosters(payload);
    const selectedRosterId = String(rosterId || '').trim();

    return selectedRosterId
        ? rosters.filter(roster => String(roster?.id || '').trim() === selectedRosterId)
        : rosters;
}

function formatRosterChoice(roster) {
    const title = String(roster?.title || roster?.id || 'Roster').trim() || 'Roster';
    const clanTag = normalizeClashTag(roster?.connectedClanTag);

    return `${title}${clanTag ? ` (${clanTag})` : ''}`.slice(0, 100);
}

async function autocompleteCwlRosterClan(interaction, options = {}) {
    const readActiveRosterPayload = options.readActiveRosterPayload ||
        rosterPublicData.readActiveRosterPayload;
    const focused = String(interaction.options?.getFocused?.() || '').trim().toLowerCase();
    const payload = await readActiveRosterPayload({
        cacheTtlMs: 15_000,
        timeoutMs: 2_500
    });
    const choices = getCwlDestinationRosters(payload)
        .filter(roster => {
            if (!focused) {
                return true;
            }

            return `${roster.id || ''} ${roster.title || ''} ${roster.connectedClanTag || ''}`
                .toLowerCase()
                .includes(focused);
        })
        .slice(0, 25)
        .map(roster => ({
            name: formatRosterChoice(roster),
            value: String(roster.id).slice(0, 100)
        }));

    await interaction.respond(choices);
}

function getRequiredClanTags(rosters) {
    return [...new Set((Array.isArray(rosters) ? rosters : [])
        .map(roster => normalizeClashTag(roster?.connectedClanTag))
        .filter(Boolean))];
}

async function fetchRequiredClanSnapshots(rosters, options = {}) {
    const fetchMembers = options.fetchClanMembers || fetchClanMembers;
    const clanTags = getRequiredClanTags(rosters);
    const results = await Promise.all(clanTags.map(async clanTag => {
        try {
            const snapshot = await fetchMembers(clanTag);
            return { clanTag, snapshot };
        } catch (error) {
            return { clanTag, error };
        }
    }));
    const failedClanTags = results
        .filter(result => result.error)
        .map(result => result.clanTag);

    if (failedClanTags.length > 0) {
        const error = new Error('CWL_CLAN_LOOKUP_FAILED');
        error.failedClanTags = failedClanTags;
        throw error;
    }

    return new Map(results.map(result => [result.clanTag, result.snapshot]));
}

function getSnapshotForClan(snapshotsByClanTag, clanTag) {
    if (snapshotsByClanTag instanceof Map) {
        return snapshotsByClanTag.get(clanTag);
    }

    return snapshotsByClanTag?.[clanTag];
}

function buildCwlRosterMovePlan(rosters, playerMetrics, snapshotsByClanTag) {
    const metricsByTag = buildPlayerMetricsByTag(playerMetrics);
    const groups = [];

    for (const roster of Array.isArray(rosters) ? rosters : []) {
        const clanTag = normalizeClashTag(roster?.connectedClanTag);
        const snapshot = getSnapshotForClan(snapshotsByClanTag, clanTag);

        if (!snapshot || !Array.isArray(snapshot.members)) {
            throw new Error(`MISSING_CLAN_SNAPSHOT:${clanTag}`);
        }

        const currentMemberTags = new Set(snapshot.members.map(member =>
            getPlayerTag(member)
        ).filter(Boolean));
        const seenPlayerTags = new Set();
        const movers = [];
        const playersWithoutTags = [];

        for (const player of getRosterPlayers(roster)) {
            const playerTag = getPlayerTag(player);

            if (!playerTag) {
                playersWithoutTags.push({ name: getPlayerName(player) });
                continue;
            }

            if (seenPlayerTags.has(playerTag)) {
                continue;
            }

            seenPlayerTags.add(playerTag);

            if (currentMemberTags.has(playerTag)) {
                continue;
            }

            const discordId = getDiscordIdForPlayer(player, metricsByTag);

            movers.push({
                name: getPlayerName(player),
                playerTag,
                discordId: DISCORD_ID_PATTERN.test(discordId) ? discordId : ''
            });
        }

        if (movers.length > 0 || playersWithoutTags.length > 0) {
            groups.push({
                rosterId: String(roster?.id || '').trim(),
                rosterTitle: String(roster?.title || roster?.id || 'Roster').trim() || 'Roster',
                clanTag,
                movers,
                playersWithoutTags
            });
        }
    }

    const allMovers = groups.flatMap(group => group.movers);
    const pingableDiscordIds = [...new Set(allMovers
        .map(mover => mover.discordId)
        .filter(Boolean))];

    return {
        groups,
        movingAccountCount: allMovers.length,
        pingableMemberCount: pingableDiscordIds.length,
        unlinkedAccountCount: allMovers.filter(mover => !mover.discordId).length,
        playersWithoutTagsCount: groups.reduce(
            (total, group) => total + group.playersWithoutTags.length,
            0
        )
    };
}

async function scanCwlRosterMoves(payload, options = {}) {
    const rosters = selectCwlDestinationRosters(payload, options.rosterId);
    const snapshots = await fetchRequiredClanSnapshots(rosters, options);

    return {
        rosters,
        plan: buildCwlRosterMovePlan(rosters, payload?.playerMetrics, snapshots)
    };
}

function truncate(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function formatMoverLine(mover) {
    const destination = mover.discordId
        ? `<@${mover.discordId}>`
        : 'no linked Discord ID';

    return `- ${mover.name} (\`${mover.playerTag}\`) / ${destination}`;
}

function formatMissingTagLine(player) {
    return `- ${player.name} / missing player tag (could not verify)`;
}

function splitGroupLines(group) {
    const title = truncate(group.rosterTitle, 180);
    const firstHeader = `**CWL move needed - ${title} (${group.clanTag})**`;
    const continuedHeader = `**CWL move needed - ${title} (continued)**`;
    const lines = [
        ...group.movers.map(mover => ({
            text: formatMoverLine(mover),
            discordId: mover.discordId
        })),
        ...group.playersWithoutTags.map(player => ({
            text: formatMissingTagLine(player),
            discordId: ''
        }))
    ];
    const chunks = [];
    let currentLines = [];
    let currentDiscordIds = new Set();

    for (const line of lines) {
        const header = chunks.length === 0 ? firstHeader : continuedHeader;
        const candidateLines = [...currentLines, line];
        const candidateContent = `${header}\n${candidateLines.map(entry => entry.text).join('\n')}`;
        const candidateDiscordIds = new Set(currentDiscordIds);

        if (line.discordId) {
            candidateDiscordIds.add(line.discordId);
        }

        if (
            currentLines.length > 0 &&
            (
                candidateContent.length > MESSAGE_MAX_CHARS ||
                candidateDiscordIds.size > MAX_USER_MENTIONS_PER_MESSAGE
            )
        ) {
            chunks.push({ header, lines: currentLines });
            currentLines = [line];
            currentDiscordIds = new Set(line.discordId ? [line.discordId] : []);
            continue;
        }

        currentLines = candidateLines;
        currentDiscordIds = candidateDiscordIds;
    }

    if (currentLines.length > 0) {
        const header = chunks.length === 0 ? firstHeader : continuedHeader;
        chunks.push({ header, lines: currentLines });
    }

    return chunks;
}

function buildCwlRosterMoveMessages(plan) {
    const messages = [];
    const alreadyPingedDiscordIds = new Set();

    for (const group of plan?.groups || []) {
        for (const chunk of splitGroupLines(group)) {
            const users = [];

            for (const line of chunk.lines) {
                if (
                    line.discordId &&
                    !alreadyPingedDiscordIds.has(line.discordId)
                ) {
                    alreadyPingedDiscordIds.add(line.discordId);
                    users.push(line.discordId);
                }
            }

            messages.push({
                content: `${chunk.header}\n${chunk.lines.map(line => line.text).join('\n')}`,
                allowedMentions: {
                    parse: [],
                    users,
                    roles: []
                }
            });
        }
    }

    return messages;
}

function formatClanLookupFailure(error) {
    const failedClanTags = Array.isArray(error?.failedClanTags)
        ? error.failedClanTags
        : [];
    const suffix = failedClanTags.length > 0
        ? ` Failed clan${failedClanTags.length === 1 ? '' : 's'}: ${failedClanTags.join(', ')}.`
        : '';

    return `I could not verify every destination clan, so no move pings were sent.${suffix}`;
}

function buildCompletionSummary(plan, messageCount) {
    const parts = [
        `Posted ${messageCount} move notice${messageCount === 1 ? '' : 's'} for ` +
        `${plan.movingAccountCount} Clash account${plan.movingAccountCount === 1 ? '' : 's'} and ` +
        `pinged ${plan.pingableMemberCount} linked Discord member${plan.pingableMemberCount === 1 ? '' : 's'}.`
    ];

    if (plan.unlinkedAccountCount > 0) {
        parts.push(
            `${plan.unlinkedAccountCount} moving account${plan.unlinkedAccountCount === 1 ? '' : 's'} ` +
            `${plan.unlinkedAccountCount === 1 ? 'has' : 'have'} no linked Discord ID.`
        );
    }

    if (plan.playersWithoutTagsCount > 0) {
        parts.push(
            `${plan.playersWithoutTagsCount} roster entr${plan.playersWithoutTagsCount === 1 ? 'y is' : 'ies are'} ` +
            'missing a player tag and could not be verified.'
        );
    }

    return parts.join(' ');
}

async function pingCwlRosterMoves(interaction, options = {}) {
    const readActiveRosterPayload = options.readActiveRosterPayload ||
        rosterPublicData.readActiveRosterPayload;

    await interaction.deferReply({ flags: EPHEMERAL });

    if (!interaction.channel || typeof interaction.channel.send !== 'function') {
        await interaction.editReply('This command can only post move pings in a server channel.');
        return;
    }

    const payload = await readActiveRosterPayload({
        cacheTtlMs: 0,
        timeoutMs: 12_000
    });

    if (!payload) {
        await interaction.editReply('I could not read the active CWL rosters. No move pings were sent.');
        return;
    }

    const selectedRosterId = String(
        interaction.options?.getString?.('clan') || options.rosterId || ''
    ).trim();
    const rosters = selectCwlDestinationRosters(payload, selectedRosterId);

    if (rosters.length === 0) {
        await interaction.editReply(
            selectedRosterId
                ? 'That CWL destination clan is no longer available. No move pings were sent.'
                : 'No active CWL rosters with connected destination clans are available.'
        );
        return;
    }

    let plan;

    try {
        const snapshots = await fetchRequiredClanSnapshots(rosters, options);
        plan = buildCwlRosterMovePlan(rosters, payload.playerMetrics, snapshots);
    } catch (error) {
        await interaction.editReply(formatClanLookupFailure(error));
        return;
    }

    if (plan.movingAccountCount === 0 && plan.playersWithoutTagsCount === 0) {
        await interaction.editReply(
            'Every planned CWL player is already in the correct destination clan. No pings were sent.'
        );
        return;
    }

    const messages = buildCwlRosterMoveMessages(plan);

    for (const message of messages) {
        await interaction.channel.send(message);
    }

    await interaction.editReply(buildCompletionSummary(plan, messages.length));
}

module.exports = {
    EPHEMERAL,
    MESSAGE_MAX_CHARS,
    isCwlDestinationRoster,
    getCwlDestinationRosters,
    selectCwlDestinationRosters,
    formatRosterChoice,
    autocompleteCwlRosterClan,
    getRequiredClanTags,
    fetchRequiredClanSnapshots,
    buildCwlRosterMovePlan,
    scanCwlRosterMoves,
    buildCwlRosterMoveMessages,
    buildCompletionSummary,
    pingCwlRosterMoves
};
