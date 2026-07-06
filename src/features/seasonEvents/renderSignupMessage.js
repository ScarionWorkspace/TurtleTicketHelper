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
    getLeaderboardRowsByTag,
    normalizePlayerTag
} = require('./eventData');

const MAX_SIGNUPS = 50;
const INFO_MESSAGE_MAX_LENGTH = 900;

function truncate(value, maxLength) {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function truncatePreservingLines(value, maxLength) {
    const text = String(value ?? '').trim();

    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function normalizeInfoText(value) {
    return String(value ?? '')
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join('\n');
}

function getConfiguredInfoMessage(type) {
    const messages = appConfig.seasonEvents?.infoMessages || {};
    return normalizeInfoText(messages[type]) ||
        'Sign up to participate in the current season event.';
}

function getEventInfoMessage(event, type) {
    const eventInfo = normalizeInfoText(
        event?.description ||
        event?.infoMessage ||
        event?.signupInfoMessage ||
        event?.settings?.description ||
        event?.settings?.infoMessage ||
        event?.settings?.signupInfoMessage
    );
    const text = eventInfo || getConfiguredInfoMessage(type);

    return truncatePreservingLines(text, INFO_MESSAGE_MAX_LENGTH);
}

function parseEventDate(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? null : date;
}

function formatDiscordTimestamp(value, style) {
    const date = parseEventDate(value);

    if (!date) {
        return null;
    }

    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

function formatEventTimeLine(label, value) {
    const absolute = formatDiscordTimestamp(value, 'f');
    const relative = formatDiscordTimestamp(value, 'R');

    if (absolute && relative) {
        return `**${label}:** ${absolute} (${relative})`;
    }

    if (value) {
        return `**${label}:** ${String(value).trim()}`;
    }

    return `**${label}:** TBA`;
}

function buildEventWindowField(event) {
    return {
        name: 'Event Window',
        value: [
            formatEventTimeLine('Start', event?.startsAt),
            formatEventTimeLine('End', event?.endsAt)
        ].join('\n'),
        inline: false
    };
}

function formatStatusText(status) {
    return String(status || '')
        .trim()
        .replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, char => char.toUpperCase());
}

function getStatusDescription(event) {
    const lines = [
        event?.signupsOpen === false
            ? '**\u26D4 Signups closed**'
            : '**\u2705 Signups open**'
    ];
    const cwlState = String(event?.cwlTrackingState || event?.cwlStatus || '').trim().toLowerCase();

    if (cwlState) {
        if (cwlState === 'waiting') lines.push('CWL status: waiting for the next CWL.');
        else if (cwlState === 'active') lines.push('CWL status: active provisional standings.');
        else if (cwlState === 'finalizing') lines.push('CWL status: finalizing; standings await confirmation.');
        else if (cwlState === 'completed') lines.push('CWL status: completed standings.');
    }

    if (event?.cwl?.stale) {
        const refreshed = event?.cwl?.lastSuccessfulRefreshAt
            ? ` Last successful refresh: ${event.cwl.lastSuccessfulRefreshAt}.`
            : '';
        lines.push(`CWL standings are stale.${refreshed}`);
    }

    const status = String(event?.status || '').trim();

    if (status && status.toLowerCase() !== 'open') {
        lines.push(`Event status: ${formatStatusText(status)}`);
    }

    return lines.join('\n');
}

function getCurrentEventHeader(type) {
    const eventName = type === 'donation'
        ? 'Donation'
        : type === 'push'
            ? 'Push'
            : type === 'cwl'
                ? 'CWL'
                : 'Season';

    return `Current ${eventName} Event`;
}

function getSignupTitle(event, typeConfig) {
    const configuredTitle = String(typeConfig?.title || '').trim();
    const title = String(event?.title || '').trim();

    if (title && title.toLowerCase() !== configuredTitle.toLowerCase()) {
        return truncate(title, 256);
    }

    return 'Signup & Leaderboard';
}

function formatNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value.toLocaleString('en-US');
    }

    return String(value ?? '').trim();
}

