'use strict';

const rosterBackend = require('../rosterBackend/rosterBackendClient');
const workflow = require('./workflow');
const { warFollowupStateStore } = require('./stateStore');

const MAX_MUTATIONS_PER_TICK = 4;
const OUTBOX_REQUEST_TIMEOUT_MS = 12_000;
const MANUAL_RETRY_MIN_INTERVAL_MS = 30_000;
const RETRY_DELAYS_MS = Object.freeze([
    60 * 1000,
    5 * 60 * 1000,
    15 * 60 * 1000,
    60 * 60 * 1000,
    4 * 60 * 60 * 1000,
    12 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000
]);
const inFlight = new Map();

function text(value) {
    return value == null ? '' : String(value);
}

function errorDetails(error) {
    return {
        code: text(error?.code).trim().slice(0, 80),
        status: error?.status != null && Number.isFinite(Number(error.status)) ? Number(error.status) : null,
        message: text(error?.message || error || 'Unknown backend error').replace(/\s+/g, ' ').trim().slice(0, 1000)
    };
}

function isTransientBackendFailure(error) {
    const code = text(error?.code).trim().toUpperCase();
    const status = error?.status != null ? Number(error.status) : Number.NaN;
    const message = text(error?.message).toLowerCase();
    if (['BACKEND_AUTHORIZATION_REQUIRED', 'ROSTER_BACKEND_CONFIG_MISSING', 'UNSAFE_REDIRECT', 'BACKEND_NOT_OK'].includes(code)) {
        return code === 'BACKEND_NOT_OK' && /temporar|timed? out|quota|rate limit|too many times|service unavailable|try again/.test(message);
    }
    if (['TIMEOUT', 'REQUEST_FAILED', 'APPS_SCRIPT_RESULT_UNAVAILABLE'].includes(code)) return true;
    if (code === 'INVALID_JSON') return !Number.isFinite(status) || status === 408 || status === 425 || status === 429 || status >= 500;
    if (code === 'HTTP_ERROR') return status === 408 || status === 425 || status === 429 || status >= 500;
    if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
    if (/temporar|timed? out|quota|rate limit|too many times|service unavailable|try again/.test(message)) return true;
    // Non-client errors are treated conservatively as retryable. The exact
    // mutation ID and expected version make an ambiguous replay idempotent.
    return !code && !Number.isFinite(status);
}

async function reconcileCommittedMutation(record, options = {}) {
    try {
        const current = await rosterBackend.getWarFollowupCase(record.tag, {
            maxAttempts: 1,
            timeoutMs: options.timeoutMs ?? OUTBOX_REQUEST_TIMEOUT_MS
        });
        const committed = Array.isArray(current?.mutationLedger) && current.mutationLedger.some(entry =>
            text(entry?.mutationId).trim() === record.id && text(entry?.action).trim() === record.action
        );
        return committed ? workflow.normalizeCase(current) : null;
    } catch {
        return null;
    }
}

function isConcurrencyConflict(error) {
    const message = text(error?.message).toLowerCase();
    return message.includes('changed since it was opened') ||
        message.includes('mutation id was already used') ||
        message.includes('no longer waiting') ||
        message.includes('no longer ready');
}

function retryDelay(attemptsRaw) {
    const attempts = Math.max(1, Number(attemptsRaw) || 1);
    return RETRY_DELAYS_MS[Math.min(RETRY_DELAYS_MS.length - 1, attempts - 1)];
}

function isDue(record, nowMs) {
    if (record?.state !== 'pending') return false;
    const nextMs = new Date(text(record.nextAttemptAt)).getTime();
    return !Number.isFinite(nextMs) || nextMs <= nowMs;
}

function recordCommittedSideEffects(store, guildId, record, result) {
    if (record?.action === 'assign_owner' && /^\d{17,20}$/.test(text(record.request?.assignedModeratorId).trim())) {
        store.recordModeratorAssignment(
            guildId,
            record.request.assignedModeratorId,
            result?.assignedAt || new Date()
        );
    }
}

