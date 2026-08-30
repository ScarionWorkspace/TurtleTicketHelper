'use strict';

// Keep these defaults and evidence rules in lockstep with rosterApp's
// cloudflarePages/war-followup.js. The Discord bot reads the same immutable
// roster snapshot and the same private Apps Script cases; it does not create a
// second moderation model.
const DEFAULT_SETTINGS = Object.freeze({
    schemaVersion: 4,
    regularLookbackWars: 8,
    regularMissedThreshold: 2,
    regularContextMode: 'explain',
    regularPerformanceEnabled: true,
    regularMinimumAttacks: 6,
    regularAverageStarsThreshold: 1.8,
    regularAverageDestructionThreshold: 75,
    cwlLookbackSeasons: 2,
    cwlMissedThreshold: 1,
    cwlPerformanceEnabled: true,
    cwlMinimumAttacks: 4,
    cwlAverageStarsThreshold: 1.8,
    cwlAverageDestructionThreshold: 75,
    defaultRecoveryWars: 3,
    defaultHeroDownRosterId: '',
    missingDiscordEnabled: true,
    moderatorNames: [],
    trustedPlayerTags: [],
    rulesUpdatedAt: '',
    updatedAt: ''
});
const REGULAR_CONTEXT_MODES = Object.freeze(['off', 'explain', 'assist', 'automatic']);

const STATUS_ORDER = Object.freeze([
    'needs_review',
    'waiting',
    'needs_dm',
    'removal_pending',
    'hero_down',
    'ready',
    'watching',
    'closed'
]);

const STATUS_META = Object.freeze({
    waiting: { label: 'Waiting', next: 'Wait for the scheduled follow-up', emoji: '⏳' },
    needs_review: { label: 'Review', next: 'Review the war evidence', emoji: '🔎' },
    needs_dm: { label: 'Needs DM', next: 'Send the decision message', emoji: '✉️' },
    removal_pending: { label: 'Removal', next: 'Remove the player in game', emoji: '🚫' },
    hero_down: { label: 'Hero-down', next: 'Track hero-down wars', emoji: '🛡️' },
    ready: { label: 'Ready', next: 'Make the return decision', emoji: '✅' },
    watching: { label: 'Monitoring', next: 'Watching for new problematic evidence', emoji: '👀' },
    closed: { label: 'Closed', next: 'No action needed', emoji: '🗃️' }
});

function toText(value) {
    return value == null ? '' : String(value);
}

function toInt(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function clamp(value, min, max, fallback) {
    const number = Number(value);
    return Math.max(min, Math.min(max, Number.isFinite(number) ? number : fallback));
}

function normalizeTag(value) {
    const compact = toText(value)
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '')
        .replace(/O/g, '0');

    if (!compact) return '';
    return compact.startsWith('#') ? compact : `#${compact}`;
}

function normalizeWarTimestamp(value) {
    const text = toText(value).trim();
    const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d{3}))?Z$/.exec(text);

    if (!match) return text;
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${match[7] || '000'}Z`;
}

function parseMs(value) {
    const ms = new Date(normalizeWarTimestamp(value)).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function formatDate(value) {
    const ms = parseMs(value);

    if (!ms) return '';

    try {
        return new Intl.DateTimeFormat('en-GB', {
            day: '2-digit',
            month: 'short',
            year: 'numeric'
        }).format(new Date(ms));
    } catch {
        return new Date(ms).toISOString().slice(0, 10);
    }
}

function discordRelativeTimestamp(value) {
    const ms = parseMs(value);
    return ms > 0 ? `<t:${Math.floor(ms / 1000)}:R>` : '';
}

function buildClanProfileLink(tagRaw) {
    const tag = normalizeTag(tagRaw);
    return tag
        ? `https://link.clashofclans.com/en/?action=OpenClanProfile&tag=${encodeURIComponent(tag)}`
        : '';
}

function formatNumber(value, digits = 1) {
    const number = Number(value);
    return Number.isFinite(number) ? number.toFixed(digits) : '-';
}

function plural(count, singular, pluralValue) {
    return Number(count) === 1 ? singular : (pluralValue || `${singular}s`);
}

function stableRevision(valueRaw) {
    const value = toText(valueRaw);
    let first = 2166136261;
    let second = 5381;

    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        first = Math.imul(first ^ code, 16777619);
        second = Math.imul(second, 33) ^ code;
    }

    return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function sanitizeSettings(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const moderatorNames = Array.from(new Set(
        (Array.isArray(value.moderatorNames) ? value.moderatorNames : [])
            .map(name => toText(name).trim())
            .filter(Boolean)
    )).slice(0, 40);
    const trustedPlayerTags = Array.from(new Set(
        (Array.isArray(value.trustedPlayerTags) ? value.trustedPlayerTags : [])
            .map(normalizeTag)
            .filter(Boolean)
    )).sort().slice(0, 1000);

    return {
        schemaVersion: 4,
        regularLookbackWars: Math.floor(clamp(value.regularLookbackWars, 1, 8, DEFAULT_SETTINGS.regularLookbackWars)),
        regularMissedThreshold: Math.floor(clamp(value.regularMissedThreshold, 1, 16, DEFAULT_SETTINGS.regularMissedThreshold)),
        regularContextMode: REGULAR_CONTEXT_MODES.includes(toText(value.regularContextMode).trim().toLowerCase())
            ? toText(value.regularContextMode).trim().toLowerCase()
            : DEFAULT_SETTINGS.regularContextMode,
        regularPerformanceEnabled: value.regularPerformanceEnabled == null ? true : value.regularPerformanceEnabled === true,
        regularMinimumAttacks: Math.floor(clamp(value.regularMinimumAttacks, 2, 32, DEFAULT_SETTINGS.regularMinimumAttacks)),
        regularAverageStarsThreshold: clamp(value.regularAverageStarsThreshold, 0.5, 3, DEFAULT_SETTINGS.regularAverageStarsThreshold),
        regularAverageDestructionThreshold: clamp(value.regularAverageDestructionThreshold, 25, 100, DEFAULT_SETTINGS.regularAverageDestructionThreshold),
        cwlLookbackSeasons: Math.floor(clamp(value.cwlLookbackSeasons, 1, 8, DEFAULT_SETTINGS.cwlLookbackSeasons)),
        cwlMissedThreshold: Math.floor(clamp(value.cwlMissedThreshold, 1, 8, DEFAULT_SETTINGS.cwlMissedThreshold)),
        cwlPerformanceEnabled: value.cwlPerformanceEnabled == null ? true : value.cwlPerformanceEnabled === true,
        cwlMinimumAttacks: Math.floor(clamp(value.cwlMinimumAttacks, 2, 24, DEFAULT_SETTINGS.cwlMinimumAttacks)),
        cwlAverageStarsThreshold: clamp(value.cwlAverageStarsThreshold, 0.5, 3, DEFAULT_SETTINGS.cwlAverageStarsThreshold),
        cwlAverageDestructionThreshold: clamp(value.cwlAverageDestructionThreshold, 25, 100, DEFAULT_SETTINGS.cwlAverageDestructionThreshold),
        defaultRecoveryWars: Math.floor(clamp(value.defaultRecoveryWars, 1, 8, DEFAULT_SETTINGS.defaultRecoveryWars)),
        defaultHeroDownRosterId: toText(value.defaultHeroDownRosterId).trim(),
        missingDiscordEnabled: value.missingDiscordEnabled == null ? true : value.missingDiscordEnabled === true,
        moderatorNames,
        trustedPlayerTags,
        rulesUpdatedAt: toText(value.rulesUpdatedAt).trim(),
        updatedAt: toText(value.updatedAt).trim()
    };
}

function emptyStats() {
    return {
        warCount: 0,
        possibleAttacks: 0,
        usedAttacks: 0,
        missedAttacks: 0,
        countedAttacks: 0,
        starsTotal: 0,
        totalDestruction: 0,
        threeStarCount: 0,
        hitUpCount: 0,
        sameThHitCount: 0,
        hitDownCount: 0
    };
}

function normalizeStats(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const attacksMade = toInt(value.attacksMade);
    const attacksMissed = toInt(value.attacksMissed != null ? value.attacksMissed : value.missedAttacks);

    return {
        warCount: toInt(value.warCount),
        possibleAttacks: toInt(value.possibleAttacks != null ? value.possibleAttacks : attacksMade + attacksMissed),
        usedAttacks: toInt(value.usedAttacks != null ? value.usedAttacks : attacksMade),
        missedAttacks: attacksMissed,
        countedAttacks: toInt(value.countedAttacks),
        starsTotal: toInt(value.starsTotal),
        totalDestruction: toInt(value.totalDestruction),
        threeStarCount: toInt(value.threeStarCount),
        hitUpCount: toInt(value.hitUpCount),
        sameThHitCount: toInt(value.sameThHitCount),
        hitDownCount: toInt(value.hitDownCount)
    };
}

