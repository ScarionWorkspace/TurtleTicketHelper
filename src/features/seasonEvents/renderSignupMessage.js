const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const appConfig = require('../../config/appConfig');
const {
    buildCustomId,
    getEventTypeConfig
} = require('./constants');
const {
    extractLeaderboardRows,
    getActiveParticipants,
    getAccountRowsForParticipant,
    getEventSeasonId,
    getLeaderboardRowsByTag,
    normalizePlayerTag
} = require('./eventData');

const MAX_SIGNUPS = 50;

function truncate(value, maxLength) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toLocaleString('en-US');
    }

    return String(value ?? '').trim();
}

function getScoreLabel(row, fallbackAccount, type) {
    const explicit =
        row?.scoreLabel ||
        row?.metricLabel ||
        row?.displayScore ||
        row?.scoreText ||
        row?.valueLabel ||
        null;

    if (explicit) {
        return String(explicit);
    }

    if (type === 'push') {
        const leagueLabel =
            row?.bestLeagueName ||
            row?.bestLeagueLabel ||
            row?.leagueName ||
            row?.leagueLabel ||
            fallbackAccount?.bestLeagueName ||
            fallbackAccount?.bestLeagueLabel ||
            fallbackAccount?.leagueName ||
            fallbackAccount?.leagueLabel ||
            '';
        const trophies =
            row?.bestTrophies ??
            row?.score ??
            row?.value ??
            fallbackAccount?.bestTrophies ??
            fallbackAccount?.score ??
            fallbackAccount?.trophies ??
            null;

        if (trophies !== null && trophies !== undefined && trophies !== '') {
            const trophyLabel = `${formatNumber(trophies)} trophies`;

            return leagueLabel ? `${leagueLabel} - ${trophyLabel}` : trophyLabel;
        }
    }

    const rawValue =
        row?.score ??
        row?.metric ??
        row?.value ??
        row?.total ??
        fallbackAccount?.score ??
        fallbackAccount?.metric ??
        fallbackAccount?.trophies ??
        null;

    if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
        return formatNumber(rawValue);
    }

    return 'pending';
}

function getLeaderboardFallbackRows(leaderboard, type) {
    return extractLeaderboardRows(leaderboard).map(row => ({
        rank: row?.rank || null,
        tag: normalizePlayerTag(row?.playerTag || row?.tag || row?.accountTag || row?.account?.tag || ''),
        townHall: row?.townHallLevel || row?.townHall || row?.th || row?.account?.townHallLevel || null,
        scoreLabel: getScoreLabel(row, null, type),
        name:
            row?.displayName ||
            row?.playerName ||
            row?.name ||
            row?.accountName ||
            row?.account?.name ||
            'Unknown'
    }));
}

function buildAllConfirmedRows(event, leaderboard, type) {
    const leaderboardRows = getLeaderboardFallbackRows(leaderboard, type);

    if (type === 'push' && leaderboardRows.length > 0) {
        return leaderboardRows;
    }

    const rowsByTag = getLeaderboardRowsByTag(leaderboard);
    const activeParticipants = getActiveParticipants(event);
    const rows = [];

    for (const participant of activeParticipants) {
        for (const account of getAccountRowsForParticipant(participant)) {
            const leaderboardRow = account.tag ? rowsByTag.get(account.tag) : null;
            rows.push({
                rank: leaderboardRow?.rank || null,
                tag: account.tag,
                townHall: account.townHall,
                scoreLabel: getScoreLabel(leaderboardRow, account, type),
                name: account.name
            });
        }
    }

    if (rows.length === 0) {
        rows.push(...leaderboardRows);
    }

    return rows;
}

function formatConfirmedTable(rows, type) {
    if (rows.length === 0) {
        return 'No confirmed signups yet.';
    }

    const typeConfig = getEventTypeConfig(type);
    const metric = truncate(typeConfig?.metricLabel || 'Score', 10).padEnd(10, ' ');
    const lines = [
        `#  TH    ${metric} Player`
    ];

    rows.forEach((row, index) => {
        const th = row.townHall ? `TH${row.townHall}` : '-';
        const score = truncate(row.scoreLabel || 'pending', 10).padEnd(10, ' ');
        const name = truncate(row.name || row.tag || 'Unknown', 24);

        const rank = row.rank || index + 1;

        lines.push(`${String(rank).padEnd(2, ' ')} ${th.padEnd(5, ' ')} ${score} ${name}`);
    });

    return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
}

function getClanIdentity(event) {
    const clanName =
        event?.clanName ||
        event?.clan?.name ||
        event?.familyName ||
        'Turtle Roster';
    const clanTag = event?.clanTag || event?.clan?.tag || '';
    const season = event?.seasonName || event?.seasonLabel || getEventSeasonId(event) || '';
    const seasonLabel = typeof season === 'string' || typeof season === 'number'
        ? season
        : '';

    return [clanName, clanTag, seasonLabel].filter(Boolean).join(' | ');
}

