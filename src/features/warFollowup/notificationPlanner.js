'use strict';

const workflow = require('./workflow');

const REMINDER_THRESHOLDS = Object.freeze([
    { minutes: 360, label: '6 hours' },
    { minutes: 120, label: '2 hours' },
    { minutes: 30, label: '30 minutes' }
]);
const ACTIONABLE_CASE_STATUSES = new Set(['needs_review', 'needs_dm', 'ready']);
const MAX_NOTIFICATION_LINES = 40;

function toText(value) {
    return value == null ? '' : String(value);
}

function safeInline(value, maxLength = 120) {
    return toText(value)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function unique(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function rosterTitle(roster) {
    return safeInline(roster?.title || roster?.name || roster?.id || 'Roster', 180);
}

function playerIdentity(rosterData, tagRaw) {
    const tag = workflow.normalizeTag(tagRaw);
    const metrics = rosterData?.playerMetrics?.byTag && typeof rosterData.playerMetrics.byTag === 'object'
        ? rosterData.playerMetrics.byTag
        : {};
    const metric = workflow.getTaggedValue(metrics, tag) || {};
    const identity = metric.identity && typeof metric.identity === 'object' ? metric.identity : {};
    let rosterPlayer = null;

    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        rosterPlayer = [...(Array.isArray(roster.main) ? roster.main : []), ...(Array.isArray(roster.subs) ? roster.subs : [])]
            .find(player => workflow.normalizeTag(player?.tag) === tag);
        if (rosterPlayer) break;
    }

    return {
        tag,
        name: toText(rosterPlayer?.name || identity.name || tag).trim() || tag,
        discordId: /^\d{17,20}$/.test(toText(identity.discordId).trim())
            ? toText(identity.discordId).trim()
            : ''
    };
}

function playerLine(identityRaw, suffixRaw = '') {
    const identity = identityRaw && typeof identityRaw === 'object' ? identityRaw : {};
    const displayName = identity.discordId
        ? `{{wfu-user:${identity.discordId}}}`
        : safeInline(identity.name || identity.tag);
    const tag = workflow.normalizeTag(identity.tag);
    const suffix = safeInline(suffixRaw, 220);
    return `• **${displayName}** · \`${tag}\`${suffix ? ` — ${suffix}` : ''}`;
}

function displayNameFallbacks(identitiesRaw) {
    const fallbacks = {};
    for (const identityRaw of Array.isArray(identitiesRaw) ? identitiesRaw : []) {
        const identity = identityRaw && typeof identityRaw === 'object' ? identityRaw : {};
        if (!identity.discordId || fallbacks[identity.discordId]) continue;
        fallbacks[identity.discordId] = safeInline(identity.name || identity.tag, 80);
    }
    return fallbacks;
}

function staffMention(config) {
    return /^\d{17,20}$/.test(toText(config?.staffRoleId).trim())
        ? `<@&${config.staffRoleId}>`
        : '';
}

function semanticKey(parts) {
    return parts.map(value => workflow.stableRevision(toText(value))).join(':');
}

function regularSummaryKey(roster, historyKey, entry) {
    return `summary:regular:${semanticKey([roster?.id, entry?.warKey || historyKey])}`;
}

function cwlEndSummaryKey(roster) {
    return `summary:cwl:${semanticKey([roster?.id, roster?.cwlStats?.season])}`;
}

function isCompletedCwlRoster(roster) {
    const cwl = roster?.cwlStats && typeof roster.cwlStats === 'object' ? roster.cwlStats : null;
    if (!cwl || cwl.currentWar || !cwl.season) return false;
    const byTag = cwl.byTag && typeof cwl.byTag === 'object' ? cwl.byTag : {};
    const maxResolvedDays = Math.max(0, ...Object.values(byTag).map(stats => Number(stats?.resolvedWarDays || stats?.daysInLineup || 0)));
    return maxResolvedDays >= 7;
}

function buildSummaryBaselineKeys(rosterData, featureKey) {
    const keys = [];
    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        if (featureKey === 'regularWarSummaries') {
            const history = roster?.warPerformance?.regularWarHistoryByKey && typeof roster.warPerformance.regularWarHistoryByKey === 'object'
                ? roster.warPerformance.regularWarHistoryByKey
                : {};
            for (const [historyKey, entry] of Object.entries(history)) {
                if (entry?.authoritative === true) keys.push(regularSummaryKey(roster, historyKey, entry));
            }
        } else if (featureKey === 'cwlEndSummaries' && isCompletedCwlRoster(roster)) {
            keys.push(cwlEndSummaryKey(roster));
        }
    }
    return unique(keys);
}