function addStats(target, raw) {
    const source = normalizeStats(raw);
    for (const key of Object.keys(target)) target[key] += source[key];
    return target;
}

function statsSummary(raw) {
    const stats = normalizeStats(raw);

    return {
        ...stats,
        averageStars: stats.countedAttacks > 0 ? stats.starsTotal / stats.countedAttacks : null,
        averageDestruction: stats.countedAttacks > 0 ? stats.totalDestruction / stats.countedAttacks : null,
        tripleRate: stats.countedAttacks > 0 ? stats.threeStarCount / stats.countedAttacks : null
    };
}

function sanitizeRegularAttackContext(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const signed = numberRaw => {
        const number = Number(numberRaw);
        return Number.isFinite(number) ? Math.max(-100, Math.min(100, Math.trunc(number))) : 0;
    };
    const attacks = (Array.isArray(value.attacks) ? value.attacks : []).slice(0, 4).map(attackRaw => {
        const attack = attackRaw && typeof attackRaw === 'object' ? attackRaw : {};
        return {
            attackNumber: Math.min(4, toInt(attack.attackNumber)),
            order: Math.min(10000, toInt(attack.order)),
            ownAttackOrdinal: Math.min(1000, toInt(attack.ownAttackOrdinal)),
            targetMapPosition: Math.min(100, toInt(attack.targetMapPosition)),
            targetTownHallLevel: Math.min(100, toInt(attack.targetTownHallLevel)),
            mapUp: signed(attack.mapUp),
            townHallDelta: signed(attack.townHallDelta),
            mirrorStarsBefore: Math.min(3, toInt(attack.mirrorStarsBefore)),
            targetStarsBefore: Math.min(3, toInt(attack.targetStarsBefore)),
            reasonableTargetsAvailable: Math.min(100, toInt(attack.reasonableTargetsAvailable)),
            stars: Math.min(3, toInt(attack.stars)),
            destruction: Math.min(100, toInt(attack.destruction)),
            newStars: Math.min(3, toInt(attack.newStars)),
            formEligible: attack.formEligible === true,
            mirrorResolved: attack.mirrorResolved === true,
            targetResolved: attack.targetResolved === true,
            hitMirror: attack.hitMirror === true,
            forcedHardTarget: attack.forcedHardTarget === true
        };
    }).sort((left, right) =>
        (left.ownAttackOrdinal || left.order || left.attackNumber) - (right.ownAttackOrdinal || right.order || right.attackNumber)
    );
    const median = Number(value.lineupMedianTownHall);
    const context = {
        schemaVersion: 1,
        teamSize: Math.min(100, toInt(value.teamSize)),
        attacksPerMember: Math.min(4, toInt(value.attacksPerMember)),
        playerMapPosition: Math.min(100, toInt(value.playerMapPosition)),
        playerTownHallLevel: Math.min(100, toInt(value.playerTownHallLevel)),
        mirrorTownHallLevel: Math.min(100, toInt(value.mirrorTownHallLevel)),
        lineupMedianTownHall: Number.isFinite(median) && median > 0 ? Math.min(100, Math.round(median * 2) / 2) : 0,
        totalOwnAttacksMade: Math.min(1000, toInt(value.totalOwnAttacksMade)),
        maxOwnAttacks: Math.min(1000, toInt(value.maxOwnAttacks)),
        attacks
    };
    return context.playerMapPosition || context.playerTownHallLevel || context.attacks.length ? context : null;
}

function isValidatedForcedHardTarget(attack) {
    return Boolean(
        attack &&
        attack.formEligible &&
        attack.forcedHardTarget &&
        attack.mirrorResolved &&
        attack.targetResolved &&
        attack.mirrorStarsBefore >= 3 &&
        attack.targetStarsBefore < 3 &&
        attack.townHallDelta > 0 &&
        attack.reasonableTargetsAvailable === 0
    );
}

function analyzeRegularContext(eventsRaw, totalsRaw) {
    const events = Array.isArray(eventsRaw) ? eventsRaw : [];
    const adjusted = normalizeStats(totalsRaw);
    let contextualWarCount = 0;
    let exactContextWarCount = 0;
    let forcedHardAttackCount = 0;
    let mirrorEvaluableWars = 0;
    let mirrorViolationWars = 0;
    let timingEvaluableWars = 0;
    let lateLowTownHallWars = 0;
    let lateForcedHardWars = 0;

    for (const eventRaw of events) {
        const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : {};
        const context = sanitizeRegularAttackContext(event.context);
        if (!context) continue;
        contextualWarCount += 1;
        const eligible = context.attacks.filter(attack => attack.formEligible);
        const stats = normalizeStats(event.stats);
        const eligibleStars = eligible.reduce((sum, attack) => sum + attack.stars, 0);
        const eligibleDestruction = eligible.reduce((sum, attack) => sum + attack.destruction, 0);
        const exact = eligible.length === stats.countedAttacks &&
            eligibleStars === stats.starsTotal &&
            eligibleDestruction === stats.totalDestruction;
        if (!exact) continue;
        exactContextWarCount += 1;

        for (const attack of eligible) {
            if (!isValidatedForcedHardTarget(attack)) continue;
            forcedHardAttackCount += 1;
            adjusted.countedAttacks = Math.max(0, adjusted.countedAttacks - 1);
            adjusted.starsTotal = Math.max(0, adjusted.starsTotal - attack.stars);
            adjusted.totalDestruction = Math.max(0, adjusted.totalDestruction - attack.destruction);
            if (attack.stars === 3) adjusted.threeStarCount = Math.max(0, adjusted.threeStarCount - 1);
            const matchupKey = attack.townHallDelta > 0 ? 'hitUpCount' : (attack.townHallDelta < 0 ? 'hitDownCount' : 'sameThHitCount');
            adjusted[matchupKey] = Math.max(0, adjusted[matchupKey] - 1);
        }

        const first = eligible[0];
        if (!first) continue;
        if (first.mirrorResolved && first.targetResolved && first.mirrorStarsBefore < 3) {
            mirrorEvaluableWars += 1;
            if (!first.hitMirror) mirrorViolationWars += 1;
        }
        if (
            context.playerTownHallLevel > 0 &&
            context.lineupMedianTownHall > 0 &&
            context.playerTownHallLevel < context.lineupMedianTownHall &&
            context.maxOwnAttacks > 0 &&
            first.ownAttackOrdinal > 0
        ) {
            timingEvaluableWars += 1;
            if (first.ownAttackOrdinal / context.maxOwnAttacks >= 0.7) {
                lateLowTownHallWars += 1;
                if (isValidatedForcedHardTarget(first)) lateForcedHardWars += 1;
            }
        }
    }

    return {
        contextualWarCount,
        exactContextWarCount,
        forcedHardAttackCount,
        mirrorEvaluableWars,
        mirrorViolationWars,
        mirrorViolationRate: mirrorEvaluableWars ? mirrorViolationWars / mirrorEvaluableWars : 0,
        timingEvaluableWars,
        lateLowTownHallWars,
        lateLowTownHallRate: timingEvaluableWars ? lateLowTownHallWars / timingEvaluableWars : 0,
        lateForcedHardWars,
        adjustedStats: statsSummary(adjusted)
    };
}

function formatRegularAttackContextLines(contextRaw) {
    const context = sanitizeRegularAttackContext(contextRaw);
    if (!context) return [];
    return context.attacks.map((attack, index) => {
        const attackNumber = attack.attackNumber || index + 1;
        const attacker = [context.playerMapPosition ? `#${context.playerMapPosition}` : '', context.playerTownHallLevel ? `TH${context.playerTownHallLevel}` : '']
            .filter(Boolean).join(' ');
        const mirrorState = attack.mirrorResolved
            ? (attack.mirrorStarsBefore >= 3 ? 'already tripled' : `open (${attack.mirrorStarsBefore}★ before)`)
            : 'state unavailable';
        const mirror = `mirror${context.playerMapPosition ? ` #${context.playerMapPosition}` : ''}` +
            `${context.mirrorTownHallLevel ? ` TH${context.mirrorTownHallLevel}` : ''}: ${mirrorState}`;
        const targetParts = [
            attack.targetMapPosition ? `#${attack.targetMapPosition}` : 'unknown base',
            attack.targetTownHallLevel ? `TH${attack.targetTownHallLevel}` : ''
        ];
        if (attack.townHallDelta) targetParts.push(`${attack.townHallDelta > 0 ? '+' : ''}${attack.townHallDelta} TH`);
        if (!attack.hitMirror && attack.mapUp) targetParts.push(`${Math.abs(attack.mapUp)} ${plural(Math.abs(attack.mapUp), 'spot')} ${attack.mapUp > 0 ? 'up' : 'down'}`);
        if (attack.hitMirror) targetParts.push('mirror hit');
        if (attack.targetResolved) targetParts.push(attack.targetStarsBefore >= 3 ? 'already tripled' : `${attack.targetStarsBefore}★ before`);
        const timing = attack.ownAttackOrdinal && context.maxOwnAttacks
            ? `clan attack ${attack.ownAttackOrdinal}/${context.maxOwnAttacks} (${Math.round(attack.ownAttackOrdinal / context.maxOwnAttacks * 100)}%)`
            : 'timing unavailable';
        const status = !attack.formEligible
            ? 'post-max farming; not counted'
            : (isValidatedForcedHardTarget(attack) ? 'forced hard target' : 'form counted');
        return `Attack ${attackNumber}: ${attacker ? `${attacker} · ` : ''}${mirror} · target ${targetParts.filter(Boolean).join(' ')} · ${timing} · ${attack.stars}★ ${attack.destruction}% · ${status}`;
    });
}

