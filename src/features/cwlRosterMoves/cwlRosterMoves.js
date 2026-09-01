const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const warFollowupService = require('../warFollowup/service');
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
const {
    buildClanProfileUrl
} = require('../rosterPlayers/rosterPlayersMessage');

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

function buildIgnoredPlayerFilters(playerMetrics, ignoredPlayerTags = []) {
    const metricsByTag = buildPlayerMetricsByTag(playerMetrics);
    const playerTags = new Set((Array.isArray(ignoredPlayerTags) ? ignoredPlayerTags : [])
        .map(getPlayerTag)
        .filter(Boolean));
    const discordIds = new Set();

    for (const playerTag of playerTags) {
        const discordId = String(metricsByTag[playerTag]?.identity?.discordId || '').trim();

        if (DISCORD_ID_PATTERN.test(discordId)) {
            discordIds.add(discordId);
        }
    }

    return { playerTags, discordIds };
}

function getAlwaysIgnoredPlayerTags(privateState) {
    return Array.isArray(privateState?.settings?.trustedPlayerTags)
        ? privateState.settings.trustedPlayerTags.map(getPlayerTag).filter(Boolean)
        : [];
}

function buildCwlRosterMovePlan(
    rosters,
    playerMetrics,
    snapshotsByClanTag,
    ignoredPlayerTags = []
) {
    const metricsByTag = buildPlayerMetricsByTag(playerMetrics);
    const ignored = buildIgnoredPlayerFilters(playerMetrics, ignoredPlayerTags);
    const groups = [];
    let alwaysIgnoredAccountCount = 0;

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
            const normalizedDiscordId = DISCORD_ID_PATTERN.test(discordId) ? discordId : '';

            if (
                ignored.playerTags.has(playerTag) ||
                (normalizedDiscordId && ignored.discordIds.has(normalizedDiscordId))
            ) {
                alwaysIgnoredAccountCount += 1;
                continue;
            }

            movers.push({
                name: getPlayerName(player),
                playerTag,
                discordId: normalizedDiscordId
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
        alwaysIgnoredAccountCount,
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
        plan: buildCwlRosterMovePlan(
            rosters,
            payload?.playerMetrics,
            snapshots,
            options.ignoredPlayerTags
        )
    };
}

function truncate(value, maxLength) {
    const text = String(value || '');
    return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function formatMoverLine(mover) {
    if (mover.discordId) {
        return `- Hey <@${mover.discordId}> - we've saved **${mover.name}** ` +
            `(\`${mover.playerTag}\`) a CWL spot here. Please use the clan link above to move over.`;
    }

    return `- **${mover.name}** (\`${mover.playerTag}\`) also has a CWL spot here, ` +
        'but there is no linked Discord member to ping.';
}

function formatMissingTagLine(player) {
    return `- ${player.name} / missing player tag (could not verify)`;
}

function buildClanDestinationHeader(group, continued = false) {
    const title = truncate(group.rosterTitle, 180);
    const clanUrl = buildClanProfileUrl(group.clanTag);
    const heading = continued
        ? `## ${title} - CWL moves continued`
        : `## ${title} - your CWL clan`;
    const link = clanUrl
        ? `**Move here:** [Open ${title} in Clash of Clans](${clanUrl})`
        : `**Destination clan:** ${group.clanTag}`;

    return `${heading}\n${link}`;
}

function buildClanLinkComponents(group) {
    const clanUrl = buildClanProfileUrl(group?.clanTag);

    if (!clanUrl) {
        return [];
    }

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel(truncate(`Open ${group.rosterTitle} in-game`, 80))
                .setStyle(ButtonStyle.Link)
                .setURL(clanUrl)
        )
    ];
}

