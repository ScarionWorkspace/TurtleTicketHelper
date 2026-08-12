'use strict';

const crypto = require('node:crypto');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const workflow = require('./workflow');

const SCHEDULER_PRIVATE_CACHE_TTL_MS = 10 * 60 * 1000;
const INTERACTION_PUBLIC_CACHE_TTL_MS = 30 * 1000;
const INTERACTION_PRIVATE_CACHE_TTL_MS = 30 * 1000;
const INTERACTION_VIEW_CACHE_TTL_MS = 15 * 60 * 1000;
const INTERACTION_STALE_FALLBACK_MAX_AGE_MS = 15 * 60 * 1000;

let privateStateCache = null;
let privateStateCachedAt = 0;
let pendingPrivateStateRead = null;
let privateStateGeneration = 0;
let privateStateRequestSequence = 0;
let latestPrivateStateRequest = 0;
let latestWorkspace = null;
let latestWorkspaceCachedAt = 0;
let workspaceLoadSequence = 0;
let latestWorkspaceLoad = 0;

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function invalidatePrivateStateCache() {
    privateStateGeneration += 1;
    privateStateCache = null;
    privateStateCachedAt = 0;
    latestWorkspace = null;
    latestWorkspaceCachedAt = 0;
}

function stalePrivateStateFallback(error, options) {
    const cachedAgeMs = Date.now() - privateStateCachedAt;
    if (
        options.allowStaleOnError !== true ||
        !privateStateCache ||
        privateStateCachedAt <= 0 ||
        cachedAgeMs > (options.staleMaxAgeMs ?? INTERACTION_STALE_FALLBACK_MAX_AGE_MS)
    ) {
        throw error;
    }
    const fallback = clone(privateStateCache);
    Object.defineProperty(fallback, '__staleCache', {
        value: { cachedAt: privateStateCachedAt, cause: error },
        enumerable: false
    });
    return fallback;
}

async function readPrivateState(options = {}) {
    const cacheTtlMs = options.force === true
        ? 0
        : Math.max(0, Number(options.cacheTtlMs) || 0);

    if (privateStateCache && Date.now() - privateStateCachedAt < cacheTtlMs) {
        return clone(privateStateCache);
    }

    const generation = privateStateGeneration;
    if (
        options.force !== true &&
        pendingPrivateStateRead?.generation === generation
    ) {
        try {
            return clone(await pendingPrivateStateRead.promise);
        } catch (error) {
            return stalePrivateStateFallback(error, options);
        }
    }

    const requestId = ++privateStateRequestSequence;
    latestPrivateStateRequest = requestId;
    const pending = {
        generation,
        requestId,
        promise: null
    };
    pending.promise = rosterBackend.getWarFollowupState({
        timeoutMs: options.timeoutMs
    }).then(result => {
        const state = {
            schemaVersion: 3,
            settings: workflow.sanitizeSettings(result?.settings),
            cases: (Array.isArray(result?.cases) ? result.cases : [])
                .map(workflow.normalizeCase)
                .filter(Boolean)
        };
        if (
            privateStateGeneration === generation &&
            latestPrivateStateRequest === requestId
        ) {
            privateStateCache = state;
            privateStateCachedAt = Date.now();
        }
        return state;
    }).finally(() => {
        if (pendingPrivateStateRead === pending) pendingPrivateStateRead = null;
    });
    pendingPrivateStateRead = pending;

    try {
        return clone(await pending.promise);
    } catch (error) {
        return stalePrivateStateFallback(error, options);
    }
}

async function loadWorkspace(options = {}) {
    const scheduler = options.scheduler === true;
    const loadId = ++workspaceLoadSequence;
    latestWorkspaceLoad = loadId;
    const generation = privateStateGeneration;
    const [rosterData, privateState] = await Promise.all([
        rosterPublicData.readActiveRosterPayload({
            cacheTtlMs: options.publicCacheTtlMs ?? (scheduler ? 4 * 60 * 1000 : INTERACTION_PUBLIC_CACHE_TTL_MS),
            timeoutMs: options.publicTimeoutMs ?? 12_000
        }),
        readPrivateState({
            force: options.forcePrivate === true,
            allowStaleOnError: options.allowStalePrivateOnError === true,
            cacheTtlMs: options.privateCacheTtlMs ?? (
                scheduler ? SCHEDULER_PRIVATE_CACHE_TTL_MS : INTERACTION_PRIVATE_CACHE_TTL_MS
            ),
            timeoutMs: options.privateTimeoutMs ?? 45_000
        })
    ]);

    if (!rosterData || typeof rosterData !== 'object') {
        throw new Error('The published roster snapshot is unavailable. Try again after the next roster refresh.');
    }

    const workspace = {
        rosterData,
        privateState,
        freshness: privateState?.__staleCache
            ? {
                privateStateStale: true,
                privateStateCachedAt: privateState.__staleCache.cachedAt
            }
            : { privateStateStale: false },
        work: workflow.buildWorkItems(rosterData, privateState)
    };
    if (privateStateGeneration === generation && latestWorkspaceLoad === loadId) {
        latestWorkspace = workspace;
        latestWorkspaceCachedAt = Date.now();
    }
    return workspace;
}

function peekWorkspace(options = {}) {
    const maxAgeMs = Math.max(0, Number(options.maxAgeMs) || INTERACTION_VIEW_CACHE_TTL_MS);
    if (!latestWorkspace || Date.now() - latestWorkspaceCachedAt > maxAgeMs) return null;
    return latestWorkspace;
}

function getActorName(interaction) {
    const displayName = String(
        interaction?.member?.displayName ||
        interaction?.user?.globalName ||
        interaction?.user?.username ||
        'Discord staff'
    ).replace(/\s+/g, ' ').trim();
    return displayName.slice(0, 80);
}