function getRosters(rosterData) {
    return Array.isArray(rosterData?.rosters) ? rosterData.rosters : [];
}

function getTaggedValue(byTagRaw, tagRaw) {
    const byTag = byTagRaw && typeof byTagRaw === 'object' ? byTagRaw : {};
    const tag = normalizeTag(tagRaw);

    if (!tag) return null;
    if (byTag[tag] && typeof byTag[tag] === 'object') return byTag[tag];

    const storedKey = Object.keys(byTag).find(key => normalizeTag(key) === tag);
    return storedKey && byTag[storedKey] && typeof byTag[storedKey] === 'object'
        ? byTag[storedKey]
        : null;
}

function rosterContainsTag(rosterRaw, tagRaw) {
    const roster = rosterRaw && typeof rosterRaw === 'object' ? rosterRaw : {};
    const tag = normalizeTag(tagRaw);

    return Boolean(tag) && ['main', 'subs', 'missing'].some(key =>
        (Array.isArray(roster[key]) ? roster[key] : [])
            .some(player => normalizeTag(player?.tag) === tag)
    );
}

function findEvidenceRoster(rosterData, tagRaw, identityRaw) {
    const rosters = getRosters(rosterData);
    const identity = identityRaw && typeof identityRaw === 'object' ? identityRaw : {};
    const preferredId = toText(identity.rosterId || identity.sourceRosterId).trim();
    const preferredClanTag = normalizeTag(identity.clanTag || identity.sourceClanTag);

    if (preferredId) {
        const match = rosters.find(roster => toText(roster?.id).trim() === preferredId);
        if (match) return match;
    }

    if (preferredClanTag) {
        const match = rosters.find(roster => normalizeTag(roster?.connectedClanTag) === preferredClanTag);
        if (match) return match;
    }

    return rosters.find(roster => rosterContainsTag(roster, tagRaw)) || null;
}

function buildPlayerDirectory(rosterData, settingsRaw) {
    const data = rosterData && typeof rosterData === 'object' ? rosterData : {};
    const settings = sanitizeSettings(settingsRaw);
    const trustedTags = new Set(settings.trustedPlayerTags);
    const metricsByTag = data.playerMetrics?.byTag && typeof data.playerMetrics.byTag === 'object'
        ? data.playerMetrics.byTag
        : {};
    const byTag = {};
    const missingTags = new Set();
    const rosters = [];

    for (const rosterRaw of getRosters(data)) {
        const roster = rosterRaw && typeof rosterRaw === 'object' ? rosterRaw : {};
        const regularWar = roster.regularWar && typeof roster.regularWar === 'object' ? roster.regularWar : {};
        const currentWar = regularWar.currentWar && typeof regularWar.currentWar === 'object' ? regularWar.currentWar : {};
        const currentWarState = toText(currentWar.state || currentWar.warState).trim().toLowerCase();
        const rosterInfo = {
            id: toText(roster.id).trim(),
            title: toText(roster.title).trim() || toText(roster.id).trim(),
            clanTag: normalizeTag(roster.connectedClanTag),
            trackingMode: toText(roster.trackingMode).trim(),
            nextWarStartAt: currentWarState === 'preparation' || currentWarState === 'inwar'
                ? toText(currentWar.endTime).trim()
                : ''
        };

        if (rosterInfo.id) rosters.push(rosterInfo);

        for (const playerRaw of Array.isArray(roster.missing) ? roster.missing : []) {
            const tag = normalizeTag(playerRaw?.tag);
            if (tag) missingTags.add(tag);
        }

        for (const [role, players] of [
            ['main', Array.isArray(roster.main) ? roster.main : []],
            ['subs', Array.isArray(roster.subs) ? roster.subs : []]
        ]) {
            for (const playerRaw of players) {
                const player = playerRaw && typeof playerRaw === 'object' ? playerRaw : {};
                const tag = normalizeTag(player.tag);
                if (!tag || byTag[tag]) continue;

                const metric = getTaggedValue(metricsByTag, tag) || {};
                const identity = metric.identity && typeof metric.identity === 'object' ? metric.identity : {};
                const discordIdRaw = toText(identity.discordId).trim();
                const discordId = /^\d{17,20}$/.test(discordIdRaw) ? discordIdRaw : '';
                const discordUsername = toText(identity.discordUsername).trim();
                const displayDiscord = discordUsername || toText(player.discord).trim();

                byTag[tag] = {
                    tag,
                    name: toText(player.name).trim() || toText(identity.name).trim() || tag,
                    discord: displayDiscord,
                    discordId,
                    hasDiscord: Boolean(discordId || displayDiscord),
                    th: toInt(player.th),
                    role,
                    automaticEligible: true,
                    trusted: trustedTags.has(tag),
                    rosterId: rosterInfo.id,
                    rosterTitle: rosterInfo.title,
                    clanTag: rosterInfo.clanTag,
                    trackingMode: rosterInfo.trackingMode
                };
            }
        }
    }

    return { byTag, players: Object.values(byTag), rosters, missingTags };
}

function buildIgnoredPlayerEntries(directoryRaw, settingsRaw, casesRaw) {
    const directory = directoryRaw && typeof directoryRaw === 'object' ? directoryRaw : {};
    const byTag = directory.byTag && typeof directory.byTag === 'object' ? directory.byTag : {};
    const caseByTag = {};

    for (const raw of Array.isArray(casesRaw) ? casesRaw : []) {
        const value = normalizeCase(raw);
        if (value) caseByTag[value.tag] = value;
    }

    return sanitizeSettings(settingsRaw).trustedPlayerTags
        .map(tag => {
            const player = byTag[tag] || null;
            const caseValue = caseByTag[tag] || null;
            return {
                tag,
                name: toText(player?.name || caseValue?.name).trim() || tag,
                discord: toText(player?.discord || caseValue?.discord).trim(),
                discordId: toText(player?.discordId).trim(),
                rosterId: toText(player?.rosterId || caseValue?.sourceRosterId).trim(),
                rosterTitle: toText(player?.rosterTitle || caseValue?.sourceRosterTitle).trim(),
                clanTag: normalizeTag(player?.clanTag || caseValue?.sourceClanTag),
                inCurrentRoster: Boolean(player)
            };
        })
        .sort((left, right) =>
            (left.rosterTitle || '\uffff').localeCompare(right.rosterTitle || '\uffff') ||
            left.name.localeCompare(right.name) ||
            left.tag.localeCompare(right.tag)
        );
}

function buildRegularEvidence(entryRaw, settingsRaw, limitRaw = null) {
    const settings = sanitizeSettings(settingsRaw);
    const limit = limitRaw == null ? settings.regularLookbackWars : Math.max(1, toInt(limitRaw));
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
    const events = (Array.isArray(entry.recentRegularWarForm) ? entry.recentRegularWarForm : [])
        .map(eventRaw => {
            const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : {};
            const id = toText(event.warKey || event.eventId).trim();
            if (!id) return null;

            const legacyId = toText(event.eventId).trim();
            const stats = normalizeStats(event.stats);
            stats.warCount = 1;
            const normalized = {
                id,
                legacyIds: legacyId && legacyId !== id ? [legacyId] : [],
                label: toText(event.warKey).trim() || 'Regular war',
                at: toText(event.finalizedAt).trim(),
                clanTag: normalizeTag(event.clanTag),
                stats
            };
            const context = sanitizeRegularAttackContext(event.context);
            if (context) normalized.context = context;
            return normalized;
        })
        .filter(Boolean)
        .sort((left, right) => parseMs(right.at) - parseMs(left.at) || left.id.localeCompare(right.id))
        .slice(0, limit);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.length;
    return { events, totals: statsSummary(totals) };
}