function getTownHallRange(rows, event) {
    const configuredMin = event?.minTownHall || event?.minTownHallLevel || null;
    const configuredMax = event?.maxTownHall || event?.maxTownHallLevel || null;

    if (configuredMin || configuredMax) {
        return configuredMin === configuredMax
            ? `TH ${configuredMin}`
            : `TH ${configuredMin || '?'}-${configuredMax || '?'}`;
    }

    const townHalls = rows
        .map(row => Number(row.townHall))
        .filter(value => Number.isFinite(value) && value > 0);

    if (townHalls.length === 0) {
        return null;
    }

    const min = Math.min(...townHalls);
    const max = Math.max(...townHalls);

    return min === max ? `TH ${min}` : `TH ${min}-${max}`;
}

function formatDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return String(value);
    }

    return date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
    });
}

function getDonationCycleRange(event) {
    const cycles = Array.isArray(event?.donationCycles)
        ? event.donationCycles
        : Object.values(event?.donationCycles || {});

    if (cycles.length === 0) {
        const start = formatDate(event?.startsAt);
        const end = formatDate(event?.endsAt);

        return start || end
            ? `${start || '?'} - ${end || '?'}`
            : 'Cycle dates unknown';
    }

    const cycle =
        cycles.find(item => ['active', 'current', 'open'].includes(String(item?.status || '').toLowerCase())) ||
        cycles[0];
    const start =
        cycle?.startDate ||
        cycle?.cycleStartDate ||
        cycle?.startsAt ||
        cycle?.from ||
        null;
    const end =
        cycle?.endDate ||
        cycle?.cycleEndDate ||
        cycle?.endsAt ||
        cycle?.to ||
        null;

    if (!start && !end) {
        return 'Cycle dates unknown';
    }

    return `${formatDate(start) || '?'} - ${formatDate(end) || '?'}`;
}

function getFooterText(event, rows, type) {
    const activeParticipants = getActiveParticipants(event);
    const participantCount =
        activeParticipants.length ||
        event?.confirmedCount ||
        event?.participantCount ||
        event?.signupCount ||
        0;

    if (type === 'donation') {
        const accountCount =
            activeParticipants.reduce(
                (total, participant) => total + getAccountRowsForParticipant(participant).length,
                0
            ) ||
            event?.selectedAccountCount ||
            event?.accountCount ||
            rows.length ||
            0;

        return `Total ${participantCount}/${MAX_SIGNUPS} | Accounts selected ${accountCount} | ${getDonationCycleRange(event)}`;
    }

    const townHallRange = getTownHallRange(rows, event);

    return `Total ${participantCount}/${MAX_SIGNUPS}${townHallRange ? ` | ${townHallRange}` : ''}`;
}

function getConfirmedCount(event, rows) {
    const activeParticipants = getActiveParticipants(event);
    return activeParticipants.length ||
        event?.confirmedCount ||
        event?.participantCount ||
        event?.signupCount ||
        rows.length ||
        0;
}

function buildSignupComponents(type) {
    const labels = appConfig.seasonEvents?.labels || {};

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buildCustomId('refresh', type))
                .setEmoji('🔄')
                .setLabel(labels.refresh || 'Refresh')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(buildCustomId('signup', type))
                .setEmoji('✅')
                .setLabel(labels.signup || 'Signup')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(buildCustomId('optout', type))
                .setEmoji('❌')
                .setLabel(labels.optOut || 'Opt-out')
                .setStyle(ButtonStyle.Danger),
            new ButtonBuilder()
                .setCustomId(buildCustomId('options', type))
                .setEmoji('⚙️')
                .setLabel(labels.options || 'Options')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

function buildMissingEventMessage(type) {
    const typeConfig = getEventTypeConfig(type);
    const colors = appConfig.seasonEvents?.colors || {};

    return {
        embeds: [
            new EmbedBuilder()
                .setColor(colors.warning ?? 0xF59E0B)
                .setTitle(typeConfig?.title || 'Season Event')
                .setDescription('No current roster season event is available.')
                .setTimestamp()
        ],
        components: buildSignupComponents(type)
    };
}

function buildSignupMessage(type, event, leaderboard = null) {
    if (!event) {
        return buildMissingEventMessage(type);
    }

    const typeConfig = getEventTypeConfig(type);
    const colors = appConfig.seasonEvents?.colors || {};
    const maxRows = appConfig.seasonEvents?.maxLeaderboardRows || 10;
    const allRows = buildAllConfirmedRows(event, leaderboard, type);
    const rows = allRows.slice(0, maxRows);
    const title = event.title || typeConfig?.title || 'Season Event';
    const status = String(event.status || '').trim();
    const signupsOpen = event.signupsOpen === false ? 'Signups closed' : 'Signups open';

    const embed = new EmbedBuilder()
        .setColor(colors[type] ?? colors.neutral ?? 0x95A5A6)
        .setAuthor({ name: getClanIdentity(event) })
        .setTitle(title)
        .setDescription([
            status ? `Status: ${status}` : null,
            signupsOpen
        ].filter(Boolean).join('\n'))
        .addFields({
            name: `Confirmed - ${getConfirmedCount(event, rows)}`,
            value: formatConfirmedTable(rows, type),
            inline: false
        })
        .setFooter({
            text: getFooterText(event, allRows, type)
        })
        .setTimestamp();

    if (appConfig.seasonEvents?.websiteLeaderboardUrl) {
        embed.setURL(appConfig.seasonEvents.websiteLeaderboardUrl);
    }

    return {
        embeds: [embed],
        components: buildSignupComponents(type)
    };
}

module.exports = {
    buildSignupMessage,
    buildSignupComponents
};