async function executeMutation(guildId, mutationId, options = {}) {
    const store = options.store || warFollowupStateStore;
    const existing = store.getMutation(guildId, mutationId);
    if (!existing || existing.state !== 'pending') return { record: existing, result: null, attempted: false };

    const key = `${guildId}:${mutationId}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const lastAttemptMs = new Date(text(existing.lastAttemptAt)).getTime();
    if (options.force === true && Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < MANUAL_RETRY_MIN_INTERVAL_MS) {
        return { record: existing, result: null, attempted: false };
    }
    if (options.force !== true && !isDue(existing, nowMs)) {
        return { record: existing, result: null, attempted: false };
    }

    const operation = (async () => {
        const attempts = existing.attempts + 1;
        store.patchMutation(guildId, mutationId, {
            attempts,
            lastAttemptAt: new Date(nowMs).toISOString(),
            nextAttemptAt: '',
            lastError: {}
        }, new Date(nowMs));
        try {
            const result = await rosterBackend.mutateWarFollowupCase(existing.request, {
                maxAttempts: 1,
                timeoutMs: options.timeoutMs ?? OUTBOX_REQUEST_TIMEOUT_MS
            });
            const committedAt = new Date().toISOString();
            const record = store.patchMutation(guildId, mutationId, {
                state: 'committed',
                committedAt,
                nextAttemptAt: '',
                lastError: {}
            });
            recordCommittedSideEffects(store, guildId, existing, result);
            return {
                record,
                result: workflow.normalizeCase(result),
                attempted: true
            };
        } catch (error) {
            const reconciled = await reconcileCommittedMutation(existing, options);
            if (reconciled) {
                const committedAt = new Date().toISOString();
                const record = store.patchMutation(guildId, mutationId, {
                    state: 'committed',
                    committedAt,
                    nextAttemptAt: '',
                    lastError: {}
                });
                recordCommittedSideEffects(store, guildId, existing, reconciled);
                return { record, result: reconciled, attempted: true, reconciled: true };
            }
            const conflict = isConcurrencyConflict(error);
            const transient = !conflict && isTransientBackendFailure(error);
            const state = transient ? 'pending' : (conflict ? 'conflict' : 'failed');
            const nextAttemptAt = transient
                ? new Date(nowMs + retryDelay(attempts)).toISOString()
                : '';
            const record = store.patchMutation(guildId, mutationId, {
                state,
                nextAttemptAt,
                lastError: errorDetails(error)
            });
            return { record, result: null, attempted: true, error };
        }
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, operation);
    return operation;
}

async function processPendingMutations(options = {}) {
    const store = options.store || warFollowupStateStore;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const limit = Math.max(1, Number(options.limit) || MAX_MUTATIONS_PER_TICK);
    const candidates = store.listGuildIdsWithMutations({ states: ['pending'] })
        .flatMap(guildId => store.listMutations(guildId, { states: ['pending'] })
            .filter(record => isDue(record, nowMs))
            .map(record => ({ guildId, record })))
        .sort((left, right) => left.record.createdAt.localeCompare(right.record.createdAt))
        .slice(0, limit);
    const results = [];
    for (const candidate of candidates) {
        results.push({
            guildId: candidate.guildId,
            mutationId: candidate.record.id,
            ...(await executeMutation(candidate.guildId, candidate.record.id, {
                store,
                now,
                timeoutMs: options.timeoutMs
            }))
        });
    }
    for (const guildId of store.listGuildIdsWithMutations()) {
        store.pruneCommittedMutations(guildId, now);
    }
    return results;
}

module.exports = {
    MAX_MUTATIONS_PER_TICK,
    OUTBOX_REQUEST_TIMEOUT_MS,
    MANUAL_RETRY_MIN_INTERVAL_MS,
    RETRY_DELAYS_MS,
    errorDetails,
    isTransientBackendFailure,
    reconcileCommittedMutation,
    isConcurrencyConflict,
    retryDelay,
    isDue,
    recordCommittedSideEffects,
    executeMutation,
    processPendingMutations
};
