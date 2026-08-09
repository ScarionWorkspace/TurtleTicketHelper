'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = 3;
const MAX_DELIVERIES_PER_GUILD = 2500;
const MAX_CASE_OBSERVATIONS_PER_GUILD = 1500;
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;
const MODERATOR_NOTIFICATION_MODES = Object.freeze(['dm', 'channel', 'both']);
const FEATURE_KEYS = Object.freeze([
    'caseAlerts',
    'attackReminders',
    'regularWarSummaries',
    'cwlDailyUpdates',
    'cwlEndSummaries',
    'missingDiscordDigest',
    'directMessages'
]);
const SUMMARY_FEATURE_KEYS = Object.freeze([
    'regularWarSummaries',
    'cwlEndSummaries'
]);

function defaultFeatures() {
    return Object.fromEntries(FEATURE_KEYS.map(key => [key, false]));
}

function createDefaultConfig() {
    return {
        enabled: false,
        channelId: '',
        staffRoleId: '',
        timeZone: 'Europe/Berlin',
        features: defaultFeatures(),
        featureEnabledAt: {},
        configuredAt: '',
        enabledAt: '',
        updatedAt: ''
    };
}

function createDefaultGuildRecord() {
    return {
        config: createDefaultConfig(),
        dashboard: {
            channelId: '',
            messageId: '',
            semanticHash: '',
            updatedAt: ''
        },
        moderationHub: {
            channelId: '',
            messageId: '',
            semanticHash: '',
            updatedAt: ''
        },
        deliveries: {},
        moderators: {},
        observations: {
            caseFingerprints: {},
            casesInitializedAt: '',
            lastMissingDiscordDigestDate: '',
            summaryBaselinesInitialized: Object.fromEntries(SUMMARY_FEATURE_KEYS.map(key => [key, false]))
        }
    };
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function cleanText(value, maxLength = 240) {
    return String(value == null ? '' : value)
        .replace(/[\u0000-\u001F\u007F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLength);
}

function cleanSnowflake(value) {
    const text = cleanText(value, 20);
    return SNOWFLAKE_PATTERN.test(text) ? text : '';
}

function cleanTimestamp(value) {
    const ms = new Date(String(value || '')).getTime();
    return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
}

function cleanClanTag(value) {
    const compact = cleanText(value, 24).toUpperCase().replace(/\s+/g, '').replace(/O/g, '0');
    if (!compact) return '';
    return compact.startsWith('#') ? compact : `#${compact}`;
}

function sanitizeModerators(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const moderators = {};
    for (const [rawDiscordId, rawPreference] of Object.entries(value)) {
        const discordId = cleanSnowflake(rawDiscordId || rawPreference?.discordId);
        if (!discordId) continue;
        const preference = rawPreference && typeof rawPreference === 'object' ? rawPreference : {};
        const notificationMode = cleanText(preference.notificationMode, 20).toLowerCase();
        moderators[discordId] = {
            discordId,
            displayName: cleanText(preference.displayName, 80),
            clanTags: Array.from(new Set(
                (Array.isArray(preference.clanTags) ? preference.clanTags : [])
                    .map(cleanClanTag)
                    .filter(Boolean)
            )).sort().slice(0, 25),
            notificationMode: MODERATOR_NOTIFICATION_MODES.includes(notificationMode) ? notificationMode : 'channel',
            accepting: preference.accepting === true,
            updatedAt: cleanTimestamp(preference.updatedAt),
            lastAssignedAt: cleanTimestamp(preference.lastAssignedAt)
        };
    }
    return moderators;
}

function sanitizeFeatures(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return Object.fromEntries(FEATURE_KEYS.map(key => [key, value[key] === true]));
}

function sanitizeConfig(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const featureEnabledAtRaw = value.featureEnabledAt && typeof value.featureEnabledAt === 'object'
        ? value.featureEnabledAt
        : {};
    const featureEnabledAt = {};

    for (const key of FEATURE_KEYS) {
        const timestamp = cleanTimestamp(featureEnabledAtRaw[key]);
        if (timestamp) featureEnabledAt[key] = timestamp;
    }

    return {
        enabled: value.enabled === true,
        channelId: cleanSnowflake(value.channelId),
        staffRoleId: cleanSnowflake(value.staffRoleId),
        timeZone: cleanText(value.timeZone, 80) || 'Europe/Berlin',
        features: sanitizeFeatures(value.features),
        featureEnabledAt,
        configuredAt: cleanTimestamp(value.configuredAt),
        enabledAt: cleanTimestamp(value.enabledAt),
        updatedAt: cleanTimestamp(value.updatedAt)
    };
}

function sanitizeDeliveries(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const entries = [];

    for (const [rawKey, rawEntry] of Object.entries(value)) {
        const key = cleanText(rawKey, 300);
        const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
        const at = cleanTimestamp(entry.at);
        if (!key || !at) continue;
        entries.push([key, {
            at,
            messageId: cleanSnowflake(entry.messageId),
            disposition: cleanText(entry.disposition, 40) || 'sent'
        }]);
    }

    entries.sort((left, right) => left[1].at.localeCompare(right[1].at));
    return Object.fromEntries(entries.slice(-MAX_DELIVERIES_PER_GUILD));
}

function sanitizeCaseFingerprints(raw) {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const entries = Object.entries(value)
        .map(([tagRaw, entryRaw]) => {
            const tag = cleanText(tagRaw, 24).toUpperCase();
            const entry = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
            const fingerprint = cleanText(entry.fingerprint, 120);
            if (!tag || !fingerprint) return null;
            return [tag, {
                fingerprint,
                status: cleanText(entry.status, 40),
                observedAt: cleanTimestamp(entry.observedAt)
            }];
        })
        .filter(Boolean)
        .sort((left, right) => left[0].localeCompare(right[0]))
        .slice(0, MAX_CASE_OBSERVATIONS_PER_GUILD);
    return Object.fromEntries(entries);
}

function sanitizeGuildRecord(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const dashboard = value.dashboard && typeof value.dashboard === 'object' ? value.dashboard : {};
    const moderationHub = value.moderationHub && typeof value.moderationHub === 'object' ? value.moderationHub : {};
    const observations = value.observations && typeof value.observations === 'object' ? value.observations : {};
    const summaryBaselinesRaw = observations.summaryBaselinesInitialized && typeof observations.summaryBaselinesInitialized === 'object'
        ? observations.summaryBaselinesInitialized
        : {};

    return {
        config: sanitizeConfig(value.config),
        dashboard: {
            channelId: cleanSnowflake(dashboard.channelId),
            messageId: cleanSnowflake(dashboard.messageId),
            semanticHash: cleanText(dashboard.semanticHash, 160),
            updatedAt: cleanTimestamp(dashboard.updatedAt)
        },
        moderationHub: {
            channelId: cleanSnowflake(moderationHub.channelId),
            messageId: cleanSnowflake(moderationHub.messageId),
            semanticHash: cleanText(moderationHub.semanticHash, 160),
            updatedAt: cleanTimestamp(moderationHub.updatedAt)
        },
        deliveries: sanitizeDeliveries(value.deliveries),
        moderators: sanitizeModerators(value.moderators),
        observations: {
            caseFingerprints: sanitizeCaseFingerprints(observations.caseFingerprints),
            casesInitializedAt: cleanTimestamp(observations.casesInitializedAt),
            lastMissingDiscordDigestDate: /^\d{4}-\d{2}-\d{2}$/.test(String(observations.lastMissingDiscordDigestDate || ''))
                ? observations.lastMissingDiscordDigestDate
                : '',
            summaryBaselinesInitialized: Object.fromEntries(
                SUMMARY_FEATURE_KEYS.map(key => [key, summaryBaselinesRaw[key] === true])
            )
        }
    };
}

function sanitizeRoot(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    const guildsRaw = value.guilds && typeof value.guilds === 'object' ? value.guilds : {};
    const guilds = {};

    for (const [rawGuildId, rawGuild] of Object.entries(guildsRaw)) {
        const guildId = cleanSnowflake(rawGuildId);
        if (!guildId) continue;
        guilds[guildId] = sanitizeGuildRecord(rawGuild);
    }

    return { schemaVersion: SCHEMA_VERSION, guilds };
}

function resolveDefaultStatePath() {
    const configured = String(process.env.WAR_FOLLOWUP_STATE_PATH || '').trim();
    return configured
        ? path.resolve(configured)
        : path.resolve(__dirname, '..', '..', '..', 'data', 'war-followup-state.json');
}

function createWarFollowupStateStore(options = {}) {
    const filePath = path.resolve(options.filePath || resolveDefaultStatePath());
    let state = null;

    function load() {
        if (state) return state;

        if (!fs.existsSync(filePath)) {
            state = sanitizeRoot(null);
            return state;
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            state = sanitizeRoot(parsed);
            return state;
        } catch (error) {
            const backupPath = `${filePath}.corrupt-${Date.now()}`;
            try {
                fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
            } catch {
                // Preserve the original path even when a backup cannot be made.
            }
            throw new Error(`War follow-up state is unreadable at ${filePath}: ${error.message}`);
        }
    }

    function save() {
        const current = sanitizeRoot(load());
        const directory = path.dirname(filePath);
        const temporaryPath = path.join(
            directory,
            `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
        );
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(temporaryPath, `${JSON.stringify(current, null, 2)}\n`, {
            encoding: 'utf8',
            flag: 'wx'
        });
        fs.renameSync(temporaryPath, filePath);
        state = current;
    }

    function ensureGuild(guildIdRaw) {
        const guildId = cleanSnowflake(guildIdRaw);
        if (!guildId) throw new Error('A valid Discord guild ID is required.');
        const root = load();
        if (!root.guilds[guildId]) root.guilds[guildId] = createDefaultGuildRecord();
        root.guilds[guildId] = sanitizeGuildRecord(root.guilds[guildId]);
        return { guildId, record: root.guilds[guildId] };
    }

    function getGuild(guildIdRaw) {
        const guildId = cleanSnowflake(guildIdRaw);
        const record = guildId ? load().guilds[guildId] : null;
        return clone(record ? sanitizeGuildRecord(record) : createDefaultGuildRecord());
    }

    function listEnabledGuilds() {
        return Object.entries(load().guilds)
            .filter(([, record]) => record?.config?.enabled === true && record.config.channelId)
            .map(([guildId, record]) => ({ guildId, ...clone(sanitizeGuildRecord(record)) }));
    }

    function patchConfig(guildIdRaw, patchRaw = {}, nowRaw = new Date()) {
        const { record } = ensureGuild(guildIdRaw);
        const current = sanitizeConfig(record.config);
        const patch = patchRaw && typeof patchRaw === 'object' ? patchRaw : {};
        const now = nowRaw instanceof Date ? nowRaw : new Date(nowRaw);
        const nowIso = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
        const next = sanitizeConfig({
            ...current,
            ...patch,
            features: {
                ...current.features,
                ...(patch.features && typeof patch.features === 'object' ? patch.features : {})
            },
            featureEnabledAt: { ...current.featureEnabledAt }
        });

        if (!current.configuredAt) next.configuredAt = nowIso;
        if (!current.enabled && next.enabled) {
            next.enabledAt = nowIso;
            for (const key of FEATURE_KEYS) {
                if (next.features[key]) next.featureEnabledAt[key] = nowIso;
            }
            // Re-enabling starts from a clean observation baseline. It must not
            // replay a disabled period as a burst of moderation alerts.
            record.observations.caseFingerprints = {};
            record.observations.casesInitializedAt = '';
            record.observations.lastMissingDiscordDigestDate = '';
            record.observations.summaryBaselinesInitialized = Object.fromEntries(
                SUMMARY_FEATURE_KEYS.map(key => [key, false])
            );
        }
        for (const key of FEATURE_KEYS) {
            if (!current.features[key] && next.features[key]) {
                next.featureEnabledAt[key] = nowIso;
                if (SUMMARY_FEATURE_KEYS.includes(key)) {
                    record.observations.summaryBaselinesInitialized[key] = false;
                }
            }
        }
        next.updatedAt = nowIso;
        record.config = next;
        save();
        return clone(next);
    }

    function setDashboard(guildIdRaw, dashboardRaw = {}) {
        const { record } = ensureGuild(guildIdRaw);
        record.dashboard = {
            ...record.dashboard,
            ...dashboardRaw,
            updatedAt: dashboardRaw.updatedAt || new Date().toISOString()
        };
        save();
        return clone(sanitizeGuildRecord(record).dashboard);
    }

    function setModerationHub(guildIdRaw, hubRaw = {}) {
        const { record } = ensureGuild(guildIdRaw);
        record.moderationHub = {
            ...record.moderationHub,
            ...hubRaw,
            updatedAt: hubRaw.updatedAt || new Date().toISOString()
        };
        save();
        return clone(sanitizeGuildRecord(record).moderationHub);
    }

    function hasDelivery(guildIdRaw, keyRaw) {
        const key = cleanText(keyRaw, 300);
        const record = getGuild(guildIdRaw);
        return Boolean(key && record.deliveries[key]);
    }

    function recordDeliveries(guildIdRaw, keysRaw, detailsRaw = {}) {
        const { record } = ensureGuild(guildIdRaw);
        const keys = Array.from(new Set(
            (Array.isArray(keysRaw) ? keysRaw : [keysRaw])
                .map(key => cleanText(key, 300))
                .filter(Boolean)
        ));
        const at = cleanTimestamp(detailsRaw.at) || new Date().toISOString();
        for (const key of keys) {
            record.deliveries[key] = {
                at,
                messageId: cleanSnowflake(detailsRaw.messageId),
                disposition: cleanText(detailsRaw.disposition, 40) || 'sent'
            };
        }
        record.deliveries = sanitizeDeliveries(record.deliveries);
        save();
    }

    function upsertModerator(guildIdRaw, discordIdRaw, patchRaw = {}, nowRaw = new Date()) {
        const { record } = ensureGuild(guildIdRaw);
        const discordId = cleanSnowflake(discordIdRaw);
        if (!discordId) throw new Error('A valid Discord moderator ID is required.');
        const current = record.moderators?.[discordId] || { discordId };
        const patch = patchRaw && typeof patchRaw === 'object' ? patchRaw : {};
        const now = nowRaw instanceof Date ? nowRaw : new Date(nowRaw);
        const updatedAt = Number.isFinite(now.getTime()) ? now.toISOString() : new Date().toISOString();
        record.moderators = sanitizeModerators({
            ...record.moderators,
            [discordId]: {
                ...current,
                ...patch,
                discordId,
                updatedAt,
                lastAssignedAt: Object.prototype.hasOwnProperty.call(patch, 'lastAssignedAt')
                    ? patch.lastAssignedAt
                    : current.lastAssignedAt
            }
        });
        save();
        return clone(record.moderators[discordId]);
    }

    function recordModeratorAssignment(guildIdRaw, discordIdRaw, assignedAtRaw = new Date()) {
        const discordId = cleanSnowflake(discordIdRaw);
        if (!discordId) return null;
        const assignedAt = assignedAtRaw instanceof Date
            ? assignedAtRaw.toISOString()
            : (cleanTimestamp(assignedAtRaw) || new Date().toISOString());
        return upsertModerator(guildIdRaw, discordId, { lastAssignedAt: assignedAt }, assignedAt);
    }

    function removeDeliveries(guildIdRaw, keysRaw) {
        const { record } = ensureGuild(guildIdRaw);
        const keys = Array.from(new Set(
            (Array.isArray(keysRaw) ? keysRaw : [keysRaw])
                .map(key => cleanText(key, 300))
                .filter(Boolean)
        ));
        let changed = false;
        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(record.deliveries, key)) continue;
            delete record.deliveries[key];
            changed = true;
        }
        if (changed) save();
        return changed;
    }

    function replaceCaseObservations(guildIdRaw, observationsRaw, initializedAtRaw = new Date()) {
        const { record } = ensureGuild(guildIdRaw);
        const initializedAt = initializedAtRaw instanceof Date
            ? initializedAtRaw.toISOString()
            : (cleanTimestamp(initializedAtRaw) || new Date().toISOString());
        const nextFingerprints = sanitizeCaseFingerprints(observationsRaw);
        const alreadyInitialized = Boolean(record.observations.casesInitializedAt);
        if (
            alreadyInitialized &&
            JSON.stringify(record.observations.caseFingerprints) === JSON.stringify(nextFingerprints)
        ) {
            return clone(record.observations);
        }
        record.observations.caseFingerprints = nextFingerprints;
        if (!record.observations.casesInitializedAt) {
            record.observations.casesInitializedAt = initializedAt;
        }
        save();
        return clone(record.observations);
    }

    function setLastMissingDiscordDigestDate(guildIdRaw, dateKeyRaw) {
        const dateKey = String(dateKeyRaw || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
            throw new Error('A valid digest date is required.');
        }
        const { record } = ensureGuild(guildIdRaw);
        if (record.observations.lastMissingDiscordDigestDate === dateKey) return;
        record.observations.lastMissingDiscordDigestDate = dateKey;
        save();
    }

    function markSummaryBaselineInitialized(guildIdRaw, featureKeyRaw) {
        const featureKey = cleanText(featureKeyRaw, 80);
        if (!SUMMARY_FEATURE_KEYS.includes(featureKey)) {
            throw new Error('A valid summary feature key is required.');
        }
        const { record } = ensureGuild(guildIdRaw);
        if (record.observations.summaryBaselinesInitialized[featureKey] === true) return;
        record.observations.summaryBaselinesInitialized[featureKey] = true;
        save();
    }

    function resetForTests() {
        state = null;
    }

    return {
        filePath,
        getGuild,
        listEnabledGuilds,
        patchConfig,
        setDashboard,
        setModerationHub,
        hasDelivery,
        recordDeliveries,
        upsertModerator,
        recordModeratorAssignment,
        removeDeliveries,
        replaceCaseObservations,
        setLastMissingDiscordDigestDate,
        markSummaryBaselineInitialized,
        resetForTests
    };
}

const warFollowupStateStore = createWarFollowupStateStore();

module.exports = {
    SCHEMA_VERSION,
    FEATURE_KEYS,
    SUMMARY_FEATURE_KEYS,
    MAX_DELIVERIES_PER_GUILD,
    MODERATOR_NOTIFICATION_MODES,
    createDefaultConfig,
    createDefaultGuildRecord,
    sanitizeConfig,
    sanitizeModerators,
    sanitizeGuildRecord,
    createWarFollowupStateStore,
    warFollowupStateStore
};
