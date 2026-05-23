const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const COVERAGE_PRIORITY = {
    'missing-cycle-ledger': 5,
    'no-history': 4,
    'missing-current': 3,
    'missing-baseline': 2,
    partial: 1,
    full: 0
};
const DONATION_CYCLE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,120}$/;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INVALID_RANK_TIER = 0;

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned.replace(/O/g, '0');
}

function toNonNegativeInt(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number <= 0) {
        return 0;
    }

    return Math.floor(number);
}

function parseIsoToMs(value) {
    if (!value) {
        return 0;
    }

    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
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

function uniqueWarnings(warnings) {
    return [...new Set(warnings.filter(Boolean))];
}

function sanitizeParticipantStatus(status) {
    const normalized = String(status || '').trim().toLowerCase().replace(/-/g, '_');

    if (normalized === 'cancelled') {
        return 'cancelled';
    }

    if (normalized === 'removed') {
        return 'removed';
    }

    return 'signed_up';
}

function sanitizeParticipant(participant) {
    const seenTags = new Set();
    const accounts = [];

    for (const account of asArray(participant?.accounts)) {
        const tag = normalizePlayerTag(
            account?.tag ||
            account?.playerTag ||
            account?.accountTag ||
            account?.clashTag ||
            ''
        );

        if (!tag || seenTags.has(tag)) {
            continue;
        }

        seenTags.add(tag);
        accounts.push({
            ...account,
            tag,
            playerTag: tag
        });
    }

    return {
        discordId: participant?.discordId || '',
        discordUsername: participant?.discordUsername || '',
        discordGlobalName: participant?.discordGlobalName || '',
        discordDisplayName: participant?.discordDisplayName || '',
        status: sanitizeParticipantStatus(participant?.status),
        accounts
    };
}

function sanitizeParticipants(event) {
    return asArray(event?.participantsByDiscordId).map(sanitizeParticipant);
}

function buildPlayerMetricsByTag(metricsByTag) {
    const normalized = {};
    const source =
        metricsByTag?.playerMetrics?.byTag && typeof metricsByTag.playerMetrics.byTag === 'object'
            ? metricsByTag.playerMetrics.byTag
            : metricsByTag?.byTag && typeof metricsByTag.byTag === 'object'
                ? metricsByTag.byTag
                : metricsByTag;

    if (!source || typeof source !== 'object') {
        return normalized;
    }

    for (const [key, metric] of Object.entries(source)) {
        const tag = normalizePlayerTag(metric?.identity?.tag || key);

        if (tag) {
            normalized[tag] = metric;
        }
    }

    return normalized;
}

function getAccountDisplay(account, metricEntry) {
    const identity = metricEntry?.identity || {};
    const latest = metricEntry?.latestSnapshot || {};

    return {
        name: identity.name || latest.name || account.name || account.playerName || account.tag,
        townHallLevel: latest.townHallLevel ?? latest.th ?? account.townHallLevel ?? account.th ?? null,
        leagueName:
            latest.league?.name ||
            latest.leagueTier?.name ||
            account.leagueName ||
            ''
    };
}

function formatPushScoreLabel(leagueLabel, trophies) {
    const trophyLabel = `${trophies} trophies`;
    const league = String(leagueLabel || '').trim();

    return league ? `${league} - ${trophyLabel}` : trophyLabel;
}

function formatDonationScore(score) {
    return `${score} donations`;
}

function getPointCapturedMs(point) {
    for (const fieldName of [
        'capturedAt',
        'captured_at',
        'snapshotAt',
        'updatedAt',
        'createdAt',
        'lastSeenAt',
        'fetchedAt',
        'collectedAt',
        'date'
    ]) {
        const capturedMs = parseIsoToMs(point?.[fieldName]);

        if (capturedMs > 0) {
            return capturedMs;
        }
    }

    if (DAY_KEY_PATTERN.test(String(point?.dayKey || ''))) {
        return new Date(`${point.dayKey}T00:00:00.000Z`).getTime();
    }

    return 0;
}

function getPointTrophies(point) {
    return toNonNegativeInt(
        point?.trophies ??
        point?.trophyCount ??
        point?.bestTrophies ??
        0
    );
}

function getLeagueTierId(point) {
    return point?.leagueTier?.id ??
        point?.leagueTierId ??
        point?.leagueTierID ??
        point?.bestLeagueTierId ??
        point?.bestLeagueTierID ??
        null;
}

function getRankTierFromLeagueTierId(leagueTierId) {
    const id = String(leagueTierId ?? '').trim();

    if (!/^\d+$/.test(id)) {
        return INVALID_RANK_TIER;
    }

    const rankTier = Number(id.slice(-2));

    return Number.isFinite(rankTier) && rankTier > 0
        ? rankTier
        : INVALID_RANK_TIER;
}

function getLeagueDisplayFallback(point) {
    return String(
        point?.bestLeagueName ||
        point?.bestLeagueLabel ||
        point?.leagueName ||
        point?.leagueLabel ||
        point?.leagueTierName ||
        point?.league?.name ||
        point?.league?.label ||
        point?.leagueTier?.name ||
        point?.leagueTier?.label ||
        ''
    ).trim();
}

function getLeagueTierLabel(rankTier, fallback = '') {
    switch (rankTier) {
        case 36:
            return 'Legends I';
        case 35:
            return 'Legends II';
        case 34:
            return 'Legends III';
        case 27:
        case 26:
        case 25:
            return `Titan ${rankTier}`;
        default:
            return rankTier > 0 ? `Tier ${rankTier}` : String(fallback || '').trim();
    }
}

function hasValidLeagueBucket(value) {
    return Number.isFinite(value) && value > INVALID_RANK_TIER;
}

function getSortableLeagueBucket(value) {
    return hasValidLeagueBucket(value) ? value : INVALID_RANK_TIER;
}

function comparePushPoints(a, b) {
    const aBucket = getSortableLeagueBucket(a.leagueBucket);
    const bBucket = getSortableLeagueBucket(b.leagueBucket);

    if (aBucket !== bBucket) {
        return bBucket - aBucket;
    }

    const trophyDiff = b.trophies - a.trophies;

    if (trophyDiff !== 0) {
        return trophyDiff;
    }

    return b.capturedMs - a.capturedMs;
}

function buildHistoryPoints(metricEntry) {
    const history = metricEntry?.trophyHistoryDaily;

    if (!history) {
        return [];
    }

    if (Array.isArray(history)) {
        return history.filter(Boolean);
    }

    if (typeof history !== 'object') {
        return [];
    }

    return Object.entries(history)
        .filter(([, point]) => point && typeof point === 'object')
        .map(([dayKey, point]) => ({
            ...point,
            dayKey: point.dayKey || dayKey
        }));
}

function collectTrophyPoints(metricEntry) {
    const points = [];
    const latest = metricEntry?.latestSnapshot || {};
    const latestRankTier = getRankTierFromLeagueTierId(getLeagueTierId(latest));
    const latestLeagueFallback = getLeagueDisplayFallback(latest);

    for (const point of buildHistoryPoints(metricEntry)) {
        const capturedMs = getPointCapturedMs(point);
        const rankTier =
            getRankTierFromLeagueTierId(getLeagueTierId(point)) ||
            latestRankTier;
        const leagueLabel = getLeagueTierLabel(
            rankTier,
            getLeagueDisplayFallback(point) || latestLeagueFallback
        );

        if (capturedMs > 0) {
            points.push({
                trophies: getPointTrophies(point),
                leagueName: leagueLabel,
                leagueLabel,
                leagueBucket: rankTier,
                capturedMs,
                source: 'trophyHistoryDaily'
            });
        }
    }

    if (Object.prototype.hasOwnProperty.call(latest, 'trophies')) {
        const capturedMs = getPointCapturedMs(latest);
        const leagueLabel = getLeagueTierLabel(latestRankTier, latestLeagueFallback);

        if (capturedMs > 0) {
            points.push({
                trophies: getPointTrophies(latest),
                leagueName: leagueLabel,
                leagueLabel,
                leagueBucket: latestRankTier,
                capturedMs,
                source: 'latestSnapshot'
            });
        }
    }

    return points.sort((a, b) =>
        a.capturedMs - b.capturedMs ||
        a.trophies - b.trophies ||
        a.source.localeCompare(b.source)
    );
}

function noPushHistoryAccount(account, metricEntry, warnings = ['missing-trophy-history']) {
    const display = getAccountDisplay(account, metricEntry);

    return {
        tag: account.tag,
        name: display.name,
        townHallLevel: display.townHallLevel,
        leagueName: display.leagueName,
        startValue: 0,
        currentValue: 0,
        score: 0,
        scoreLabel: '0 trophies',
        coverage: 'no-history',
        warnings,
        currentTrophies: 0,
        bestTrophies: 0,
        bestLeagueName: '',
        bestLeagueLabel: '',
        bestCapturedMs: 0,
        hasPushRank: false,
        leagueBucket: INVALID_RANK_TIER
    };
}

function scorePushAccount(event, account, metricEntry, nowIso) {
    if (!metricEntry) {
        return noPushHistoryAccount(account, metricEntry, [
            'missing-player-metrics',
            'missing-trophy-history'
        ]);
    }

    const points = collectTrophyPoints(metricEntry);
    const startsMs = parseIsoToMs(event?.startsAt);
    const endsMs = parseIsoToMs(event?.endsAt);
    const parsedNowMs = parseIsoToMs(nowIso);
    const nowMs = parsedNowMs > 0 ? parsedNowMs : Date.now();
    const effectiveEndMs = endsMs > 0 ? Math.min(nowMs, endsMs) : nowMs;

    if (points.length === 0 || startsMs <= 0 || effectiveEndMs <= 0 || effectiveEndMs < startsMs) {
        return noPushHistoryAccount(account, metricEntry);
    }

    const pointsInWindow = points.filter(point =>
        point.capturedMs >= startsMs &&
        point.capturedMs <= effectiveEndMs
    );

    const display = getAccountDisplay(account, metricEntry);

    if (pointsInWindow.length === 0) {
        return noPushHistoryAccount(account, metricEntry, ['missing-trophy-history']);
    }

    const bestPoint = pointsInWindow.reduce((best, point) =>
        comparePushPoints(point, best) < 0 ? point : best
    );
    const hasPushRank = hasValidLeagueBucket(bestPoint.leagueBucket);
    const warnings = hasPushRank ? [] : ['missing-valid-push-rank'];
    const coverage = hasPushRank ? 'full' : 'no-history';

    return {
        tag: account.tag,
        name: display.name,
        townHallLevel: display.townHallLevel,
        leagueName: bestPoint.leagueName || display.leagueName,
        startValue: 0,
        currentValue: bestPoint.trophies,
        score: bestPoint.trophies,
        scoreLabel: formatPushScoreLabel(bestPoint.leagueLabel, bestPoint.trophies),
        coverage,
        warnings: uniqueWarnings(warnings),
        currentTrophies: bestPoint.trophies,
        bestTrophies: bestPoint.trophies,
        bestLeagueName: bestPoint.leagueName,
        bestLeagueLabel: bestPoint.leagueLabel,
        bestCapturedMs: bestPoint.capturedMs,
        hasPushRank,
        leagueBucket: bestPoint.leagueBucket
    };
}

function isValidDonationCycleKey(key) {
    return DONATION_CYCLE_KEY_PATTERN.test(String(key || ''));
}

function sanitizeDonationLedger(key, ledger) {
    const startsAtMs = parseIsoToMs(ledger?.startsAt);
    const endsAtMs = parseIsoToMs(ledger?.endsAt);

    if (!isValidDonationCycleKey(key) || startsAtMs <= 0 || endsAtMs <= startsAtMs) {
        return null;
    }

    return {
        key,
        startsAt: ledger.startsAt,
        endsAt: ledger.endsAt,
        cycleTotalDonations: toNonNegativeInt(ledger.cycleTotalDonations)
    };
}

function findDonationLedger(event, metricEntry) {
    const ledgers = metricEntry?.donationCycles || {};
    const seasonId = String(event?.seasonId || '');

    if (isValidDonationCycleKey(seasonId)) {
        const directLedger = sanitizeDonationLedger(seasonId, ledgers[seasonId]);

        if (directLedger) {
            return directLedger;
        }
    }

    return Object.keys(ledgers)
        .sort((a, b) => a.localeCompare(b))
        .map(key => sanitizeDonationLedger(key, ledgers[key]))
        .find(ledger =>
            ledger &&
            ledger.startsAt === event?.startsAt &&
            ledger.endsAt === event?.endsAt
        ) || null;
}

function scoreDonationAccount(event, account, metricEntry) {
    const display = getAccountDisplay(account, metricEntry);

    if (!metricEntry) {
        return {
            tag: account.tag,
            name: display.name,
            townHallLevel: display.townHallLevel,
            leagueName: display.leagueName,
            startValue: 0,
            currentValue: 0,
            delta: 0,
            score: 0,
            scoreLabel: '0 donations',
            coverage: 'missing-cycle-ledger',
            warnings: ['missing-player-metrics', 'missing-donation-cycle-ledger']
        };
    }

    const ledger = findDonationLedger(event, metricEntry);

    if (!ledger) {
        return {
            tag: account.tag,
            name: display.name,
            townHallLevel: display.townHallLevel,
            leagueName: display.leagueName,
            startValue: 0,
            currentValue: 0,
            delta: 0,
            score: 0,
            scoreLabel: '0 donations',
            coverage: 'missing-cycle-ledger',
            warnings: ['missing-donation-cycle-ledger']
        };
    }

    const score = ledger.cycleTotalDonations;

    return {
        tag: account.tag,
        name: display.name,
        townHallLevel: display.townHallLevel,
        leagueName: display.leagueName,
        startValue: 0,
        currentValue: score,
        delta: score,
        score,
        scoreLabel: formatDonationScore(score),
        coverage: 'full',
        warnings: []
    };
}

function combineCoverage(accounts) {
    return accounts.reduce((coverage, account) => {
        const currentPriority = COVERAGE_PRIORITY[coverage] ?? 0;
        const accountPriority = COVERAGE_PRIORITY[account.coverage] ?? 0;

        return accountPriority > currentPriority ? account.coverage : coverage;
    }, 'full');
}

function buildParticipantRow(event, participant, metricsByTag, metric, nowIso) {
    const scoreAccount = metric === 'donations'
        ? account => scoreDonationAccount(event, account, metricsByTag[account.tag])
        : account => scorePushAccount(event, account, metricsByTag[account.tag], nowIso);
    const accounts = participant.accounts.map(scoreAccount);

    if (accounts.length === 0) {
        return {
            rank: 0,
            discordUsername: participant.discordUsername,
            displayName:
                participant.discordDisplayName ||
                participant.discordGlobalName ||
                participant.discordUsername ||
                participant.discordId,
            accounts: [],
            score: 0,
            scoreLabel: metric === 'donations' ? '0 donations' : '0 trophies',
            metric,
            coverage: 'no-history',
            warnings: ['no-registered-accounts'],
            accountCount: 0,
            currentTrophies: 0,
            bestTrophies: 0,
            bestLeagueName: '',
            bestLeagueLabel: '',
            bestCapturedMs: 0,
            hasPushRank: metric === 'donations' ? undefined : false,
            leagueBucket: metric === 'donations' ? undefined : INVALID_RANK_TIER
        };
    }

    const warnings = uniqueWarnings(accounts.flatMap(account => account.warnings));
    const displayName =
        participant.discordDisplayName ||
        participant.discordGlobalName ||
        participant.discordUsername ||
        participant.discordId;

    if (metric === 'leagueTrophies') {
        const bestAccount = accounts.reduce((best, account) =>
            compareRows('push', account, best) < 0 ? account : best
        );

        return {
            rank: 0,
            discordUsername: participant.discordUsername,
            displayName,
            accounts,
            score: bestAccount.score,
            scoreLabel: bestAccount.scoreLabel,
            metric,
            coverage: combineCoverage(accounts),
            warnings,
            accountCount: accounts.length,
            currentTrophies: bestAccount.currentTrophies || 0,
            bestTrophies: bestAccount.bestTrophies || 0,
            bestLeagueName: bestAccount.bestLeagueName || '',
            bestLeagueLabel: bestAccount.bestLeagueLabel || '',
            bestCapturedMs: bestAccount.bestCapturedMs || 0,
            hasPushRank: bestAccount.hasPushRank === true,
            leagueBucket: bestAccount.leagueBucket ?? INVALID_RANK_TIER
        };
    }

    const score = accounts.reduce((sum, account) => sum + account.score, 0);

    return {
        rank: 0,
        discordUsername: participant.discordUsername,
        displayName,
        accounts,
        score,
        scoreLabel: formatDonationScore(score),
        metric,
        coverage: combineCoverage(accounts),
        warnings,
        accountCount: accounts.length,
        currentTrophies: Math.max(0, ...accounts.map(account => account.currentTrophies || 0)),
        bestTrophies: Math.max(0, ...accounts.map(account => account.bestTrophies || 0))
    };
}

function compareRows(type, a, b) {
    if (type === 'push') {
        const aHasPushRank = a.hasPushRank !== false && hasValidLeagueBucket(a.leagueBucket);
        const bHasPushRank = b.hasPushRank !== false && hasValidLeagueBucket(b.leagueBucket);

        if (aHasPushRank !== bHasPushRank) {
            return aHasPushRank ? -1 : 1;
        }

        if (aHasPushRank && bHasPushRank) {
            const bucketDiff = b.leagueBucket - a.leagueBucket;

            if (bucketDiff !== 0) {
                return bucketDiff;
            }
        }
    }

    const scoreDiff = b.score - a.score;

    if (scoreDiff !== 0) {
        return scoreDiff;
    }

    if (type === 'push') {
        const capturedDiff = (b.bestCapturedMs || 0) - (a.bestCapturedMs || 0);

        if (capturedDiff !== 0) {
            return capturedDiff;
        }
    }

    if (type === 'donation') {
        const accountDiff = (b.accountCount || 0) - (a.accountCount || 0);

        if (accountDiff !== 0) {
            return accountDiff;
        }
    }

    const nameDiff = String(a.displayName || '')
        .toLowerCase()
        .localeCompare(String(b.displayName || '').toLowerCase());

    if (nameDiff !== 0) {
        return nameDiff;
    }

    const aTag = a.accounts?.[0]?.tag || a.tag || '';
    const bTag = b.accounts?.[0]?.tag || b.tag || '';

    return aTag.localeCompare(bTag);
}

function clampLimit(limit) {
    const number = Number(limit ?? DEFAULT_LIMIT);

    if (!Number.isFinite(number)) {
        return DEFAULT_LIMIT;
    }

    return Math.max(1, Math.min(MAX_LIMIT, Math.floor(number)));
}

function getLeaderboardMetric(event, type) {
    if (type === 'donation') {
        return event?.settings?.leaderboardMetric || 'donations';
    }

    return 'leagueTrophies';
}

function buildLocalSeasonEventLeaderboard(event, rawPlayerMetricsByTag, options = {}) {
    const type = String(event?.type || options.type || '').toLowerCase() === 'donation'
        ? 'donation'
        : 'push';
    const metric = getLeaderboardMetric(event, type);
    const metricsByTag = buildPlayerMetricsByTag(rawPlayerMetricsByTag);
    const activeParticipants = sanitizeParticipants(event)
        .filter(participant => participant.status === 'signed_up');
    const rows = activeParticipants
        .map(participant => buildParticipantRow(event, participant, metricsByTag, metric, options.nowIso))
        .sort((a, b) => compareRows(type, a, b))
        .slice(0, clampLimit(options.limit));

    rows.forEach((row, index) => {
        row.rank = index + 1;
    });

    return {
        ok: true,
        event: {
            eventId: event?.eventId || null,
            type,
            seasonId: event?.seasonId || null
        },
        leaderboard: rows,
        generatedAt: options.nowIso || new Date().toISOString()
    };
}

module.exports = {
    normalizePlayerTag,
    toNonNegativeInt,
    parseIsoToMs,
    sanitizeParticipant,
    sanitizeParticipants,
    buildPlayerMetricsByTag,
    buildLocalSeasonEventLeaderboard
};