function cwlSeasonStartAt(seasonRaw) {
    const season = toText(seasonRaw).trim();
    const candidate = /^\d{4}-\d{2}$/.test(season)
        ? `${season}-01T00:00:00.000Z`
        : (/^\d{4}-\d{2}-\d{2}$/.test(season) ? `${season}T00:00:00.000Z` : season);
    const ms = parseMs(candidate);
    return ms > 0 ? new Date(ms).toISOString() : '';
}

function buildCwlEvidence(entryRaw, settingsRaw, limitRaw = null) {
    const settings = sanitizeSettings(settingsRaw);
    const limit = limitRaw == null ? settings.cwlLookbackSeasons : Math.max(1, toInt(limitRaw));
    const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
    const seasons = entry.cwlSeasonContext?.bySeason && typeof entry.cwlSeasonContext.bySeason === 'object'
        ? entry.cwlSeasonContext.bySeason
        : {};
    const events = Object.keys(seasons)
        .sort()
        .reverse()
        .slice(0, limit)
        .map(season => {
            const value = seasons[season] && typeof seasons[season] === 'object' ? seasons[season] : {};
            const stats = normalizeStats(value.stats);
            stats.warCount = Array.isArray(value.finalizedEventIds) && value.finalizedEventIds.length
                ? value.finalizedEventIds.length
                : (stats.warCount || stats.possibleAttacks);
            return {
                id: `cwl:${season}`,
                legacyIds: [],
                label: season,
                at: parseMs(value.lastEventAt) > 0 ? toText(value.lastEventAt).trim() : cwlSeasonStartAt(season),
                finalizedAt: parseMs(value.lastEventAt) > 0 ? toText(value.lastEventAt).trim() : '',
                seasonStartedAt: cwlSeasonStartAt(season),
                clanTag: '',
                stats
            };
        });
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.reduce((sum, event) => sum + toInt(event.stats.warCount), 0);
    return { events, totals: statsSummary(totals) };
}

function combineRegularHistoryStats(statsRaw, formStatsRaw) {
    const stats = statsRaw && typeof statsRaw === 'object' ? { ...statsRaw } : {};
    const formStats = formStatsRaw && typeof formStatsRaw === 'object' ? formStatsRaw : null;
    if (!formStats) return stats;

    for (const key of [
        'countedAttacks',
        'formEligibleAttacks',
        'starsTotal',
        'totalDestruction',
        'threeStarCount',
        'hitUpCount',
        'sameThHitCount',
        'hitDownCount'
    ]) {
        if (formStats[key] != null) stats[key] = formStats[key];
    }
    return stats;
}

function buildRosterRegularEvidence(rosterRaw, tagRaw, settingsRaw, limitRaw = null) {
    const settings = sanitizeSettings(settingsRaw);
    const limit = limitRaw == null ? settings.regularLookbackWars : Math.max(1, toInt(limitRaw));
    const roster = rosterRaw && typeof rosterRaw === 'object' ? rosterRaw : {};
    const history = roster.warPerformance?.regularWarHistoryByKey && typeof roster.warPerformance.regularWarHistoryByKey === 'object'
        ? roster.warPerformance.regularWarHistoryByKey
        : {};
    const clanTag = normalizeTag(roster.connectedClanTag);
    const events = Object.keys(history)
        .map(key => {
            const entry = history[key] && typeof history[key] === 'object' ? history[key] : null;
            if (!entry || entry.authoritative !== true) return null;

            const stats = getTaggedValue(entry.statsByTag, tagRaw);
            const formStats = getTaggedValue(entry.formStatsByTag, tagRaw);
            if (!stats && !formStats) return null;

            const id = toText(entry.warKey || key).trim();
            if (!id) return null;

            const normalized = normalizeStats(combineRegularHistoryStats(stats, formStats));
            normalized.warCount = 1;
            return {
                id,
                legacyIds: [],
                label: id,
                at: toText(entry.finalizedAt || entry.lastUpdatedAt).trim(),
                clanTag,
                stats: normalized
            };
        })
        .filter(Boolean)
        .sort((left, right) => parseMs(right.at) - parseMs(left.at) || right.id.localeCompare(left.id))
        .slice(0, limit);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.length;
    return { events, totals: statsSummary(totals) };
}

function buildRosterRegularEvidenceForTag(rosterData, tagRaw, settingsRaw, preferredRosterRaw, limitRaw = null) {
    const settings = sanitizeSettings(settingsRaw);
    const limit = limitRaw == null ? settings.regularLookbackWars : Math.max(1, toInt(limitRaw));
    const preferredRoster = preferredRosterRaw && typeof preferredRosterRaw === 'object' ? preferredRosterRaw : null;
    const rosters = getRosters(rosterData);
    const ordered = preferredRoster
        ? [preferredRoster, ...rosters.filter(roster => roster !== preferredRoster)]
        : rosters;
    const seen = new Set();
    const events = [];

    for (const roster of ordered) {
        for (const event of buildRosterRegularEvidence(roster, tagRaw, settings, limit).events) {
            const key = `${normalizeTag(event.clanTag)}|${event.id}`;
            if (seen.has(key)) continue;
            seen.add(key);
            events.push(event);
        }
    }

    events.sort((left, right) => parseMs(right.at) - parseMs(left.at) || right.id.localeCompare(left.id));
    events.splice(limit);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.length;
    return { events, totals: statsSummary(totals) };
}

function buildRosterCwlEvidence(rosterRaw, tagRaw) {
    const roster = rosterRaw && typeof rosterRaw === 'object' ? rosterRaw : {};
    const cwlStats = roster.cwlStats && typeof roster.cwlStats === 'object' ? roster.cwlStats : {};
    const season = toText(cwlStats.season).trim();
    const playerStats = getTaggedValue(cwlStats.byTag, tagRaw);
    if (!season || !playerStats) return { events: [], totals: statsSummary(emptyStats()) };

    const stats = normalizeStats(playerStats);
    stats.warCount = toInt(
        playerStats.resolvedWarDays != null
            ? playerStats.resolvedWarDays
            : (playerStats.daysInLineup != null ? playerStats.daysInLineup : stats.possibleAttacks)
    );
    const event = {
        id: `cwl:${season}`,
        legacyIds: [],
        label: season,
        at: parseMs(cwlStats.lastRefreshedAt) > 0
            ? toText(cwlStats.lastRefreshedAt).trim()
            : cwlSeasonStartAt(season),
        finalizedAt: '',
        seasonStartedAt: cwlSeasonStartAt(season),
        clanTag: normalizeTag(roster.connectedClanTag),
        stats
    };
    const totals = emptyStats();
    addStats(totals, stats);
    totals.warCount = stats.warCount;
    return { events: [event], totals: statsSummary(totals) };
}

function buildRosterCwlEvidenceForTag(rosterData, tagRaw, settingsRaw, preferredRosterRaw, limitRaw = null) {
    const settings = sanitizeSettings(settingsRaw);
    const limit = limitRaw == null ? settings.cwlLookbackSeasons : Math.max(1, toInt(limitRaw));
    const preferredRoster = preferredRosterRaw && typeof preferredRosterRaw === 'object' ? preferredRosterRaw : null;
    const rosters = getRosters(rosterData);
    const ordered = preferredRoster
        ? [preferredRoster, ...rosters.filter(roster => roster !== preferredRoster)]
        : rosters;
    const seen = new Set();
    const events = [];

    for (const roster of ordered) {
        for (const event of buildRosterCwlEvidence(roster, tagRaw).events) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            events.push(event);
        }
    }

    events.sort((left, right) => parseMs(right.at) - parseMs(left.at) || right.id.localeCompare(left.id));
    events.splice(limit);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.reduce((sum, event) => sum + toInt(event.stats?.warCount), 0);
    return { events, totals: statsSummary(totals) };
}