function stripDonationUnit(value) {
    return String(value ?? '')
        .replace(/\bdonations?\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeLeagueLabel(value) {
    const label = String(value || '').trim();

    if (!label) {
        return '';
    }

    if (/^[A-Z]\d+$/i.test(label)) {
        return label.toUpperCase();
    }

    const legendMatch = label.match(/^legends?\s+(i{1,3})$/i);

    if (legendMatch) {
        const roman = legendMatch[1].toUpperCase();
        const legendTier = { I: 1, II: 2, III: 3 }[roman];

        return legendTier ? `L${legendTier}` : label;
    }

    const namedTierMatch = label.match(/^([A-Za-z.]+)\s+(\d+)$/);

    if (namedTierMatch) {
        const leagueName = namedTierMatch[1].replace(/\./g, '');
        const tier = Number(namedTierMatch[2]);

        if (leagueName && Number.isFinite(tier)) {
            return `${leagueName[0].toUpperCase()}${tier}`;
        }
    }

    return label;
}

function getDonationValue(row, fallbackAccount = null) {
    const rawValue =
        row?.score ??
        row?.metric ??
        row?.value ??
        row?.total ??
        fallbackAccount?.score ??
        fallbackAccount?.metric ??
        null;

    if (rawValue !== null && rawValue !== undefined && rawValue !== '') {
        return stripDonationUnit(formatNumber(rawValue));
    }

    const explicit =
        row?.scoreLabel ||
        row?.metricLabel ||
        row?.displayScore ||
        row?.scoreText ||
        row?.valueLabel ||
        null;

    if (explicit) {
        return stripDonationUnit(explicit);
    }

    return 'pending';
}

function parseNumberValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    const normalized = String(value ?? '').replace(/,/g, '');
    const match = normalized.match(/\d+(?:\.\d+)?/);

    return match ? Number(match[0]) : 0;
}

function formatDonationDisplayValue(value) {
    const text = stripDonationUnit(value);
    const numericValue = parseNumberValue(text);

    if (numericValue >= 100000) {
        return `${Math.trunc(numericValue / 1000)}k`;
    }

    return text || 'pending';
}

function getPushLeagueValue(row, fallbackAccount = null) {
    const leagueLabel =
        row?.currentLeagueLabel ||
        row?.currentLeagueName ||
        row?.leagueLabel ||
        row?.leagueName ||
        fallbackAccount?.currentLeagueLabel ||
        fallbackAccount?.currentLeagueName ||
        fallbackAccount?.leagueLabel ||
        fallbackAccount?.leagueName ||
        '';

    if (leagueLabel) {
        return normalizeLeagueLabel(leagueLabel);
    }

    const explicit = String(row?.scoreLabel || row?.displayScore || '').trim();
    const compactMatch = explicit.match(/^([A-Z]\d+)\s+\d/i);

    return compactMatch ? compactMatch[1].toUpperCase() : '-';
}

function getPushTrophyValue(row, fallbackAccount = null) {
    const trophies =
        row?.currentTrophies ??
        row?.score ??
        row?.value ??
        row?.trophies ??
        fallbackAccount?.currentTrophies ??
        fallbackAccount?.score ??
        fallbackAccount?.trophies ??
        null;

    if (trophies !== null && trophies !== undefined && trophies !== '') {
        return formatNumber(trophies).replace(/\btrophies?\b/gi, '').trim();
    }

    const explicit = String(row?.scoreLabel || row?.displayScore || '').trim();
    const trophyMatch =
        explicit.match(/(?:^|\s)(\d[\d,]*)\s*trophies?\b/i) ||
        explicit.match(/^[A-Z]\d+\s+(\d[\d,]*)$/i);

    return trophyMatch ? trophyMatch[1] : '0';
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
        return type === 'donation'
            ? getDonationValue(row, fallbackAccount)
            : String(explicit);
    }

    if (type === 'push') {
        const leagueLabel = getPushLeagueValue(row, fallbackAccount);
        const trophies = getPushTrophyValue(row, fallbackAccount);

        if (trophies) {
            return leagueLabel && leagueLabel !== '-' ? `${leagueLabel} ${trophies}` : trophies;
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

function getPrimaryAccount(row) {
    if (row?.account && typeof row.account === 'object') {
        return row.account;
    }

    if (Array.isArray(row?.accounts)) {
        return row.accounts.find(account => account && typeof account === 'object') || null;
    }

    return null;
}

function getLeaderboardRowName(row) {
    const account = getPrimaryAccount(row);

    return account?.playerName ||
        account?.name ||
        account?.accountName ||
        account?.identity?.name ||
        row?.playerName ||
        row?.name ||
        row?.accountName ||
        row?.displayName ||
        'Unknown';
}

function getLeaderboardFallbackRows(leaderboard, type) {
    return extractLeaderboardRows(leaderboard).map(row => ({
        rank: row?.rank || null,
        tag: normalizePlayerTag(row?.playerTag || row?.tag || row?.accountTag || row?.account?.tag || ''),
        townHall: row?.townHallLevel || row?.townHall || row?.th || row?.account?.townHallLevel || null,
        donationValue: getDonationValue(row),
        leagueLabel: getPushLeagueValue(row),
        trophies: getPushTrophyValue(row),
        scoreLabel: getScoreLabel(row, null, type),
        cwlStats: row?.cwlStats || row?.account?.cwlStats || null,
        name: getLeaderboardRowName(row)
    }));
}

function getDonationSortValue(row) {
    return parseNumberValue(
        row?.donationValue ??
        row?.score ??
        row?.metric ??
        row?.value ??
        row?.total ??
        row?.scoreLabel
    );
}

function getSortRank(row) {
    const rank = Number(row?.rank);

    return Number.isFinite(rank) && rank > 0 ? rank : Number.POSITIVE_INFINITY;
}

function compareDonationRows(a, b) {
    const aRank = getSortRank(a);
    const bRank = getSortRank(b);

    if (aRank !== bRank) {
        return aRank - bRank;
    }

    const donationDiff = getDonationSortValue(b) - getDonationSortValue(a);

    if (donationDiff !== 0) {
        return donationDiff;
    }

    const nameDiff = String(a?.name || '')
        .toLowerCase()
        .localeCompare(String(b?.name || '').toLowerCase());

    if (nameDiff !== 0) {
        return nameDiff;
    }

    return String(a?.tag || '').localeCompare(String(b?.tag || ''));
}

function getParticipantSummaryName(participant, fallbackRow = null, fallbackAccount = null) {
    return participant?.discordDisplayName ||
        participant?.discordGlobalName ||
        participant?.discordUsername ||
        fallbackRow?.displayName ||
        fallbackRow?.name ||
        fallbackAccount?.name ||
        fallbackAccount?.tag ||
        'Unknown';
}

function buildAllConfirmedRows(event, leaderboard, type) {
    const leaderboardRows = getLeaderboardFallbackRows(leaderboard, type);

    if ((type === 'push' || type === 'cwl') && leaderboardRows.length > 0) {
        return leaderboardRows;
    }

    const rowsByTag = getLeaderboardRowsByTag(leaderboard);
    const activeParticipants = getActiveParticipants(event);
    const rows = [];

    for (const participant of activeParticipants) {
        const accountRows = getAccountRowsForParticipant(participant);
        const mappedRows = accountRows.map(account => ({
            account,
            leaderboardRow: account.tag ? rowsByTag.get(account.tag) : null
        }));

        if (
            type === 'donation' &&
            accountRows.length > 1 &&
            mappedRows.some(item => item.leaderboardRow) &&
            !mappedRows.every(item => item.leaderboardRow?.hasAccountScore === true)
        ) {
            const summaryRow = mappedRows.find(item => item.leaderboardRow)?.leaderboardRow;
            const fallbackAccount = mappedRows.find(item => item.account)?.account;
            rows.push({
                rank: summaryRow?.rank || null,
                tag: '',
                townHall: null,
                donationValue: getDonationValue(summaryRow),
                leagueLabel: '',
                trophies: '0',
                scoreLabel: getScoreLabel(summaryRow, null, type),
                name: getParticipantSummaryName(participant, summaryRow, fallbackAccount)
            });
            continue;
        }

        for (const { account, leaderboardRow } of mappedRows) {
            rows.push({
                rank: leaderboardRow?.rank || null,
                tag: account.tag,
                townHall: account.townHall,
                donationValue: getDonationValue(leaderboardRow, account),
                leagueLabel: getPushLeagueValue(leaderboardRow, account),
                trophies: getPushTrophyValue(leaderboardRow, account),
                scoreLabel: getScoreLabel(leaderboardRow, account, type),
                name: account.name
            });
        }
    }

    if (rows.length === 0) {
        rows.push(...leaderboardRows);
    }

    if (type === 'donation') {
        return [...rows].sort(compareDonationRows);
    }

    return rows;
}

function formatDonationTable(rows) {
    const lines = [
        '#  Donos Player'
    ];

    rows.forEach((row, index) => {
        const donationValue = formatDonationDisplayValue(
            row.donationValue || row.scoreLabel || 'pending'
        );
        const donos = truncate(donationValue, 6).padEnd(6, ' ');
        const name = truncate(row.name || row.tag || 'Unknown', 24);
        const rank = row.rank || index + 1;

        lines.push(`${String(rank).padEnd(2, ' ')} ${donos} ${name}`);
    });

    return lines;
}

function formatPushTable(rows) {
    const lines = [
        '#  🏆  🥇    Player'
    ];

    rows.forEach((row, index) => {
        const league = truncate(row.leagueLabel || '-', 4).padEnd(4, ' ');
        const trophies = truncate(row.trophies || row.scoreLabel || '0', 6).padEnd(6, ' ');
        const name = truncate(row.name || row.tag || 'Unknown', 24);
        const rank = row.rank || index + 1;

        lines.push(`${String(rank).padEnd(2, ' ')} ${league} ${trophies} ${name}`);
    });

    return lines;
}

function getCwlStatValue(row, key) {
    const stats = row?.cwlStats && typeof row.cwlStats === 'object' ? row.cwlStats : {};
    if (key === 'defenseStarsConceded') {
        const value = Number(stats.defenseStarsConceded ?? stats.bestStarsConceded);

        return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
    }
    const value = Number(stats[key]);

    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function formatCwlTable(rows) {
    const lines = [
        '#  Stars DStars Player'
    ];

    rows.forEach((row, index) => {
        const stars = truncate(String(getCwlStatValue(row, 'starsTotal')), 5).padEnd(5, ' ');
        const defenseStars = truncate(String(getCwlStatValue(row, 'defenseStarsConceded')), 6).padEnd(6, ' ');
        const name = truncate(row.name || row.tag || 'Unknown', 22);
        const rank = row.rank || index + 1;

        lines.push(`${String(rank).padEnd(2, ' ')} ${stars} ${defenseStars} ${name}`);
    });

    return lines;
}

function formatConfirmedTable(rows, type) {
    if (rows.length === 0) {
        return 'No confirmed signups yet.';
    }

    const lines = type === 'push'
        ? formatPushTable(rows)
        : type === 'cwl'
            ? formatCwlTable(rows)
            : formatDonationTable(rows);

    return `\`\`\`text\n${lines.join('\n')}\n\`\`\``;
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

function getFooterText(event, rows, type) {
    const activeParticipants = getActiveParticipants(event);
    const participantCount =
        activeParticipants.length ||
        event?.activeParticipantCount ||
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
            event?.accountCount ||
            event?.selectedAccountCount ||
            rows.length ||
            0;

        return `Confirmed ${participantCount}/${MAX_SIGNUPS} | Accounts selected ${accountCount} | Multi-account ranks can repeat`;
    }

    if (type === 'cwl') {
        const cwlState = String(event?.cwlTrackingState || event?.cwlStatus || '').trim().toLowerCase();
        const stateLabel = cwlState ? formatStatusText(cwlState) : 'Waiting';
        return `Confirmed ${participantCount}/${MAX_SIGNUPS} | CWL ${stateLabel} | Backend-ranked standings`;
    }

    const townHallRange = getTownHallRange(rows, event);

    return `Confirmed ${participantCount}/${MAX_SIGNUPS}${townHallRange ? ` | ${townHallRange}` : ''}`;
}

function getConfirmedCount(event, rows) {
    const activeParticipants = getActiveParticipants(event);
    return activeParticipants.length ||
        event?.activeParticipantCount ||
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

    const embed = new EmbedBuilder()
        .setColor(colors[type] ?? colors.neutral ?? 0x95A5A6)
        .setAuthor({ name: getCurrentEventHeader(type) })
        .setTitle(getSignupTitle(event, typeConfig))
        .setDescription(getStatusDescription(event))
        .addFields(
            buildEventWindowField(event),
            {
                name: 'Event Info',
                value: getEventInfoMessage(event, type),
                inline: false
            }
        )
        .addFields({
            name: `Confirmed Signups - ${getConfirmedCount(event, allRows)}`,
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