function eligibleReminder(endTimeRaw, nowMs) {
    const endMs = workflow.parseMs(endTimeRaw);
    const remainingMs = endMs - nowMs;
    if (!(remainingMs > 0)) return null;
    const remainingMinutes = Math.ceil(remainingMs / 60_000);
    const eligible = REMINDER_THRESHOLDS
        .filter(threshold => remainingMinutes <= threshold.minutes)
        .sort((left, right) => left.minutes - right.minutes);
    return eligible[0] || null;
}

function reminderKeys(prefix, selectedMinutes) {
    return REMINDER_THRESHOLDS
        .filter(threshold => threshold.minutes >= selectedMinutes)
        .map(threshold => `${prefix}:${threshold.minutes}m`);
}

function buildCurrentCaseObservations(work, nowIso) {
    const observations = {};
    for (const item of Array.isArray(work?.items) ? work.items : []) {
        observations[item.tag] = {
            fingerprint: workflow.buildCaseFingerprint(item),
            status: item.status,
            observedAt: nowIso
        };
    }
    return observations;
}

function planCaseAlerts(work, config, record, nowIso) {
    const current = buildCurrentCaseObservations(work, nowIso);
    const previous = record?.observations?.caseFingerprints || {};
    for (const [tag, observation] of Object.entries(current)) {
        if (previous[tag]?.fingerprint === observation.fingerprint) {
            observation.observedAt = previous[tag].observedAt || observation.observedAt;
        }
    }
    const initialized = Boolean(record?.observations?.casesInitializedAt);
    if (!initialized || config?.features?.caseAlerts !== true) {
        return { notification: null, observations: current };
    }

    const changed = (Array.isArray(work?.items) ? work.items : []).filter(item => {
        if (!ACTIONABLE_CASE_STATUSES.has(item.status)) return false;
        return previous[item.tag]?.fingerprint !== current[item.tag]?.fingerprint;
    });
    if (!changed.length) return { notification: null, observations: current };

    const changedIdentities = changed.slice(0, MAX_NOTIFICATION_LINES).map(item => ({
        tag: item.tag,
        name: item.player?.name,
        discordId: item.player?.discordId
    }));
    const lines = changed.slice(0, MAX_NOTIFICATION_LINES).map((item, index) => {
        const meta = workflow.STATUS_META[item.status] || workflow.STATUS_META.needs_review;
        const identity = changedIdentities[index];
        const reasons = item.signals?.length
            ? item.signals.map(signal => signal.title).join(', ')
            : meta.next;
        return `${meta.emoji} ${playerLine(identity, `${meta.label}: ${reasons}`).slice(2)}`;
    });
    if (changed.length > lines.length) lines.push(`• +${changed.length - lines.length} more; open the panel for the full queue.`);
    const notificationKey = `cases:${semanticKey(changed.map(item => `${item.tag}:${current[item.tag].fingerprint}`))}`;

    return {
        observations: current,
        notification: {
            key: notificationKey,
            kind: 'case-alert',
            featureKey: 'caseAlerts',
            content: changed.some(item => !item.case?.assignedModeratorId && !item.case?.handledBy)
                ? staffMention(config)
                : '',
            embeds: [{
                color: 0xf59e0b,
                title: 'War follow-up needs attention',
                description: lines.join('\n').slice(0, 4000),
                footer: { text: 'Open the War Follow Up panel to review and take action.' },
                timestamp: nowIso
            }],
            allowedUserIds: unique(changed.map(item => item.player?.discordId)),
            allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : [],
            displayNameFallbacks: displayNameFallbacks(changedIdentities)
        }
    };
}

