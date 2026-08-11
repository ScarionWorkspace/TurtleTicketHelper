'use strict';

const { redactKnownSecrets } = require('../../config/env');
const { loadWorkspace } = require('./service');
const workflow = require('./workflow');
const { warFollowupStateStore } = require('./stateStore');
const { buildSummaryBaselineKeys, planNotifications } = require('./notificationPlanner');
const { synchronizeModerationCases } = require('./moderation');
const {
    ensureDashboard,
    ensureModerationHub,
    resolveConfiguredChannel,
    sendPlannedNotification,
    sendPlannedDirectNotification
} = require('./dashboard');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_TICK_PER_GUILD = 12;
const MODERATOR_DIGEST_INTERVAL_MS = 4 * 60 * 60 * 1000;
const LEADERSHIP_DIGEST_INTERVAL_MS = 6 * 60 * 60 * 1000;

const PERSONAL_MODERATION_KINDS = new Set(['case-assignment', 'case-inactivity-reminder']);
const LEADERSHIP_MODERATION_KINDS = new Set(['case-alert', 'case-unassigned', 'case-escalation']);
const WAR_REMINDER_KINDS = new Set(['regular-attack-reminder', 'cwl-attack-reminder']);
const WAR_UPDATE_KINDS = new Set([
    'regular-all-clear',
    'cwl-all-clear',
    'regular-war-summary',
    'cwl-end-summary'
]);

let schedulerTimer = null;
let schedulerRunning = false;

function logSchedulerError(label, error) {
    const detail = JSON.stringify({
        name: error?.name || null,
        message: error?.message || String(error),
        code: error?.code || null,
        status: error?.status || null
    });
    console.error(`${label}: ${redactKnownSecrets(detail)}`);
}

function unique(values) {
    return Array.from(new Set((Array.isArray(values) ? values : []).filter(Boolean)));
}

function deliveryKeys(notification) {
    return unique(
        (Array.isArray(notification?.consumeKeys) && notification.consumeKeys.length
            ? notification.consumeKeys
            : [notification?.key])
    );
}

function mergedMentions(notifications) {
    return unique((notifications || []).flatMap(notification =>
        String(notification?.content || '').match(/<@!?\d{17,20}>|<@&\d{17,20}>/g) || []
    )).join(' ');
}

function mergedFallbacks(notifications) {
    return Object.assign({}, ...(notifications || []).map(notification => notification?.displayNameFallbacks || {}));
}

function compactDigestLines(notifications) {
    const lines = [];
    for (const notification of notifications) {
        const embed = notification?.embeds?.[0] || {};
        if (notification.kind === 'case-alert') {
            const caseLines = String(embed.description || '').split(/\r?\n/).filter(Boolean);
            lines.push(...caseLines.slice(0, Math.max(0, 35 - lines.length)));
            continue;
        }
        const icon = notification.kind === 'case-escalation'
            ? '🚨'
            : (notification.kind === 'case-unassigned'
                ? '⚠️'
                : (notification.kind === 'case-inactivity-reminder' ? '⏰' : '📥'));
        const detail = String(embed.description || '')
            .split(/\r?\n/)
            .filter(Boolean)
            .slice(0, 2)
            .join(' · ')
            .slice(0, 320);
        lines.push(`${icon} ${detail || embed.title || 'Moderation update'}`);
        if (lines.length >= 35) break;
    }
    if (notifications.length > lines.length) {
        lines.push(`…and ${notifications.length - lines.length} more updates in the panel.`);
    }
    return lines;
}