function mergeEvidenceSources(primaryRaw, secondaryRaw, limitRaw, kindRaw) {
    const primary = primaryRaw && typeof primaryRaw === 'object' ? primaryRaw : {};
    const secondary = secondaryRaw && typeof secondaryRaw === 'object' ? secondaryRaw : {};
    const kind = kindRaw === 'cwl' ? 'cwl' : 'regular';
    const limit = Math.max(1, toInt(limitRaw) || 1);
    const events = (Array.isArray(primary.events) ? primary.events : []).slice();
    const idsFor = eventRaw => {
        const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : {};
        return Array.from(new Set([event.id, ...(Array.isArray(event.legacyIds) ? event.legacyIds : [])]
            .map(value => toText(value).trim())
            .filter(Boolean)));
    };
    const sameEvent = (left, right) => {
        if (kind === 'regular') {
            const leftClan = normalizeTag(left?.clanTag);
            const rightClan = normalizeTag(right?.clanTag);
            if (leftClan && rightClan && leftClan !== rightClan) return false;
        }
        const leftIds = new Set(idsFor(left));
        return idsFor(right).some(id => leftIds.has(id));
    };
    const moreCompleteCwlStats = (preferredRaw, fallbackRaw) => {
        const preferred = normalizeStats(preferredRaw);
        const fallback = normalizeStats(fallbackRaw);
        for (const key of ['warCount', 'possibleAttacks', 'usedAttacks', 'countedAttacks', 'starsTotal']) {
            const difference = toInt(fallback[key]) - toInt(preferred[key]);
            if (difference !== 0) return difference > 0 ? fallback : preferred;
        }
        return preferred;
    };

    for (const fallback of Array.isArray(secondary.events) ? secondary.events : []) {
        const index = events.findIndex(event => sameEvent(event, fallback));
        if (index < 0) {
            events.push(fallback);
            continue;
        }
        const preferred = events[index];
        const preferredAt = parseMs(preferred?.at);
        const fallbackAt = parseMs(fallback?.at);
        const preferredFinalizedAt = parseMs(preferred?.finalizedAt);
        const fallbackFinalizedAt = parseMs(fallback?.finalizedAt);
        events[index] = {
            ...fallback,
            ...preferred,
            at: fallbackAt > preferredAt ? fallback.at : preferred.at,
            finalizedAt: fallbackFinalizedAt > preferredFinalizedAt ? fallback.finalizedAt : preferred.finalizedAt,
            seasonStartedAt: toText(preferred?.seasonStartedAt || fallback?.seasonStartedAt).trim(),
            clanTag: normalizeTag(preferred?.clanTag || fallback?.clanTag),
            stats: kind === 'cwl' ? moreCompleteCwlStats(preferred?.stats, fallback?.stats) : preferred.stats,
            context: kind === 'regular' ? (preferred?.context || fallback?.context) : undefined,
            legacyIds: Array.from(new Set([...idsFor(preferred), ...idsFor(fallback)]))
                .filter(id => id !== toText(preferred?.id).trim())
        };
    }
    events.sort((left, right) => parseMs(right.at) - parseMs(left.at) || toText(right.id).localeCompare(toText(left.id)));
    events.splice(limit);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = kind === 'cwl'
        ? events.reduce((sum, event) => sum + toInt(event?.stats?.warCount), 0)
        : events.length;
    return { events, totals: statsSummary(totals) };
}

function buildEvidenceForTagWithLimits(rosterData, tagRaw, settingsRaw, identityRaw, regularLimitRaw, cwlLimitRaw) {
    const tag = normalizeTag(tagRaw);
    const store = rosterData?.playerWarPerformance && typeof rosterData.playerWarPerformance === 'object'
        ? rosterData.playerWarPerformance
        : {};
    const byTag = store.byTag && typeof store.byTag === 'object' ? store.byTag : {};
    const entry = getTaggedValue(byTag, tag) || {};
    const roster = findEvidenceRoster(rosterData, tag, identityRaw);
    const settings = sanitizeSettings(settingsRaw);
    const regularLimit = Math.max(1, toInt(regularLimitRaw) || settings.regularLookbackWars);
    const cwlLimit = Math.max(1, toInt(cwlLimitRaw) || settings.cwlLookbackSeasons);
    const globalRegular = buildRegularEvidence(entry, settings, regularLimit);
    const globalCwl = buildCwlEvidence(entry, settings, cwlLimit);
    const regular = mergeEvidenceSources(
        globalRegular,
        buildRosterRegularEvidenceForTag(rosterData, tag, settings, roster, regularLimit),
        regularLimit,
        'regular'
    );
    const cwl = mergeEvidenceSources(
        globalCwl,
        buildRosterCwlEvidenceForTag(rosterData, tag, settings, roster, cwlLimit),
        cwlLimit,
        'cwl'
    );
    const rosterPerformance = roster?.warPerformance && typeof roster.warPerformance === 'object' ? roster.warPerformance : {};
    const rosterCwlStats = roster?.cwlStats && typeof roster.cwlStats === 'object' ? roster.cwlStats : {};

    return {
        capturedAt: toText(
            store.updatedAt ||
            rosterPerformance.lastRefreshedAt ||
            rosterCwlStats.lastRefreshedAt ||
            rosterData?.lastUpdatedAt
        ).trim(),
        regular: regular.totals,
        cwl: cwl.totals,
        regularEvents: regular.events,
        cwlEvents: cwl.events
    };
}

function buildEvidenceForTag(rosterData, tagRaw, settingsRaw, identityRaw) {
    const settings = sanitizeSettings(settingsRaw);
    return buildEvidenceForTagWithLimits(
        rosterData,
        tagRaw,
        settings,
        identityRaw,
        settings.regularLookbackWars,
        settings.cwlLookbackSeasons
    );
}

function buildWarHistoryForTag(rosterData, tagRaw, identityRaw) {
    return buildEvidenceForTagWithLimits(
        rosterData,
        tagRaw,
        DEFAULT_SETTINGS,
        identityRaw,
        Number.MAX_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
    );
}

function buildSignals(evidenceRaw, settingsRaw) {
    const settings = sanitizeSettings(settingsRaw);
    const evidence = evidenceRaw && typeof evidenceRaw === 'object' ? evidenceRaw : {};
    const regular = statsSummary(evidence.regular);
    const cwl = statsSummary(evidence.cwl);
    const regularEvents = Array.isArray(evidence.regularEvents) ? evidence.regularEvents : [];
    const cwlEvents = Array.isArray(evidence.cwlEvents) ? evidence.cwlEvents : [];
    const buildRevisions = events => {
        if (!events.length) return ['none'];
        const sequences = [events.map(event => event.id)];
        const maxAliasCount = events.reduce(
            (max, event) => Math.max(max, Array.isArray(event.legacyIds) ? event.legacyIds.length : 0),
            0
        );

        for (let aliasIndex = 0; aliasIndex < maxAliasCount; aliasIndex += 1) {
            sequences.push(events.map(event => event.legacyIds?.[aliasIndex] || event.id));
        }
        return Array.from(new Set(sequences.map(ids => stableRevision(ids.join('|')))));
    };
    const regularRevisions = buildRevisions(regularEvents);
    const cwlRevisions = buildRevisions(cwlEvents);
    const signals = [];
    const contextAnalysis = analyzeRegularContext(regularEvents, regular);
    const performanceRegular = settings.regularContextMode === 'assist' || settings.regularContextMode === 'automatic'
        ? contextAnalysis.adjustedStats
        : regular;

    if (regular.possibleAttacks > 0 && regular.missedAttacks >= settings.regularMissedThreshold) {
        signals.push({
            id: ['regular_missed', regularRevisions[0], regular.possibleAttacks, regular.missedAttacks].join(':'),
            reasonCode: 'regular_missed',
            title: 'Regular-war attacks missed',
            text: `${regular.missedAttacks} of ${regular.possibleAttacks} available attacks missed`
        });
    }

    if (
        settings.regularPerformanceEnabled &&
        performanceRegular.countedAttacks >= settings.regularMinimumAttacks &&
        performanceRegular.averageStars < settings.regularAverageStarsThreshold &&
        performanceRegular.averageDestruction < settings.regularAverageDestructionThreshold
    ) {
        signals.push({
            id: ['regular_performance', regularRevisions[0], performanceRegular.countedAttacks, performanceRegular.starsTotal, performanceRegular.totalDestruction].join(':'),
            reasonCode: 'regular_performance',
            title: 'Regular-war results',
            text: `${formatNumber(performanceRegular.averageStars, 1)} stars · ${formatNumber(performanceRegular.averageDestruction, 0)}% · ${performanceRegular.countedAttacks} counted ${plural(performanceRegular.countedAttacks, 'attack')}` +
                (contextAnalysis.forcedHardAttackCount && performanceRegular !== regular
                    ? ` (${contextAnalysis.forcedHardAttackCount} forced hard ${plural(contextAnalysis.forcedHardAttackCount, 'target')} excluded)`
                    : '')
        });
    }

    if (
        settings.regularContextMode === 'automatic' &&
        contextAnalysis.mirrorEvaluableWars >= 5 &&
        contextAnalysis.mirrorViolationWars >= 3 &&
        contextAnalysis.mirrorViolationRate >= 0.6
    ) {
        signals.push({
            id: ['regular_mirror_pattern', regularRevisions[0], contextAnalysis.mirrorEvaluableWars, contextAnalysis.mirrorViolationWars].join(':'),
            reasonCode: 'regular_mirror_pattern',
            title: 'Repeated open-mirror deviations',
            text: `${contextAnalysis.mirrorViolationWars} of ${contextAnalysis.mirrorEvaluableWars} evaluable wars started away from an open mirror`
        });
    }

    if (
        settings.regularContextMode === 'automatic' &&
        contextAnalysis.timingEvaluableWars >= 5 &&
        contextAnalysis.lateLowTownHallWars >= 3 &&
        contextAnalysis.lateLowTownHallRate >= 0.6 &&
        contextAnalysis.lateForcedHardWars >= 2
    ) {
        signals.push({
            id: ['regular_timing_pattern', regularRevisions[0], contextAnalysis.timingEvaluableWars, contextAnalysis.lateLowTownHallWars, contextAnalysis.lateForcedHardWars].join(':'),
            reasonCode: 'regular_timing_pattern',
            title: 'Repeated late low-TH attacks',
            text: `${contextAnalysis.lateLowTownHallWars} of ${contextAnalysis.timingEvaluableWars} evaluable wars started after 70% of clan attacks; ${contextAnalysis.lateForcedHardWars} ended in forced hard targets`
        });
    }

    if (cwl.possibleAttacks > 0 && cwl.missedAttacks >= settings.cwlMissedThreshold) {
        signals.push({
            id: ['cwl_missed', cwlRevisions[0], cwl.possibleAttacks, cwl.missedAttacks].join(':'),
            reasonCode: 'cwl_missed',
            title: 'CWL attacks missed',
            text: `${cwl.missedAttacks} of ${cwl.possibleAttacks} available attacks missed`
        });
    }

    if (
        settings.cwlPerformanceEnabled &&
        cwl.countedAttacks >= settings.cwlMinimumAttacks &&
        cwl.averageStars < settings.cwlAverageStarsThreshold &&
        cwl.averageDestruction < settings.cwlAverageDestructionThreshold
    ) {
        signals.push({
            id: ['cwl_performance', cwlRevisions[0], cwl.countedAttacks, cwl.starsTotal, cwl.totalDestruction].join(':'),
            reasonCode: 'cwl_performance',
            title: 'CWL results',
            text: `${formatNumber(cwl.averageStars, 1)} stars · ${formatNumber(cwl.averageDestruction, 0)}% · ${cwl.countedAttacks} ${plural(cwl.countedAttacks, 'attack')}`
        });
    }

    for (const signal of signals) {
        const revisions = signal.reasonCode.startsWith('regular_') ? regularRevisions : cwlRevisions;
        const parts = signal.id.split(':');
        signal.legacyIds = revisions.slice(1).map(revision =>
            [parts[0], revision, ...parts.slice(2)].join(':')
        );
    }

    return signals;
}