function moderatorPreference(moderatorsRaw, discordIdRaw) {
    const discordId = toText(discordIdRaw).trim();
    const value = moderatorsRaw && typeof moderatorsRaw === 'object' ? moderatorsRaw[discordId] : null;
    return value && typeof value === 'object' ? value : null;
}

function assignmentDestinations(preference) {
    const mode = toText(preference?.notificationMode).trim().toLowerCase();
    if (mode === 'dm') return ['dm'];
    if (mode === 'both') return ['channel', 'dm'];
    return ['channel'];
}

function caseAssignmentNotification(item, preference, destination, config) {
    const caseValue = item.case || {};
    const moderatorId = toText(caseValue.assignedModeratorId).trim();
    const assignmentRevision = caseValue.assignmentUpdatedAt || caseValue.assignedAt || caseValue.updatedAt;
    const playerName = safeInline(item.player?.name || caseValue.name || item.tag, 100);
    const clanName = safeInline(caseValue.sourceRosterTitle || item.player?.rosterTitle || 'Unknown clan', 120);
    const key = `case-assignment:${semanticKey([item.tag, moderatorId, assignmentRevision])}:${destination}`;
    return {
        key,
        kind: 'case-assignment',
        destination,
        recipientUserId: moderatorId,
        content: destination === 'channel' ? `<@${moderatorId}>` : '',
        embeds: [{
            color: 0x5865f2,
            title: 'New moderation case assigned',
            description: [
                `**${playerName}** · \`${item.tag}\``,
                `Source clan: **${clanName}**${caseValue.sourceClanTag ? ` · \`${caseValue.sourceClanTag}\`` : ''}`,
                item.signals?.length
                    ? `Reason: ${safeInline(item.signals.map(signal => signal.title).join(', '), 500)}`
                    : 'Open War Follow Up to review the preserved case evidence.'
            ].join('\n'),
            footer: { text: 'This assignment remains valid even if a notification delivery fails.' },
            timestamp: assignmentRevision || undefined
        }],
        allowedUserIds: destination === 'channel' ? [moderatorId] : [],
        allowedRoleIds: [],
        displayNameFallbacks: { [moderatorId]: preference?.displayName || caseValue.assignedModeratorName || 'Moderator' }
    };
}

function inactivityReminderNotification(item, preference, destination, hours, config, nowIso) {
    const caseValue = item.case || {};
    const moderatorId = toText(caseValue.assignedModeratorId).trim();
    const anchor = caseValue.lastMeaningfulActionAt || caseValue.assignedAt || caseValue.updatedAt;
    const keyPrefix = `case-inactivity:${semanticKey([item.tag, moderatorId, anchor])}`;
    const consumeKeys = [24, 48]
        .filter(threshold => threshold <= hours)
        .map(threshold => `${keyPrefix}:${threshold}h:${destination}`);
    return {
        key: `${keyPrefix}:${hours}h:${destination}`,
        consumeKeys,
        kind: 'case-inactivity-reminder',
        destination,
        recipientUserId: moderatorId,
        content: destination === 'channel' ? `<@${moderatorId}>` : '',
        embeds: [{
            color: hours >= 48 ? 0xed4245 : 0xf59e0b,
            title: `Moderation case needs an update · ${hours}h`,
            description: [
                `**${safeInline(item.player?.name || caseValue.name || item.tag, 100)}** · \`${item.tag}\``,
                `Assigned to **{{wfu-user:${moderatorId}}}** with no meaningful action for ${hours} hours.`,
                hours >= 48
                    ? 'Please update, wait, resolve, reassign, or escalate it. At 72 hours it will be reassigned automatically.'
                    : 'Please record an update or set a follow-up time.'
            ].join('\n'),
            timestamp: nowIso
        }],
        allowedUserIds: destination === 'channel' ? [moderatorId] : [],
        allowedRoleIds: [],
        displayNameFallbacks: { [moderatorId]: preference?.displayName || caseValue.assignedModeratorName || 'Moderator' }
    };
}