function mutationId(seedRaw) {
    const seed = String(seedRaw || `${Date.now()}-${Math.random()}`);
    const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
    return `discord-wfu-${digest}`;
}

function mutationBase(itemRaw, actorRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const player = item.player && typeof item.player === 'object' ? item.player : {};
    const caseValue = item.case && typeof item.case === 'object' ? item.case : null;
    const actor = String(actorRaw || '').replace(/\s+/g, ' ').trim().slice(0, 80);

    return {
        tag: workflow.normalizeTag(item.tag || player.tag),
        name: String(player.name || caseValue?.name || '').trim(),
        discord: String(player.discord || caseValue?.discord || '').trim(),
        discordId: String(player.discordId || caseValue?.discordId || '').trim(),
        sourceRosterId: String(caseValue?.sourceRosterId || player.rosterId || '').trim(),
        sourceRosterTitle: String(caseValue?.sourceRosterTitle || player.rosterTitle || '').trim(),
        sourceClanTag: workflow.normalizeTag(caseValue?.sourceClanTag || player.clanTag),
        actor,
        handledBy: String(caseValue?.handledBy || '').trim(),
        signalIds: Array.isArray(item.signalIds) ? item.signalIds : [],
        expectedUpdatedAt: String(caseValue?.updatedAt || '').trim()
    };
}

async function mutateCase(item, action, patch = {}, options = {}) {
    const request = {
        ...mutationBase(item, options.actor),
        ...(patch && typeof patch === 'object' ? patch : {}),
        action,
        mutationId: options.mutationId || mutationId(options.seed || `${action}:${item?.tag}:${Date.now()}`)
    };
    const result = await rosterBackend.mutateWarFollowupCase(request);
    invalidatePrivateStateCache();
    return workflow.normalizeCase(result);
}

async function ensureManualCase(tagRaw, workspace, actorRaw, seedRaw) {
    const tag = workflow.normalizeTag(tagRaw);
    const existing = workspace?.work?.items?.find(item => item.tag === tag);
    if (existing) return existing;

    const player = workspace?.work?.directory?.byTag?.[tag] || {
        tag,
        name: tag,
        discord: '',
        discordId: '',
        rosterId: '',
        rosterTitle: '',
        clanTag: ''
    };
    const item = {
        tag,
        player,
        case: null,
        signalIds: [],
        signals: [],
        evidence: workflow.buildEvidenceForTag(
            workspace?.rosterData,
            tag,
            workspace?.privateState?.settings,
            player
        )
    };

    await mutateCase(item, 'manual_review', {
        reasonCodes: ['manual'],
        evidence: item.evidence,
        handledBy: ''
    }, {
        actor: actorRaw,
        seed: seedRaw
    });

    const refreshed = await loadWorkspace({ forcePrivate: true });
    return refreshed.work.items.find(candidate => candidate.tag === tag) || null;
}

async function setTrustedAccount(tagRaw, trusted, options = {}) {
    const tag = workflow.normalizeTag(tagRaw);
    const operationId = options.mutationId || mutationId(options.seed || `trust:${tag}:${trusted}:${Date.now()}`);

    try {
        const result = await rosterBackend.setWarFollowupTrustedAccount(tag, trusted === true, operationId);
        invalidatePrivateStateCache();
        return result;
    } catch (error) {
        try {
            const status = await rosterBackend.getWarFollowupTrustStatus(tag, operationId);
            if (status?.committed === true || status?.trusted === (trusted === true)) {
                invalidatePrivateStateCache();
                return status;
            }
        } catch {
            // The original mutation error is the useful one to surface.
        }
        throw error;
    }
}

async function recordPlayerResponse(item, responseText, responseMessageId, options = {}) {
    const request = {
        ...mutationBase(item, options.actor || 'Player DM'),
        action: 'player_response',
        responseText: String(responseText || '').trim(),
        responseMessageId: String(responseMessageId || '').trim(),
        mutationId: options.mutationId || mutationId(options.seed || `player-response:${item?.tag}:${responseMessageId}`)
    };
    const result = await rosterBackend.mutateWarFollowupCase(request, options);
    invalidatePrivateStateCache();
    return workflow.normalizeCase(result);
}

async function saveRules(settingsPatch, expectedRulesUpdatedAt, options = {}) {
    const operationId = options.mutationId || mutationId(options.seed || `rules:${Date.now()}`);

    try {
        const saved = await rosterBackend.saveWarFollowupSettings(
            settingsPatch,
            expectedRulesUpdatedAt || '',
            operationId
        );
        invalidatePrivateStateCache();
        return workflow.sanitizeSettings(saved);
    } catch (error) {
        try {
            const status = await rosterBackend.getWarFollowupRulesStatus(operationId);
            if (status?.committed === true && status.settings) {
                invalidatePrivateStateCache();
                return workflow.sanitizeSettings(status.settings);
            }
        } catch {
            // The original mutation error is the useful one to surface.
        }
        throw error;
    }
}

module.exports = {
    SCHEDULER_PRIVATE_CACHE_TTL_MS,
    INTERACTION_PRIVATE_CACHE_TTL_MS,
    INTERACTION_VIEW_CACHE_TTL_MS,
    INTERACTION_STALE_FALLBACK_MAX_AGE_MS,
    loadWorkspace,
    readPrivateState,
    peekWorkspace,
    invalidatePrivateStateCache,
    getActorName,
    mutationId,
    mutationBase,
    mutateCase,
    ensureManualCase,
    setTrustedAccount,
    recordPlayerResponse,
    saveRules
};