function normalizeConversation(caseRaw) {
    const value = caseRaw && typeof caseRaw === 'object' ? caseRaw : {};
    const messages = (Array.isArray(value.conversation) ? value.conversation : [])
        .map((entry, index) => {
            const direction = String(entry?.direction || '').trim().toLowerCase();
            const atMs = parseMs(entry?.at);
            const messageText = String(entry?.text || '').trim().slice(0, 2000);
            if (!['staff', 'player'].includes(direction) || !atMs || !messageText) return null;
            return {
                id: String(entry?.id || `${direction}:${entry?.messageId || entry?.at}:${index}`).trim().slice(0, 160),
                direction,
                at: new Date(atMs).toISOString(),
                actor: String(entry?.actor || (direction === 'player' ? 'Player' : 'Staff')).trim().slice(0, 80),
                text: messageText,
                messageId: /^\d{17,20}$/.test(String(entry?.messageId || '').trim()) ? String(entry.messageId).trim() : '',
                deliveryMode: direction === 'staff' && String(entry?.deliveryMode || '').toLowerCase() === 'bot' ? 'bot' : 'manual'
            };
        })
        .filter(Boolean);
    if (!messages.length && value.dmText && parseMs(value.dmSentAt) > 0) {
        messages.push({
            id: `legacy-staff:${value.dmMessageId || value.dmSentAt}`,
            direction: 'staff',
            at: new Date(parseMs(value.dmSentAt)).toISOString(),
            actor: String(value.dmSentByName || 'Staff').trim().slice(0, 80),
            text: String(value.dmText).trim().slice(0, 2000),
            messageId: /^\d{17,20}$/.test(String(value.dmMessageId || '').trim()) ? String(value.dmMessageId).trim() : '',
            deliveryMode: String(value.dmDeliveryMode || '').toLowerCase() === 'bot' ? 'bot' : 'manual'
        });
        if (value.playerResponse && parseMs(value.playerResponseAt) > 0) {
            messages.push({
                id: `legacy-player:${value.playerResponseMessageId || value.playerResponseAt}`,
                direction: 'player',
                at: new Date(parseMs(value.playerResponseAt)).toISOString(),
                actor: 'Player',
                text: String(value.playerResponse).trim().slice(0, 2000),
                messageId: /^\d{17,20}$/.test(String(value.playerResponseMessageId || '').trim()) ? String(value.playerResponseMessageId).trim() : '',
                deliveryMode: 'manual'
            });
        }
    }
    return messages.sort((left, right) => parseMs(left.at) - parseMs(right.at)).slice(-40);
}

function normalizeCase(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const tag = normalizeTag(value.tag);
    if (!tag) return null;
    const conversation = normalizeConversation(value);

    return {
        tag,
        status: 'needs_review',
        outcome: '',
        handledBy: '',
        discordId: '',
        assignedModeratorId: '',
        assignedModeratorName: '',
        assignmentCoverageOverride: false,
        assignedAt: '',
        assignmentUpdatedAt: '',
        lastMeaningfulActionAt: '',
        assignmentBlockedModeratorId: '',
        assignmentBlockedUntil: '',
        waitingUntil: '',
        waitingReason: '',
        contactStage: '',
        contactAutomaticReminderAllowed: true,
        contactReminderText: '',
        contactReminderSentAt: '',
        contactReminderMessageId: '',
        contactNoResponseAt: '',
        contactReminderFailedAt: '',
        contactReminderFailureReason: '',
        playerResponse: '',
        playerResponseAt: '',
        playerResponseMessageId: '',
        dmDeliveryMode: '',
        dmMessageId: '',
        dmSentByDiscordId: '',
        dmSentByName: '',
        dmQueueId: '',
        dmQueuedAt: '',
        dmQueuedByDiscordId: '',
        dmQueuedByName: '',
        dmDeliveryFailedAt: '',
        dmDeliveryFailureReason: '',
        replyCaptureUntil: '',
        conversation: [],
        conversationTrimmedCount: 0,
        resolutionNote: '',
        escalatedAt: '',
        escalatedBy: '',
        openedAt: '',
        triggerSignalIds: [],
        reasonCodes: [],
        dismissedSignalIds: [],
        removalReason: '',
        removalStartedAt: '',
        removalActionedAt: '',
        removalAbsentObservedAt: '',
        removalRejoinedAt: '',
        removalRejoinCount: 0,
        rejoinRosterId: '',
        rejoinRosterTitle: '',
        rejoinClanTag: '',
        mutationLedger: [],
        evidence: { regular: emptyStats(), cwl: emptyStats(), regularEvents: [], cwlEvents: [] },
        activity: [],
        ...value,
        conversation,
        conversationTrimmedCount: Math.max(0, toInt(value.conversationTrimmedCount)),
        tag
    };
}

function eventsAfter(eventsRaw, timestampRaw, clanTagRaw) {
    const startMs = parseMs(timestampRaw);
    const clanTag = normalizeTag(clanTagRaw);

    return (Array.isArray(eventsRaw) ? eventsRaw : [])
        .filter(event => {
            if (!event || typeof event !== 'object') return false;
            if (startMs && parseMs(event.at) <= startMs) return false;
            if (clanTag && normalizeTag(event.clanTag) !== clanTag) return false;
            return true;
        })
        .sort((left, right) => parseMs(left.at) - parseMs(right.at));
}