function planModerationOwnershipNotifications(work, config, record, moderators, nowMs) {
    const notifications = [];
    for (const item of Array.isArray(work?.items) ? work.items : []) {
        const caseValue = item.case && typeof item.case === 'object' ? item.case : null;
        if (caseValue?.escalatedAt) {
            const escalationKey = `case-escalation:${semanticKey([item.tag, caseValue.escalatedAt])}`;
            if (!record?.deliveries?.[escalationKey]) {
                notifications.push({
                    key: escalationKey,
                    kind: 'case-escalation',
                    destination: 'channel',
                    content: staffMention(config),
                    embeds: [{
                        color: 0xed4245,
                        title: 'Leadership review requested',
                        description: `**${safeInline(item.player?.name || caseValue.name || item.tag)}** · \`${item.tag}\` was escalated by ${safeInline(caseValue.escalatedBy || 'a moderator')}.`,
                        timestamp: caseValue.escalatedAt
                    }],
                    allowedUserIds: [],
                    allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : []
                });
            }
        }
        const moderatorId = toText(caseValue?.assignedModeratorId).trim();
        if (!moderatorId && !caseValue?.handledBy && caseValue?.assignmentUpdatedAt && !['closed', 'dismissed'].includes(caseValue.status)) {
            const unassignedKey = `case-unassigned:${semanticKey([item.tag, caseValue.assignmentUpdatedAt])}`;
            if (!record?.deliveries?.[unassignedKey]) {
                notifications.push({
                    key: unassignedKey,
                    kind: 'case-unassigned',
                    destination: 'channel',
                    content: staffMention(config),
                    embeds: [{
                        color: 0xed4245,
                        title: 'Moderation case is unassigned',
                        description: `**${safeInline(item.player?.name || caseValue.name || item.tag)}** · \`${item.tag}\` needs an eligible moderator. Check clan coverage or assign it manually.`,
                        timestamp: caseValue.assignmentUpdatedAt
                    }],
                    allowedUserIds: [],
                    allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : []
                });
            }
        }
        if (!moderatorId || !caseValue?.assignmentUpdatedAt || ['closed', 'dismissed'].includes(caseValue.status)) continue;
        const preference = moderatorPreference(moderators, moderatorId);
        if (!preference) continue;
        for (const destination of assignmentDestinations(preference)) {
            const assignment = caseAssignmentNotification(item, preference, destination, config);
            if (!record?.deliveries?.[assignment.key]) notifications.push(assignment);
        }

        if (caseValue.status === 'waiting' && workflow.parseMs(caseValue.waitingUntil) > nowMs) continue;
        const anchorMs = workflow.parseMs(caseValue.lastMeaningfulActionAt || caseValue.assignedAt || caseValue.updatedAt);
        const elapsedHours = anchorMs > 0 ? Math.floor((nowMs - anchorMs) / (60 * 60 * 1000)) : 0;
        const reminderHours = elapsedHours >= 48 && elapsedHours < 72 ? 48 : (elapsedHours >= 24 && elapsedHours < 72 ? 24 : 0);
        if (!reminderHours) continue;
        for (const destination of assignmentDestinations(preference)) {
            const reminder = inactivityReminderNotification(
                item,
                preference,
                destination,
                reminderHours,
                config,
                new Date(nowMs).toISOString()
            );
            if (!reminder.consumeKeys.every(key => record?.deliveries?.[key])) notifications.push(reminder);
        }
    }
    return notifications;
}

function getRegularPendingPlayers(roster, rosterData) {
    const byTag = roster?.regularWar?.byTag && typeof roster.regularWar.byTag === 'object'
        ? roster.regularWar.byTag
        : {};
    return Object.entries(byTag)
        .map(([tag, value]) => ({
            identity: playerIdentity(rosterData, tag),
            current: value?.current && typeof value.current === 'object' ? value.current : {}
        }))
        .filter(entry => entry.current.inWar === true && Number(entry.current.attacksRemaining) > 0)
        .sort((left, right) => Number(right.current.attacksRemaining) - Number(left.current.attacksRemaining) || left.identity.name.localeCompare(right.identity.name));
}