function buildModerationDigest(notifications, groupKey, intervalMs, nowIso) {
    const personal = PERSONAL_MODERATION_KINDS.has(notifications[0]?.kind);
    const destination = notifications[0]?.destination || 'channel';
    const recipientUserId = personal ? String(notifications[0]?.recipientUserId || '') : '';
    const consumeKeys = unique(notifications.flatMap(deliveryKeys));
    return {
        key: `moderation-digest:${workflow.stableRevision(consumeKeys.slice().sort().join('|'))}:${destination}`,
        consumeKeys,
        kind: 'moderation-digest',
        sourceKinds: unique(notifications.map(notification => notification.kind)),
        containsCaseAlert: notifications.some(notification => notification.kind === 'case-alert'),
        destination,
        recipientUserId,
        cadenceKey: `notification-cadence:${groupKey}`,
        cadenceMs: intervalMs,
        content: mergedMentions(notifications),
        embeds: [{
            color: personal ? 0x5865f2 : 0xf59e0b,
            title: personal
                ? `Your moderation work · ${notifications.length} update${notifications.length === 1 ? '' : 's'}`
                : `Leadership moderation digest · ${notifications.length} update${notifications.length === 1 ? '' : 's'}`,
            description: compactDigestLines(notifications).join('\n').slice(0, 4000),
            footer: { text: 'The panel updates immediately; notifications are grouped to reduce pings.' },
            timestamp: nowIso
        }],
        allowedUserIds: unique(notifications.flatMap(notification => notification.allowedUserIds || [])),
        allowedRoleIds: unique(notifications.flatMap(notification => notification.allowedRoleIds || [])),
        displayNameFallbacks: mergedFallbacks(notifications)
    };
}

function buildEmbedBundles(notifications, kind) {
    if (!notifications.length) return [];
    const allUserIds = unique(notifications.flatMap(notification => notification.allowedUserIds || []));
    const allRoleIds = unique(notifications.flatMap(notification => notification.allowedRoleIds || []));
    const allMentions = mergedMentions(notifications);
    const bundles = [];
    for (let index = 0; index < notifications.length; index += 10) {
        const chunk = notifications.slice(index, index + 10);
        const consumeKeys = unique(chunk.flatMap(deliveryKeys));
        const first = index === 0;
        bundles.push({
            key: `${kind}:${workflow.stableRevision(consumeKeys.slice().sort().join('|'))}`,
            consumeKeys,
            kind,
            sourceKinds: unique(chunk.map(notification => notification.kind)),
            destination: 'channel',
            content: first ? allMentions : '',
            embeds: chunk.flatMap(notification => notification.embeds || []).slice(0, 10),
            allowedUserIds: first ? allUserIds : [],
            allowedRoleIds: first ? allRoleIds : [],
            displayNameFallbacks: mergedFallbacks(chunk)
        });
    }
    return bundles;
}

function cadenceIsReady(record, notification, nowMs) {
    if (!notification?.cadenceKey || !(notification.cadenceMs > 0)) return true;
    const lastAt = workflow.parseMs(record?.deliveries?.[notification.cadenceKey]?.at);
    return !(lastAt > 0 && nowMs - lastAt < notification.cadenceMs);
}

function prepareNotificationQueue(notificationsRaw, record, nowRaw = new Date()) {
    const now = nowRaw instanceof Date ? nowRaw : new Date(nowRaw);
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const personalGroups = new Map();
    const leadership = [];
    const reminders = [];
    const warUpdates = [];
    const passthrough = [];

    for (const notification of Array.isArray(notificationsRaw) ? notificationsRaw : []) {
        if (PERSONAL_MODERATION_KINDS.has(notification.kind)) {
            const key = `${notification.destination || 'channel'}:${notification.recipientUserId || 'unknown'}`;
            if (!personalGroups.has(key)) personalGroups.set(key, []);
            personalGroups.get(key).push(notification);
        } else if (LEADERSHIP_MODERATION_KINDS.has(notification.kind)) {
            leadership.push(notification);
        } else if (WAR_REMINDER_KINDS.has(notification.kind)) {
            reminders.push(notification);
        } else if (WAR_UPDATE_KINDS.has(notification.kind)) {
            warUpdates.push(notification);
        } else {
            passthrough.push(notification);
        }
    }

    const candidates = [...passthrough];
    for (const [key, notifications] of personalGroups) {
        candidates.push(buildModerationDigest(
            notifications,
            `moderator:${key}`,
            MODERATOR_DIGEST_INTERVAL_MS,
            nowIso
        ));
    }
    if (leadership.length) {
        candidates.push(buildModerationDigest(
            leadership,
            'leadership',
            LEADERSHIP_DIGEST_INTERVAL_MS,
            nowIso
        ));
    }
    candidates.push(...buildEmbedBundles(reminders, 'war-reminder-digest'));
    candidates.push(...buildEmbedBundles(warUpdates, 'war-update-digest'));

    const notifications = [];
    const deferred = [];
    for (const notification of candidates) {
        (cadenceIsReady(record, notification, nowMs) ? notifications : deferred).push(notification);
    }
    return {
        notifications,
        deferred,
        deferredCaseAlert: deferred.some(notification => notification.containsCaseAlert === true)
    };
}