function buildEvidenceAfter(evidenceRaw, timestampRaw, baselineEvidenceRaw) {
    const evidence = evidenceRaw && typeof evidenceRaw === 'object' ? evidenceRaw : {};
    const baselineEvidence = baselineEvidenceRaw && typeof baselineEvidenceRaw === 'object' ? baselineEvidenceRaw : {};
    const regularEvents = eventsAfter(evidence.regularEvents, timestampRaw, '')
        .sort((left, right) => parseMs(right.at) - parseMs(left.at) || toText(right.id).localeCompare(toText(left.id)));
    const baselineCwlById = new Map((Array.isArray(baselineEvidence.cwlEvents) ? baselineEvidence.cwlEvents : [])
        .filter(event => event && toText(event.id).trim())
        .map(event => [toText(event.id).trim(), event]));
    const hasCapturedBaseline = parseMs(baselineEvidence.capturedAt) > 0;
    const newestBaselineSeasonMs = Math.max(0, ...Array.from(baselineCwlById.values()).map(event =>
        parseMs(event?.seasonStartedAt) || parseMs(cwlSeasonStartAt(
            toText(event?.label || event?.id).replace(/^cwl:/, '').split(':after-close:')[0]
        ))
    ));
    const cwlEvents = (Array.isArray(evidence.cwlEvents) ? evidence.cwlEvents : []).map(eventRaw => {
        const event = eventRaw && typeof eventRaw === 'object' ? eventRaw : null;
        if (!event) return null;
        const id = toText(event.id).trim();
        const baseline = baselineCwlById.get(id);
        if (!baseline) {
            const finalizedAtMs = parseMs(event.finalizedAt);
            if (finalizedAtMs > parseMs(timestampRaw)) return event;
            const seasonStartedAtMs = parseMs(event.seasonStartedAt) || parseMs(cwlSeasonStartAt(event.label));
            if (hasCapturedBaseline && newestBaselineSeasonMs === 0) return event;
            return seasonStartedAtMs > newestBaselineSeasonMs && seasonStartedAtMs > 0 ? event : null;
        }
        const currentStats = normalizeStats(event.stats);
        const baselineStats = normalizeStats(baseline.stats);
        const delta = emptyStats();
        for (const key of Object.keys(delta)) {
            if (currentStats[key] < baselineStats[key]) return null;
            delta[key] = currentStats[key] - baselineStats[key];
        }
        const hasDelta = delta.possibleAttacks > 0 || delta.usedAttacks > 0 || delta.missedAttacks > 0 ||
            delta.countedAttacks > 0 || delta.warCount > 0;
        if (!hasDelta) return null;
        return {
            ...event,
            id: `${id}:after-close:${stableRevision(Object.keys(delta).map(key => delta[key]).join('|'))}`,
            legacyIds: [],
            at: toText(evidence.capturedAt || event.at).trim(),
            stats: delta
        };
    }).filter(Boolean)
        .sort((left, right) => parseMs(right.at) - parseMs(left.at) || toText(right.id).localeCompare(toText(left.id)));
    const regularTotals = emptyStats();
    const cwlTotals = emptyStats();
    for (const event of regularEvents) addStats(regularTotals, event.stats);
    for (const event of cwlEvents) addStats(cwlTotals, event.stats);
    regularTotals.warCount = regularEvents.length;
    cwlTotals.warCount = cwlEvents.reduce((sum, event) => sum + toInt(event?.stats?.warCount), 0);
    return {
        capturedAt: toText(evidence.capturedAt).trim(),
        regular: statsSummary(regularTotals),
        cwl: statsSummary(cwlTotals),
        regularEvents,
        cwlEvents
    };
}

function buildRecoveryProgress(caseRaw, currentEvidenceRaw) {
    const value = normalizeCase(caseRaw);
    const evidence = currentEvidenceRaw && typeof currentEvidenceRaw === 'object' ? currentEvidenceRaw : {};
    if (!value) return { ready: false, completedWars: 0, targetWars: 0, totalWars: 0, usedAttacks: 0, possibleAttacks: 0, missedAttacks: 0, events: [] };

    const events = eventsAfter(evidence.regularEvents, value.recoveryStartedAt || value.dmSentAt, value.targetClanTag);
    const targetWars = Math.max(1, toInt(value.recoveryWarTarget) || 3);
    let consecutiveCleanWars = 0;
    let usedAttacks = 0;
    let possibleAttacks = 0;
    let missedAttacks = 0;

    for (const event of events) {
        const stats = normalizeStats(event.stats);
        usedAttacks += stats.usedAttacks;
        possibleAttacks += stats.possibleAttacks;
        missedAttacks += stats.missedAttacks;
        if (value.requireNoMisses !== false && stats.missedAttacks > 0) consecutiveCleanWars = 0;
        else consecutiveCleanWars += 1;
    }

    const completedWars = value.requireNoMisses === false ? events.length : consecutiveCleanWars;
    return {
        ready: completedWars >= targetWars,
        completedWars,
        targetWars,
        totalWars: events.length,
        usedAttacks,
        possibleAttacks,
        missedAttacks,
        events
    };
}

function buildWatchProgress(caseRaw, currentEvidenceRaw, settingsRaw) {
    const value = normalizeCase(caseRaw);
    const evidence = currentEvidenceRaw && typeof currentEvidenceRaw === 'object' ? currentEvidenceRaw : {};
    if (!value) return { ready: false, triggered: false, completedWars: 0, targetWars: 0, events: [], signals: [], signalIds: [] };

    const events = eventsAfter(evidence.regularEvents, value.watchStartedAt, '');
    const targetWars = Math.max(1, toInt(value.watchWarTarget) || 2);
    const totals = emptyStats();
    for (const event of events) addStats(totals, event.stats);
    totals.warCount = events.length;
    const watchEvidence = {
        capturedAt: toText(evidence.capturedAt).trim(),
        regular: statsSummary(totals),
        cwl: emptyStats(),
        regularEvents: events,
        cwlEvents: []
    };
    const signals = buildSignals(watchEvidence, {
        ...sanitizeSettings(settingsRaw),
        cwlPerformanceEnabled: false,
        cwlMissedThreshold: 8
    }).filter(signal => signal.reasonCode.startsWith('regular_'));
    const triggered = signals.length > 0;
    return {
        ready: triggered || events.length >= targetWars,
        triggered,
        completedWars: events.length,
        targetWars,
        events,
        signals,
        signalIds: signals.map(signal => signal.id),
        evidence: watchEvidence
    };
}

function buildWorkItems(rosterData, privateStateRaw) {
    const privateState = privateStateRaw && typeof privateStateRaw === 'object' ? privateStateRaw : {};
    const settings = sanitizeSettings(privateState.settings);
    const directory = buildPlayerDirectory(rosterData, settings);
    const caseByTag = {};

    for (const raw of Array.isArray(privateState.cases) ? privateState.cases : []) {
        const value = normalizeCase(raw);
        if (value) caseByTag[value.tag] = value;
    }

    const tags = new Set([...Object.keys(directory.byTag), ...Object.keys(caseByTag)]);
    const items = [];

    for (const tag of tags) {
        const player = directory.byTag[tag] || null;
        const caseValue = caseByTag[tag] || null;
        if (settings.trustedPlayerTags.includes(tag)) continue;
        const trackedRemoval = caseValue && ['needs_dm', 'removal_pending', 'removed', 'removal_evasion'].includes(caseValue.status) &&
            (caseValue.contactPurpose === 'removal' || caseValue.status !== 'needs_dm');
        if (!player && directory.missingTags.has(tag) && !trackedRemoval) continue;

        const evidenceOwner = player || {
            sourceRosterId: toText(caseValue?.sourceRosterId).trim(),
            sourceClanTag: normalizeTag(caseValue?.sourceClanTag)
        };
        const evidence = buildEvidenceForTag(rosterData, tag, settings, evidenceOwner);
        const signals = player?.automaticEligible ? buildSignals(evidence, settings) : [];
        const dismissed = new Set(Array.isArray(caseValue?.dismissedSignalIds) ? caseValue.dismissedSignalIds : []);
        let status = caseValue ? toText(caseValue.status).trim() : (signals.length ? 'needs_review' : '');
        const wasClosed = status === 'closed' || status === 'dismissed';
        const postCloseEvidence = wasClosed && parseMs(caseValue?.closedAt) > 0
            ? buildEvidenceAfter(evidence, caseValue.closedAt, caseValue.evidence)
            : null;
        const postCloseSignals = postCloseEvidence && player?.automaticEligible
            ? buildSignals(postCloseEvidence, settings)
            : null;
        const newSignals = postCloseSignals || signals.filter(signal =>
            ![signal.id, ...(Array.isArray(signal.legacyIds) ? signal.legacyIds : [])]
                .some(id => dismissed.has(id))
        );
        const hasNewSignal = newSignals.length > 0;

        if ((status === 'closed' || status === 'dismissed') && hasNewSignal) status = 'needs_review';
        if (status === 'dismissed') status = 'closed';

        const recovery = caseValue?.status === 'hero_down' ? buildRecoveryProgress(caseValue, evidence) : null;
        const watching = caseValue?.status === 'watching' ? buildWatchProgress(caseValue, evidence, settings) : null;
        if (recovery?.ready) status = 'ready';
        if (caseValue?.status === 'watching') {
            if (watching?.triggered) status = 'needs_review';
            else if (watching?.ready) status = 'closed';
        }
        const removalRejoinDetected = Boolean(
            caseValue?.status === 'removed' && caseValue.removalAbsentObservedAt && player
        );
        if (caseValue?.status === 'removed') {
            status = removalRejoinDetected ? 'needs_review' : 'closed';
        }
        if (caseValue?.status === 'removal_evasion') status = 'needs_review';
        if (!status) continue;

        const identity = player || {
            tag,
            name: toText(caseValue?.name).trim() || tag,
            discord: toText(caseValue?.discord).trim(),
            discordId: toText(caseValue?.discordId).trim(),
            hasDiscord: Boolean(toText(caseValue?.discordId).trim() || toText(caseValue?.discord).trim()),
            th: 0,
            role: '',
            rosterId: toText(caseValue?.sourceRosterId).trim(),
            rosterTitle: toText(caseValue?.sourceRosterTitle).trim(),
            clanTag: normalizeTag(caseValue?.sourceClanTag),
            automaticEligible: false
        };

        const reopenedFromClosed = wasClosed && status === 'needs_review' && hasNewSignal;
        const itemSignals = watching?.triggered ? watching.signals : (reopenedFromClosed ? newSignals : signals);
        items.push({
            tag,
            player: identity,
            case: caseValue,
            evidence: reopenedFromClosed && postCloseEvidence ? postCloseEvidence : evidence,
            currentEvidence: evidence,
            signals: itemSignals,
            signalIds: itemSignals.map(signal => signal.id),
            status,
            recovery,
            watching,
            removalRejoinDetected
        });
    }

    items.sort((left, right) => {
        const leftOrder = STATUS_ORDER.indexOf(left.status);
        const rightOrder = STATUS_ORDER.indexOf(right.status);
        return (leftOrder < 0 ? 99 : leftOrder) - (rightOrder < 0 ? 99 : rightOrder) ||
            toText(left.player.rosterTitle).localeCompare(toText(right.player.rosterTitle)) ||
            toText(left.player.name).localeCompare(toText(right.player.name));
    });

    return { items, directory, settings, caseByTag };
}