function getCwlPendingPlayers(roster, rosterData) {
    const byTag = roster?.cwlStats?.byTag && typeof roster.cwlStats.byTag === 'object'
        ? roster.cwlStats.byTag
        : {};
    return Object.entries(byTag)
        .filter(([, stats]) => Number(stats?.currentWarAttackPending) > 0)
        .map(([tag]) => ({ identity: playerIdentity(rosterData, tag) }))
        .sort((left, right) => left.identity.name.localeCompare(right.identity.name));
}

function planAttackReminder({ roster, rosterData, config, record, nowMs, mode }) {
    const currentWar = mode === 'cwl' ? roster?.cwlStats?.currentWar : roster?.regularWar?.currentWar;
    const state = toText(currentWar?.state).trim().toLowerCase();
    if (state !== 'inwar') return null;

    const threshold = eligibleReminder(currentWar.endTime, nowMs);
    if (!threshold) return null;
    const warId = mode === 'cwl' ? currentWar.warTag : currentWar.warKey;
    if (!warId) return null;

    const prefix = `attack:${mode}:${semanticKey([roster.id, warId])}`;
    const key = `${prefix}:${threshold.minutes}m`;
    if (record?.deliveries?.[key]) return null;

    const pending = mode === 'cwl'
        ? getCwlPendingPlayers(roster, rosterData)
        : getRegularPendingPlayers(roster, rosterData);
    if (!pending.length) return null;

    const lines = pending.slice(0, MAX_NOTIFICATION_LINES).map(entry => playerLine(
        entry.identity,
        mode === 'cwl'
            ? '1 CWL attack remaining'
            : `${entry.current.attacksRemaining} ${plural(entry.current.attacksRemaining, 'attack')} remaining`
    ));
    if (pending.length > lines.length) lines.push(`• +${pending.length - lines.length} more linked in the roster.`);
    const userIds = unique(pending.map(entry => entry.identity.discordId));
    const unlinkedCount = pending.filter(entry => !entry.identity.discordId).length;
    const modeLabel = mode === 'cwl' ? 'CWL war' : 'regular war';
    const staff = unlinkedCount > 0 ? staffMention(config) : '';

    return {
        key,
        consumeKeys: reminderKeys(prefix, threshold.minutes),
        kind: `${mode}-attack-reminder`,
        featureKey: 'attackReminders',
        content: [...userIds.map(id => `<@${id}>`), staff].filter(Boolean).join(' '),
        embeds: [{
            color: 0xed4245,
            title: `${rosterTitle(roster)} · attacks still open`,
            description: [
                `The ${modeLabel} ends ${workflow.discordRelativeTimestamp(currentWar.endTime)}.`,
                '',
                ...lines,
                unlinkedCount > 0 ? `\n${unlinkedCount} player${unlinkedCount === 1 ? '' : 's'} could not be tagged because Discord is not linked.` : ''
            ].filter(Boolean).join('\n').slice(0, 4000),
            footer: { text: `Reminder window: ${threshold.label}` }
        }],
        allowedUserIds: userIds,
        allowedRoleIds: staff && config.staffRoleId ? [config.staffRoleId] : [],
        displayNameFallbacks: displayNameFallbacks(pending.slice(0, MAX_NOTIFICATION_LINES).map(entry => entry.identity))
    };
}

function planAllClear({ roster, config, record, mode, nowIso }) {
    const currentWar = mode === 'cwl' ? roster?.cwlStats?.currentWar : roster?.regularWar?.currentWar;
    if (toText(currentWar?.state).trim().toLowerCase() !== 'inwar') return null;
    const warId = mode === 'cwl' ? currentWar.warTag : currentWar.warKey;
    if (!warId) return null;

    const trackedEntries = mode === 'cwl'
        ? Object.values(roster?.cwlStats?.byTag || {})
        : Object.values(roster?.regularWar?.byTag || {}).filter(value => value?.current?.inWar === true);
    // An active-war pointer can arrive one snapshot before its lineup stats.
    // Treat that as incomplete data, never as an all-clear.
    if (!trackedEntries.length) return null;
    const pendingCount = mode === 'cwl'
        ? trackedEntries.filter(stats => Number(stats?.currentWarAttackPending) > 0).length
        : trackedEntries.filter(value => Number(value.current.attacksRemaining) > 0).length;
    if (pendingCount > 0) return null;

    const key = `all-clear:${mode}:${semanticKey([roster.id, warId])}`;
    if (record?.deliveries?.[key]) return null;
    const featureEnabled = mode === 'cwl'
        ? config?.features?.cwlDailyUpdates === true
        : config?.features?.attackReminders === true;
    if (!featureEnabled) return null;

    return {
        key,
        kind: `${mode}-all-clear`,
        featureKey: mode === 'cwl' ? 'cwlDailyUpdates' : 'attackReminders',
        content: '',
        embeds: [{
            color: 0x57f287,
            title: `${rosterTitle(roster)} · all attacks complete`,
            description: `No tracked ${mode === 'cwl' ? 'CWL' : 'regular-war'} attacks are still pending. Nice work.`,
            timestamp: nowIso
        }],
        allowedUserIds: [],
        allowedRoleIds: []
    };
}