function initializeSummaryBaselines(store, guildId, workspace, config) {
    let record = store.getGuild(guildId);
    for (const featureKey of ['regularWarSummaries', 'cwlEndSummaries']) {
        if (
            config?.features?.[featureKey] !== true ||
            record.observations?.summaryBaselinesInitialized?.[featureKey] === true
        ) {
            continue;
        }
        const keys = buildSummaryBaselineKeys(workspace.rosterData, featureKey);
        if (keys.length) {
            store.recordDeliveries(guildId, keys, { disposition: 'baseline' });
        }
        store.markSummaryBaselineInitialized(guildId, featureKey);
        record = store.getGuild(guildId);
    }
    return record;
}

async function processGuild(client, guildState, workspace, options = {}) {
    const store = options.store || warFollowupStateStore;
    const guildId = guildState.guildId;
    const config = store.getGuild(guildId).config;
    if (!config.enabled || !config.channelId) {
        return { guildId, skipped: true, reason: 'disabled-during-tick', planned: 0, sent: [] };
    }
    const channel = await resolveConfiguredChannel(client, guildId, config.channelId);
    const moderationSync = await synchronizeModerationCases(
        channel.guild,
        guildId,
        workspace,
        store,
        { now: options.now || new Date() }
    );
    const activeWorkspace = moderationSync.workspace;
    await ensureDashboard(client, guildId, activeWorkspace, config, { channel, store });
    const moderationHub = store.getGuild(guildId).moderationHub;
    if (moderationHub.channelId) {
        try {
            await ensureModerationHub(client, guildId, activeWorkspace, {
                store,
                now: options.now || new Date()
            });
        } catch (error) {
            // The optional moderation hub must never block assignments or
            // notifications in the operational War Follow Up channel.
            logSchedulerError(`Moderation Hub refresh failed for guild ${guildId}`, error);
        }
    }

    const currentRecord = initializeSummaryBaselines(store, guildId, activeWorkspace, config);
    const plan = planNotifications({
        rosterData: activeWorkspace.rosterData,
        work: activeWorkspace.work,
        config,
        record: currentRecord,
        moderators: currentRecord.moderators,
        nowRaw: options.now || new Date()
    });
    const prepared = prepareNotificationQueue(plan.notifications, currentRecord, options.now || new Date());
    const queued = prepared.notifications.slice(0, MAX_NOTIFICATIONS_PER_TICK_PER_GUILD);
    const queuedKeys = new Set(queued.map(notification => notification.key));
    let caseAlertFailed = prepared.deferredCaseAlert || prepared.notifications.some(notification =>
        notification.containsCaseAlert === true && !queuedKeys.has(notification.key)
    );
    let missingDigestFailed = false;
    let configurationChanged = false;
    const sent = [];

    for (const notification of queued) {
        const liveConfig = store.getGuild(guildId).config;
        if (
            !liveConfig.enabled ||
            liveConfig.channelId !== config.channelId ||
            liveConfig.updatedAt !== config.updatedAt
        ) {
            configurationChanged = true;
            break;
        }
        if (notification.featureKey && liveConfig.features?.[notification.featureKey] !== true) continue;
        if (store.hasDelivery(guildId, notification.key)) continue;
        let deliveryReserved = false;
        try {
            const ownershipNotification = [
                'case-assignment',
                'case-inactivity-reminder',
                'case-unassigned',
                'case-escalation',
                'moderation-digest'
            ].includes(notification.kind);
            if (notification.destination === 'dm' || ownershipNotification) {
                store.recordDeliveries(guildId, notification.key, {
                    disposition: notification.destination === 'dm' ? 'direct-dm-pending' : 'notification-pending'
                });
                deliveryReserved = true;
            }
            const message = notification.destination === 'dm'
                ? await sendPlannedDirectNotification(client, channel.guild, notification)
                : await sendPlannedNotification(channel, notification);
            if (deliveryReserved) store.removeDeliveries(guildId, notification.key);
            store.recordDeliveries(
                guildId,
                notification.consumeKeys?.length ? notification.consumeKeys : notification.key,
                { messageId: message?.id, disposition: 'sent' }
            );
            if (notification.cadenceKey) {
                store.recordDeliveries(guildId, notification.cadenceKey, {
                    messageId: message?.id,
                    disposition: 'cadence',
                    at: options.now || new Date()
                });
            }
            sent.push(notification.key);
        } catch (error) {
            if (deliveryReserved) {
                try {
                    store.removeDeliveries(guildId, notification.key);
                } catch (releaseError) {
                    logSchedulerError(`War Follow Up notification reservation could not be released for guild ${guildId}`, releaseError);
                }
            }
            if (notification.kind === 'case-alert' || notification.containsCaseAlert === true) caseAlertFailed = true;
            if (notification.kind === 'missing-discord-digest') missingDigestFailed = true;
            logSchedulerError(`War Follow Up notification failed for guild ${guildId}`, error);
        }
    }

    if (!caseAlertFailed && !configurationChanged) {
        store.replaceCaseObservations(guildId, plan.caseObservations, options.now || new Date());
    }
    const missingDigestCommitted = !plan.missingDiscordDigestKey ||
        store.hasDelivery(guildId, plan.missingDiscordDigestKey);
    if (plan.missingDiscordDigestDate && !missingDigestFailed && !configurationChanged && missingDigestCommitted) {
        store.setLastMissingDiscordDigestDate(guildId, plan.missingDiscordDigestDate);
    }

    return {
        guildId,
        planned: queued.length,
        deferred: prepared.deferred.length,
        sent,
        moderationMutations: moderationSync.mutations
    };
}

