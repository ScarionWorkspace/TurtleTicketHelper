'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, test } = require('node:test');
const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const { createWarFollowupStateStore } = require('../src/features/warFollowup/stateStore');
const {
    executeMutation,
    isTransientBackendFailure,
    processPendingMutations
} = require('../src/features/warFollowup/mutationOutbox');

const temporaryDirectories = [];
const GUILD_ID = '111111111111111111';
const MUTATION_ID = 'discord-wfu-outbox-test';

afterEach(() => {
    while (temporaryDirectories.length) {
        fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    }
});

function createStore() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'war-followup-outbox-'));
    temporaryDirectories.push(directory);
    return createWarFollowupStateStore({ filePath: path.join(directory, 'state.json') });
}

function enqueue(store, overrides = {}) {
    return store.enqueueMutation(GUILD_ID, {
        id: MUTATION_ID,
        state: 'pending',
        action: 'contact',
        tag: '#P0LYGQ',
        actorId: '222222222222222222',
        actorName: 'Moderator',
        draftPreview: 'Message:\nPlease explain what happened.',
        request: {
            action: 'contact',
            tag: '#P0LYGQ',
            expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
            mutationId: MUTATION_ID,
            dmText: 'Please explain what happened.'
        },
        attempts: 0,
        createdAt: '2026-08-13T10:01:00.000Z',
        updatedAt: '2026-08-13T10:01:00.000Z',
        ...overrides
    });
}

function committedCase() {
    return {
        tag: '#P0LYGQ',
        status: 'needs_dm',
        contactPurpose: 'general',
        dmText: 'Please explain what happened.',
        createdAt: '2026-08-13T10:00:00.000Z',
        updatedAt: '2026-08-13T10:02:00.000Z',
        mutationLedger: [{
            mutationId: MUTATION_ID,
            action: 'contact',
            updatedAt: '2026-08-13T10:02:00.000Z'
        }]
    };
}

test('retry classification retries outages and quotas but stops on permanent client errors', () => {
    assert.equal(isTransientBackendFailure({ code: 'APPS_SCRIPT_RESULT_UNAVAILABLE', status: 404 }), true);
    assert.equal(isTransientBackendFailure({ code: 'TIMEOUT' }), true);
    assert.equal(isTransientBackendFailure({ code: 'BACKEND_NOT_OK', message: 'Service invoked too many times for one day' }), true);
    assert.equal(isTransientBackendFailure({ code: 'HTTP_ERROR', status: 503 }), true);
    assert.equal(isTransientBackendFailure({ code: 'HTTP_ERROR', status: 400 }), false);
    assert.equal(isTransientBackendFailure({ code: 'BACKEND_AUTHORIZATION_REQUIRED', status: 403 }), false);
});

test('a backend outage leaves the exact submitted mutation durable and a later tick commits it once', async t => {
    const store = createStore();
    enqueue(store);
    const sentRequests = [];
    let available = false;
    t.mock.method(rosterBackend, 'mutateWarFollowupCase', async request => {
        sentRequests.push(structuredClone(request));
        if (!available) {
            const error = new Error('Roster backend request timed out.');
            error.code = 'TIMEOUT';
            throw error;
        }
        return committedCase();
    });
    t.mock.method(rosterBackend, 'getWarFollowupCase', async () => {
        throw new Error('backend still unavailable');
    });

    const first = await executeMutation(GUILD_ID, MUTATION_ID, {
        store,
        force: true,
        now: new Date('2026-08-13T10:02:00.000Z')
    });
    assert.equal(first.record.state, 'pending');
    assert.equal(first.record.attempts, 1);
    assert.match(first.record.lastError.message, /timed out/i);
    assert.equal(first.record.draftPreview, 'Message:\nPlease explain what happened.');

    available = true;
    const processed = await processPendingMutations({
        store,
        now: new Date('2026-08-13T10:10:00.000Z')
    });
    assert.equal(processed.length, 1);
    assert.equal(processed[0].record.state, 'committed');
    assert.equal(sentRequests.length, 2);
    assert.deepEqual(sentRequests[1], sentRequests[0], 'every retry must use the exact same optimistic version and mutation ID');
});