function plural(count, singular) {
    return Number(count) === 1 ? singular : `${singular}s`;
}

function chunkLines(linesRaw, maxLength = 1000) {
    const lines = Array.isArray(linesRaw) ? linesRaw : [];
    const chunks = [];
    let current = '';
    for (const lineRaw of lines) {
        const line = toText(lineRaw).slice(0, maxLength);
        if (!current) {
            current = line;
        } else if (current.length + line.length + 1 <= maxLength) {
            current += `\n${line}`;
        } else {
            chunks.push(current);
            current = line;
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function summarizeStatsRows(statsByTagRaw, rosterData) {
    const rows = Object.entries(statsByTagRaw && typeof statsByTagRaw === 'object' ? statsByTagRaw : {})
        .map(([tag, statsRaw]) => {
            const stats = workflow.normalizeStats(statsRaw);
            return { identity: playerIdentity(rosterData, tag), stats };
        });
    const missed = rows
        .filter(row => row.stats.missedAttacks > 0)
        .sort((left, right) => right.stats.missedAttacks - left.stats.missedAttacks || left.identity.name.localeCompare(right.identity.name));
    const top = rows
        .filter(row => row.stats.countedAttacks > 0)
        .sort((left, right) =>
            right.stats.starsTotal - left.stats.starsTotal ||
            right.stats.totalDestruction - left.stats.totalDestruction ||
            left.identity.name.localeCompare(right.identity.name)
        )
        .slice(0, 5);
    return { rows, missed, top };
}

function summaryFields(summary, mode) {
    const missedLines = summary.missed.length
        ? summary.missed.map(row => playerLine(
            { ...row.identity, name: safeInline(row.identity.name, 30) },
            `${row.stats.missedAttacks} missed ${plural(row.stats.missedAttacks, 'attack')}`
        ))
        : ['No attacks missed. ✅'];
    const missedChunks = chunkLines(missedLines);
    const topLines = summary.top.length
        ? summary.top.map((row, index) => {
            const average = row.stats.countedAttacks > 0
                ? row.stats.totalDestruction / row.stats.countedAttacks
                : 0;
            const displayName = row.identity.discordId
                ? `{{wfu-user:${row.identity.discordId}}}`
                : safeInline(row.identity.name);
            return `${index + 1}. **${displayName}** — ${row.stats.starsTotal}⭐ · ${average.toFixed(0)}% avg`;
        }).join('\n')
        : 'No counted attacks.';
    return [
        ...missedChunks.map((value, index) => ({
            name: `${mode === 'cwl' ? 'Missed CWL attacks' : 'Missed attacks'}${missedChunks.length > 1 ? ` (${index + 1}/${missedChunks.length})` : ''}`,
            value
        })),
        { name: 'Top offense', value: topLines.slice(0, 1024) }
    ];
}

function planRegularWarSummaries(rosterData, config, record, nowIso) {
    if (config?.features?.regularWarSummaries !== true) return [];
    const enabledAt = workflow.parseMs(config.featureEnabledAt?.regularWarSummaries || config.enabledAt);
    const notifications = [];

    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        const history = roster?.warPerformance?.regularWarHistoryByKey && typeof roster.warPerformance.regularWarHistoryByKey === 'object'
            ? roster.warPerformance.regularWarHistoryByKey
            : {};
        for (const [historyKey, entry] of Object.entries(history)) {
            if (entry?.authoritative !== true) continue;
            const finalizedAt = workflow.parseMs(entry.finalizedAt || entry.lastUpdatedAt);
            if (!(finalizedAt > 0) || (enabledAt > 0 && finalizedAt < enabledAt)) continue;
            const key = regularSummaryKey(roster, historyKey, entry);
            if (record?.deliveries?.[key]) continue;

            const summary = summarizeStatsRows(entry.statsByTag, rosterData);
            const missedUserIds = unique(summary.missed.map(row => row.identity.discordId));
            notifications.push({
                key,
                kind: 'regular-war-summary',
                featureKey: 'regularWarSummaries',
                content: [staffMention(config), ...missedUserIds.map(id => `<@${id}>`)].filter(Boolean).join(' '),
                embeds: [{
                    color: summary.missed.length ? 0xf59e0b : 0x57f287,
                    title: `${rosterTitle(roster)} · regular war summary`,
                    description: `${summary.rows.length} tracked player${summary.rows.length === 1 ? '' : 's'} · ${summary.missed.reduce((sum, row) => sum + row.stats.missedAttacks, 0)} missed attacks`,
                    fields: summaryFields(summary, 'regular'),
                    timestamp: new Date(finalizedAt).toISOString()
                }],
                allowedUserIds: missedUserIds,
                allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : [],
                displayNameFallbacks: displayNameFallbacks(summary.rows.map(row => row.identity))
            });
        }
    }

    return notifications.sort((left, right) => toText(left.embeds?.[0]?.timestamp).localeCompare(toText(right.embeds?.[0]?.timestamp)));
}

function planCwlEndSummaries(rosterData, config, record, nowIso) {
    if (config?.features?.cwlEndSummaries !== true) return [];
    const enabledAt = workflow.parseMs(config.featureEnabledAt?.cwlEndSummaries || config.enabledAt);
    const notifications = [];

    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        const cwl = roster?.cwlStats && typeof roster.cwlStats === 'object' ? roster.cwlStats : null;
        if (!isCompletedCwlRoster(roster)) continue;
        const refreshedAt = workflow.parseMs(cwl.lastRefreshedAt || rosterData.lastUpdatedAt);
        if (enabledAt > 0 && refreshedAt < enabledAt) continue;

        const byTag = cwl.byTag && typeof cwl.byTag === 'object' ? cwl.byTag : {};
        const key = cwlEndSummaryKey(roster);
        if (record?.deliveries?.[key]) continue;

        const normalizedByTag = Object.fromEntries(Object.entries(byTag).map(([tag, stats]) => [tag, {
            ...stats,
            possibleAttacks: Number(stats?.resolvedWarDays || stats?.daysInLineup || 0),
            usedAttacks: Number(stats?.attacksMade || 0),
            attacksMissed: Number(stats?.missedAttacks || 0)
        }]));
        const summary = summarizeStatsRows(normalizedByTag, rosterData);
        const missedUserIds = unique(summary.missed.map(row => row.identity.discordId));
        const totalMisses = summary.missed.reduce((sum, row) => sum + row.stats.missedAttacks, 0);
        notifications.push({
            key,
            kind: 'cwl-end-summary',
            featureKey: 'cwlEndSummaries',
            content: [staffMention(config), ...missedUserIds.map(id => `<@${id}>`)].filter(Boolean).join(' '),
            embeds: [{
                color: totalMisses ? 0x9b59b6 : 0x57f287,
                title: `${rosterTitle(roster)} · CWL complete`,
                description: `Season ${safeInline(cwl.season)} · ${summary.rows.length} tracked player${summary.rows.length === 1 ? '' : 's'} · ${totalMisses} missed ${plural(totalMisses, 'attack')}`,
                fields: summaryFields(summary, 'cwl'),
                timestamp: nowIso
            }],
            allowedUserIds: missedUserIds,
            allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : [],
            displayNameFallbacks: displayNameFallbacks(summary.rows.map(row => row.identity))
        });
    }

    return notifications;
}

function zonedDateParts(now, timeZone) {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timeZone || 'Europe/Berlin',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        hourCycle: 'h23'
    });
    const parts = Object.fromEntries(formatter.formatToParts(now).map(part => [part.type, part.value]));
    return { dateKey: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

function planMissingDiscordDigest(work, config, record, now) {
    if (config?.features?.missingDiscordDigest !== true || work?.settings?.missingDiscordEnabled !== true) return null;
    const parts = zonedDateParts(now, config.timeZone);
    if (parts.hour < 9 || record?.observations?.lastMissingDiscordDigestDate === parts.dateKey) return null;

    const gaps = (Array.isArray(work?.directory?.players) ? work.directory.players : [])
        .filter(player => !player.discordId && !player.trusted)
        .sort((left, right) => toText(left.rosterTitle).localeCompare(toText(right.rosterTitle)) || toText(left.name).localeCompare(toText(right.name)));
    if (!gaps.length) return { noMessageDateKey: parts.dateKey };

    const lines = gaps.slice(0, MAX_NOTIFICATION_LINES).map(player =>
        `• **${safeInline(player.name)}** · \`${player.tag}\` · ${safeInline(player.rosterTitle || 'No roster')}`
    );
    if (gaps.length > lines.length) lines.push(`• +${gaps.length - lines.length} more; open Discord gaps for the full list.`);
    return {
        dateKey: parts.dateKey,
        notification: {
            key: `discord-gaps:${parts.dateKey}:${workflow.stableRevision(gaps.map(player => player.tag).join('|'))}`,
            kind: 'missing-discord-digest',
            featureKey: 'missingDiscordDigest',
            content: staffMention(config),
            embeds: [{
                color: 0x5865f2,
                title: 'Daily Discord-link gaps',
                description: lines.join('\n').slice(0, 4000),
                footer: { text: `${gaps.length} roster account${gaps.length === 1 ? '' : 's'} cannot receive automatic tags.` }
            }],
            allowedUserIds: [],
            allowedRoleIds: config.staffRoleId ? [config.staffRoleId] : []
        }
    };
}

function planNotifications({ rosterData, work, config, record, moderators = {}, nowRaw = new Date() }) {
    const now = nowRaw instanceof Date ? nowRaw : new Date(nowRaw);
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const notifications = [];
    notifications.push(...planModerationOwnershipNotifications(work, config, record, moderators, nowMs));
    const casePlan = planCaseAlerts(work, config, record, nowIso);
    if (casePlan.notification && !record?.deliveries?.[casePlan.notification.key]) {
        notifications.push(casePlan.notification);
    }

    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        if (config?.features?.attackReminders === true) {
            for (const mode of ['regular', 'cwl']) {
                const reminder = planAttackReminder({ roster, rosterData, config, record, nowMs, mode });
                if (reminder) notifications.push(reminder);
            }
        }
        const regularAllClear = planAllClear({ roster, config, record, mode: 'regular', nowIso });
        if (regularAllClear) notifications.push(regularAllClear);
        const cwlAllClear = planAllClear({ roster, config, record, mode: 'cwl', nowIso });
        if (cwlAllClear) notifications.push(cwlAllClear);
    }

    notifications.push(...planRegularWarSummaries(rosterData, config, record, nowIso));
    notifications.push(...planCwlEndSummaries(rosterData, config, record, nowIso));
    const missingDigest = planMissingDiscordDigest(work, config, record, now);
    if (missingDigest?.notification && !record?.deliveries?.[missingDigest.notification.key]) {
        notifications.push(missingDigest.notification);
    }

    return {
        notifications,
        caseObservations: casePlan.observations,
        caseAlertPlanned: Boolean(casePlan.notification),
        missingDiscordDigestDate: missingDigest?.dateKey || missingDigest?.noMessageDateKey || '',
        missingDiscordDigestKey: missingDigest?.notification?.key || ''
    };
}

module.exports = {
    REMINDER_THRESHOLDS,
    eligibleReminder,
    reminderKeys,
    buildCurrentCaseObservations,
    buildSummaryBaselineKeys,
    summarizeStatsRows,
    planModerationOwnershipNotifications,
    zonedDateParts,
    planNotifications
};