function splitGroupLines(group) {
    const firstHeader = buildClanDestinationHeader(group);
    const continuedHeader = buildClanDestinationHeader(group, true);
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
                components: buildClanLinkComponents(group),
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

    if (plan.alwaysIgnoredAccountCount > 0) {
        parts.push(
            `Skipped ${plan.alwaysIgnoredAccountCount} out-of-clan account` +
            `${plan.alwaysIgnoredAccountCount === 1 ? '' : 's'} covered by War Follow Up's Always ignore setting.`
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

function buildTestModeSummary(plan, messageCount) {
    const parts = [
        '**Private test preview - nothing was posted and nobody was pinged.**',
        `A live send would post ${messageCount} move notice${messageCount === 1 ? '' : 's'} for ` +
        `${plan.movingAccountCount} Clash account${plan.movingAccountCount === 1 ? '' : 's'} and ` +
        `ping ${plan.pingableMemberCount} linked Discord member${plan.pingableMemberCount === 1 ? '' : 's'}.`
    ];

    if (plan.unlinkedAccountCount > 0) {
        parts.push(
            `${plan.unlinkedAccountCount} moving account${plan.unlinkedAccountCount === 1 ? '' : 's'} ` +
            `${plan.unlinkedAccountCount === 1 ? 'has' : 'have'} no linked Discord ID.`
        );
    }

    if (plan.alwaysIgnoredAccountCount > 0) {
        parts.push(
            `${plan.alwaysIgnoredAccountCount} out-of-clan account` +
            `${plan.alwaysIgnoredAccountCount === 1 ? ' is' : 's are'} excluded by War Follow Up's Always ignore setting.`
        );
    }

    return parts.join(' ');
}

function buildPrivatePreviewPayload(message) {
    return {
        ...message,
        flags: EPHEMERAL,
        allowedMentions: {
            parse: [],
            users: [],
            roles: []
        }
    };
}

async function sendPrivateTestPreview(interaction, plan, messages) {
    await interaction.editReply({
        content: buildTestModeSummary(plan, messages.length),
        allowedMentions: { parse: [], users: [], roles: [] }
    });

    for (const message of messages) {
        await interaction.followUp(buildPrivatePreviewPayload(message));
    }
}

async function pingCwlRosterMoves(interaction, options = {}) {
    const readActiveRosterPayload = options.readActiveRosterPayload ||
        rosterPublicData.readActiveRosterPayload;
    const readWarFollowupPrivateState = options.readWarFollowupPrivateState ||
        warFollowupService.readPrivateState;

    const testMode = interaction.options?.getBoolean?.('test') === true ||
        options.testMode === true;

    await interaction.deferReply({ flags: EPHEMERAL });

    if (
        !testMode &&
        (!interaction.channel || typeof interaction.channel.send !== 'function')
    ) {
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

    let ignoredPlayerTags;

    try {
        const privateState = await readWarFollowupPrivateState({
            force: true,
            timeoutMs: 12_000
        });
        ignoredPlayerTags = getAlwaysIgnoredPlayerTags(privateState);
    } catch {
        await interaction.editReply(
            'I could not verify War Follow Up\'s Always ignore list, so no move pings were sent.'
        );
        return;
    }

    let plan;

    try {
        const snapshots = await fetchRequiredClanSnapshots(rosters, options);
        plan = buildCwlRosterMovePlan(
            rosters,
            payload.playerMetrics,
            snapshots,
            ignoredPlayerTags
        );
    } catch (error) {
        await interaction.editReply(formatClanLookupFailure(error));
        return;
    }

    if (plan.movingAccountCount === 0 && plan.playersWithoutTagsCount === 0) {
        await interaction.editReply(
            plan.alwaysIgnoredAccountCount > 0
                ? `No move pings were sent. ${plan.alwaysIgnoredAccountCount} out-of-clan account` +
                    `${plan.alwaysIgnoredAccountCount === 1 ? ' is' : 's are'} covered by War Follow Up's Always ignore setting.`
                : 'Every planned CWL player is already in the correct destination clan. No pings were sent.'
        );
        return;
    }

    const messages = buildCwlRosterMoveMessages(plan);

    if (testMode) {
        await sendPrivateTestPreview(interaction, plan, messages);
        return;
    }

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
    buildIgnoredPlayerFilters,
    getAlwaysIgnoredPlayerTags,
    buildCwlRosterMovePlan,
    scanCwlRosterMoves,
    buildClanDestinationHeader,
    buildClanLinkComponents,
    buildCwlRosterMoveMessages,
    buildCompletionSummary,
    buildTestModeSummary,
    buildPrivatePreviewPayload,
    sendPrivateTestPreview,
    pingCwlRosterMoves
};