test('an ambiguous timeout reconciles the mutation ledger instead of retrying or reporting a conflict', async t => {
    const store = createStore();
    enqueue(store);
    let mutationCalls = 0;
    t.mock.method(rosterBackend, 'mutateWarFollowupCase', async () => {
        mutationCalls += 1;
        const error = new Error('response was lost after commit');
        error.code = 'TIMEOUT';
        throw error;
    });
    t.mock.method(rosterBackend, 'getWarFollowupCase', async () => committedCase());

    const result = await executeMutation(GUILD_ID, MUTATION_ID, { store, force: true });
    assert.equal(result.record.state, 'committed');
    assert.equal(result.reconciled, true);
    assert.equal(result.result.status, 'needs_dm');
    assert.equal(mutationCalls, 1);
});

test('a stale optimistic version becomes a visible conflict and preserves the submitted draft', async t => {
    const store = createStore();
    enqueue(store);
    t.mock.method(rosterBackend, 'mutateWarFollowupCase', async () => {
        const error = new Error('This follow-up changed since it was opened. Reload and try again.');
        error.code = 'BACKEND_NOT_OK';
        throw error;
    });
    t.mock.method(rosterBackend, 'getWarFollowupCase', async () => ({
        ...committedCase(),
        status: 'waiting',
        mutationLedger: []
    }));

    const result = await executeMutation(GUILD_ID, MUTATION_ID, { store, force: true });
    assert.equal(result.record.state, 'conflict');
    assert.equal(result.record.nextAttemptAt, '');
    assert.match(result.record.draftPreview, /Please explain what happened/);
    assert.equal((await processPendingMutations({ store })).length, 0, 'conflicts must never overwrite newer backend state automatically');
});

test('concurrent duplicate execution shares one in-flight backend request', async t => {
    const store = createStore();
    enqueue(store);
    let resolveMutation;
    let calls = 0;
    t.mock.method(rosterBackend, 'mutateWarFollowupCase', async () => {
        calls += 1;
        await new Promise(resolve => { resolveMutation = resolve; });
        return committedCase();
    });
    t.mock.method(rosterBackend, 'getWarFollowupCase', async () => null);

    const first = executeMutation(GUILD_ID, MUTATION_ID, { store, force: true });
    const second = executeMutation(GUILD_ID, MUTATION_ID, { store, force: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    resolveMutation();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(left.record.state, 'committed');
    assert.equal(right.record.state, 'committed');
    assert.equal(calls, 1);
});

test('a committed owner assignment updates the local fairness timestamp exactly once', async t => {
    const store = createStore();
    const assignedModeratorId = '333333333333333333';
    enqueue(store, {
        action: 'assign_owner',
        request: {
            action: 'assign_owner',
            tag: '#P0LYGQ',
            expectedUpdatedAt: '2026-08-13T10:00:00.000Z',
            mutationId: MUTATION_ID,
            assignedModeratorId,
            assignedModeratorName: 'Assigned Moderator'
        }
    });
    const assignments = [];
    t.mock.method(store, 'recordModeratorAssignment', (...args) => assignments.push(args));
    t.mock.method(rosterBackend, 'mutateWarFollowupCase', async () => ({
        ...committedCase(),
        status: 'needs_review',
        assignedModeratorId,
        assignedModeratorName: 'Assigned Moderator',
        assignedAt: '2026-08-13T10:02:00.000Z',
        mutationLedger: [{ mutationId: MUTATION_ID, action: 'assign_owner' }]
    }));
    t.mock.method(rosterBackend, 'getWarFollowupCase', async () => null);

    const result = await executeMutation(GUILD_ID, MUTATION_ID, { store, force: true });
    assert.equal(result.record.state, 'committed');
    assert.deepEqual(assignments, [[GUILD_ID, assignedModeratorId, '2026-08-13T10:02:00.000Z']]);
});
