'use strict';

const { redactKnownSecrets } = require('../../config/env');
const { loadWorkspace } = require('./service');
const { warFollowupStateStore } = require('./stateStore');
const { buildSummaryBaselineKeys, planNotifications } = require('./notificationPlanner');
const {
    ensureDashboard,
    resolveConfiguredChannel,
    sendPlannedNotification
} = require('./dashboard');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_NOTIFICATIONS_PER_TICK_PER_GUILD = 12;

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
    await ensureDashboard(client, guildId, workspace, config, { channel, store });

    const currentRecord = initializeSummaryBaselines(store, guildId, workspace, config);
    const plan = planNotifications({
        rosterData: workspace.rosterData,
        work: workspace.work,
        config,
        record: currentRecord,
        nowRaw: options.now || new Date()
    });
    const queued = plan.notifications.slice(0, MAX_NOTIFICATIONS_PER_TICK_PER_GUILD);
    let caseAlertFailed = false;
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
        try {
            const message = await sendPlannedNotification(channel, notification);
            store.recordDeliveries(
                guildId,
                notification.consumeKeys?.length ? notification.consumeKeys : notification.key,
                { messageId: message?.id, disposition: 'sent' }
            );
            sent.push(notification.key);
        } catch (error) {
            if (notification.kind === 'case-alert') caseAlertFailed = true;
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

    return { guildId, planned: queued.length, sent };
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
    initializeSummaryBaselines,
    processGuild,
    runWarFollowupTick,
    startWarFollowupScheduler,
    stopWarFollowupScheduler
};