function evidenceSentence(reasonCode, evidenceRaw, settingsRaw) {
    const evidence = evidenceRaw && typeof evidenceRaw === 'object' ? evidenceRaw : {};
    const regular = statsSummary(evidence.regular);
    const cwl = statsSummary(evidence.cwl);
    const settings = sanitizeSettings(settingsRaw);
    const contextAnalysis = analyzeRegularContext(evidence.regularEvents, regular);
    const performanceRegular = settings.regularContextMode === 'assist' || settings.regularContextMode === 'automatic'
        ? contextAnalysis.adjustedStats
        : regular;

    if (reasonCode === 'regular_missed' && regular.possibleAttacks > 0) {
        return `In the reviewed regular wars, ${regular.missedAttacks} of ${regular.possibleAttacks} available attacks were not used.`;
    }
    if (reasonCode === 'cwl_missed' && cwl.possibleAttacks > 0) {
        return `In the reviewed CWL seasons, ${cwl.missedAttacks} of ${cwl.possibleAttacks} available attacks were not used.`;
    }
    if (reasonCode === 'regular_performance' && performanceRegular.countedAttacks > 0) {
        return `Across ${performanceRegular.countedAttacks} counted regular-war attacks` +
            (contextAnalysis.forcedHardAttackCount && performanceRegular !== regular
                ? `, after excluding ${contextAnalysis.forcedHardAttackCount} forced hard ${plural(contextAnalysis.forcedHardAttackCount, 'target')}`
                : '') +
            `, the average result was ${formatNumber(performanceRegular.averageStars, 1)} stars and ${formatNumber(performanceRegular.averageDestruction, 0)}% destruction.`;
    }
    if (reasonCode === 'regular_mirror_pattern' && contextAnalysis.mirrorEvaluableWars > 0) {
        return `Across ${contextAnalysis.mirrorEvaluableWars} recent wars where the mirror was still open, the first attack went elsewhere ${contextAnalysis.mirrorViolationWars} times.`;
    }
    if (reasonCode === 'regular_timing_pattern' && contextAnalysis.timingEvaluableWars > 0) {
        return `As a lower-TH lineup member, the first attack came after 70% of clan attacks in ${contextAnalysis.lateLowTownHallWars} of ${contextAnalysis.timingEvaluableWars} recent evaluable wars; ${contextAnalysis.lateForcedHardWars} of those led to a forced hard target.`;
    }
    if (reasonCode === 'cwl_performance' && cwl.countedAttacks > 0) {
        return `Across ${cwl.countedAttacks} CWL attacks, the average result was ${formatNumber(cwl.averageStars, 1)} stars and ${formatNumber(cwl.averageDestruction, 0)}% destruction.`;
    }
    return '';
}

function buildDmText(optionsRaw) {
    const options = optionsRaw && typeof optionsRaw === 'object' ? optionsRaw : {};
    const playerName = toText(options.playerName).trim() || 'there';
    const sourceClan = toText(options.sourceClan).trim() || 'your current clan';
    const targetClan = toText(options.targetClan).trim() || 'the hero-down clan';
    const targetClanLink = buildClanProfileLink(options.targetClanTag);
    const nextWarTimestamp = discordRelativeTimestamp(options.nextWarStartAt);
    const recoveryWars = Math.max(1, toInt(options.recoveryWars) || 3);
    const reasonCodes = Array.isArray(options.reasonCodes) ? options.reasonCodes : [];
    const sentences = reasonCodes.map(code => evidenceSentence(code, options.evidence, options.settings)).filter(Boolean);

    if (!sentences.length) sentences.push('Staff reviewed your recent regular-war and CWL participation.');

    return [
        `Hi ${playerName}.`,
        sentences.join(' '),
        `For now, you will not participate in regular wars in ${sourceClan}.`,
        `Please play regular wars in ${targetClan} and complete ${recoveryWars} consecutive ${plural(recoveryWars, 'war')} without missing an attack.`,
        nextWarTimestamp
            ? `The next war there will start ${nextWarTimestamp}, when the current war ends.`
            : 'The next war there will start when the current war ends.',
        targetClanLink ? `Clan link: ${targetClanLink}` : '',
        'Staff will review you again after that.'
    ].filter(Boolean).join(' ');
}

function buildRemovalDmText(optionsRaw) {
    const options = optionsRaw && typeof optionsRaw === 'object' ? optionsRaw : {};
    const playerName = toText(options.playerName).trim() || 'there';
    const reason = toText(options.reason).replace(/\s+/g, ' ').trim();
    return [
        `Hi ${playerName}.`,
        'Leadership has decided to remove your account from the TURTLE clan community.',
        reason ? `Reason: ${reason}` : '',
        'Please do not rejoin another TURTLE clan unless leadership explicitly approves your return.',
        'If you believe this is a mistake, reply here or contact a leader.'
    ].filter(Boolean).join(' ');
}

function discordIdentityText(playerRaw) {
    const player = playerRaw && typeof playerRaw === 'object' ? playerRaw : {};
    const username = toText(player.discord).trim();
    const discordIdRaw = toText(player.discordId).trim();
    const discordId = /^\d{17,20}$/.test(discordIdRaw) ? discordIdRaw : '';
    if (username && discordId) return `${username} · <@${discordId}>`;
    if (username) return username;
    if (discordId) return `<@${discordId}>`;
    return 'Not linked';
}

function buildCaseFingerprint(itemRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const recovery = item.recovery || {};
    const watching = item.watching || {};
    return stableRevision(JSON.stringify({
        tag: normalizeTag(item.tag),
        status: toText(item.status),
        signals: (Array.isArray(item.signalIds) ? item.signalIds : []).slice().sort(),
        recovery: [recovery.completedWars || 0, recovery.targetWars || 0, recovery.ready === true],
        watching: [watching.completedWars || 0, watching.targetWars || 0, watching.ready === true, watching.triggered === true],
        removalRejoinDetected: item.removalRejoinDetected === true,
        decisionUpdatedAt: ['needs_dm', 'removal_pending', 'hero_down', 'ready', 'closed'].includes(item.status)
            ? toText(item.case?.updatedAt)
            : ''
    }));
}

module.exports = {
    DEFAULT_SETTINGS,
    STATUS_ORDER,
    STATUS_META,
    normalizeTag,
    parseMs,
    formatDate,
    discordRelativeTimestamp,
    buildClanProfileLink,
    formatNumber,
    stableRevision,
    sanitizeSettings,
    emptyStats,
    normalizeStats,
    statsSummary,
    sanitizeRegularAttackContext,
    analyzeRegularContext,
    formatRegularAttackContextLines,
    getTaggedValue,
    buildPlayerDirectory,
    buildIgnoredPlayerEntries,
    buildEvidenceForTag,
    buildWarHistoryForTag,
    buildSignals,
    normalizeCase,
    buildRecoveryProgress,
    buildWatchProgress,
    buildWorkItems,
    buildDmText,
    buildRemovalDmText,
    discordIdentityText,
    buildCaseFingerprint
};