async function runWarFollowupTick(client, options = {}) {
    if (schedulerRunning && options.allowOverlap !== true) return { skipped: true, reason: 'already-running' };
    schedulerRunning = true;
    try {
        const store = options.store || warFollowupStateStore;
        const guilds = store.listEnabledGuilds();
        if (!guilds.length) return { skipped: true, reason: 'no-enabled-guilds' };

        const workspace = options.workspace || await loadWorkspace({ scheduler: true });
        const results = [];
        for (const guildState of guilds) {
            try {
                results.push(await processGuild(client, guildState, workspace, { ...options, store }));
            } catch (error) {
                logSchedulerError(`War Follow Up tick failed for guild ${guildState.guildId}`, error);
                results.push({ guildId: guildState.guildId, error: error?.message || String(error) });
            }
        }
        return { skipped: false, results };
    } finally {
        schedulerRunning = false;
    }
}

function startWarFollowupScheduler(client, options = {}) {
    if (schedulerTimer) return schedulerTimer;
    const intervalMs = Math.max(60_000, Number(options.intervalMs) || POLL_INTERVAL_MS);
    schedulerTimer = setInterval(() => {
        runWarFollowupTick(client).catch(error => logSchedulerError('War Follow Up scheduler failed', error));
    }, intervalMs);
    schedulerTimer.unref?.();

    setImmediate(() => {
        runWarFollowupTick(client).catch(error => logSchedulerError('Initial War Follow Up tick failed', error));
    });
    return schedulerTimer;
}

function stopWarFollowupScheduler() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
}

module.exports = {
    POLL_INTERVAL_MS,
    MAX_NOTIFICATIONS_PER_TICK_PER_GUILD,
    MODERATOR_DIGEST_INTERVAL_MS,
    LEADERSHIP_DIGEST_INTERVAL_MS,
    prepareNotificationQueue,
    initializeSummaryBaselines,
    processGuild,
    runWarFollowupTick,
    startWarFollowupScheduler,
    stopWarFollowupScheduler
};
