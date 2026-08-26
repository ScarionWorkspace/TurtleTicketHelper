'use strict';

const assert = require('node:assert/strict');
const { afterEach, test } = require('node:test');

const SERVICE_PATH = require.resolve('../src/features/warFollowup/service');
const BACKEND_PATH = require.resolve('../src/features/rosterBackend/rosterBackendClient');
const PUBLIC_DATA_PATH = require.resolve('../src/features/rosterPublicData/rosterPublicDataReadClient');
const originalBackendModule = require.cache[BACKEND_PATH];
const originalPublicDataModule = require.cache[PUBLIC_DATA_PATH];

function installModule(path, exports) {
    require.cache[path] = {
        id: path,
        filename: path,
        loaded: true,
        exports
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function loadService(backend, publicData = {}) {
    delete require.cache[SERVICE_PATH];
    installModule(BACKEND_PATH, backend);
    installModule(PUBLIC_DATA_PATH, {
        readActiveRosterPayload: async () => ({ rosters: [] }),
        ...publicData
    });
    return require(SERVICE_PATH);
}

afterEach(() => {
    delete require.cache[SERVICE_PATH];
    if (originalBackendModule) require.cache[BACKEND_PATH] = originalBackendModule;
    else delete require.cache[BACKEND_PATH];
    if (originalPublicDataModule) require.cache[PUBLIC_DATA_PATH] = originalPublicDataModule;
    else delete require.cache[PUBLIC_DATA_PATH];
});

test('a slow pre-mutation private read cannot overwrite the post-mutation cache', async () => {
    const requests = [];
    const service = loadService({
        getWarFollowupState: () => {
            const request = deferred();
            requests.push(request);
            return request.promise;
        }
    });

    const staleRead = service.readPrivateState({ force: true });
    assert.equal(requests.length, 1);
    service.invalidatePrivateStateCache();
    const currentRead = service.readPrivateState({ force: true });
    assert.equal(requests.length, 2);

    requests[1].resolve({ settings: { moderatorNames: ['Current'] }, cases: [] });
    assert.deepEqual((await currentRead).settings.moderatorNames, ['Current']);
    requests[0].resolve({ settings: { moderatorNames: ['Stale'] }, cases: [] });
    assert.deepEqual((await staleRead).settings.moderatorNames, ['Stale']);

    const cached = await service.readPrivateState({ cacheTtlMs: 60_000 });
    assert.deepEqual(cached.settings.moderatorNames, ['Current']);
    assert.equal(requests.length, 2, 'the stale completion must not evict the newer cache entry');
});

test('interactive workspace reads reuse a short private cache and expose only a fresh modal snapshot', async () => {
    let backendReads = 0;
    const service = loadService({
        getWarFollowupState: async () => {
            backendReads += 1;
            return { settings: {}, cases: [] };
        }
    });

    const first = await service.loadWorkspace();
    const second = await service.loadWorkspace();
    assert.equal(backendReads, 1);
    assert.equal(service.peekWorkspace(), second);
    assert.notEqual(first, second);

    service.invalidatePrivateStateCache();
    assert.equal(service.peekWorkspace(), null);
});

test('simultaneous forced refreshes share one bounded request until a mutation invalidates it', async () => {
    const requests = [];
    const service = loadService({
        getWarFollowupState: options => {
            const request = deferred();
            requests.push({ ...request, options });
            return request.promise;
        }
    });
    const first = service.loadWorkspace({ forcePrivate: true });
    const second = service.loadWorkspace({ forcePrivate: true });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.maxAttempts, 1, 'a stalled read must not restart a second full timeout');
    assert.ok(requests[0].options.timeoutMs <= 15_000, 'read-only fallback must not wait 90 seconds');
    service.invalidatePrivateStateCache();
    const afterMutation = service.loadWorkspace({ forcePrivate: true });
    assert.equal(requests.length, 2);
    requests[1].resolve({ settings: { moderatorNames: ['Current'] }, cases: [] });
    await afterMutation;
    requests[0].resolve({ settings: { moderatorNames: ['Old'] }, cases: [] });
    await Promise.all([first, second]);
    assert.deepEqual((await service.readPrivateState({ cacheTtlMs: 60_000 })).settings.moderatorNames, ['Current']);
});

test('read-only workspace loads fall back to recent confirmed private state during a backend failure', async () => {
    let backendReads = 0;
    const service = loadService({
        getWarFollowupState: async () => {
            backendReads += 1;
            if (backendReads === 1) {
                return {
                    settings: { moderatorNames: ['Confirmed leader'] },
                    cases: [{ tag: '#P0LYGQ', status: 'needs_review' }]
                };
            }
            throw new Error('temporary Apps Script result failure');
        }
    });

    await service.loadWorkspace({ forcePrivate: true });
    const fallback = await service.loadWorkspace({
        forcePrivate: true,
        allowStalePrivateOnError: true
    });

    assert.equal(backendReads, 2);
    assert.equal(fallback.freshness.privateStateStale, true);
    assert.equal(Number.isFinite(fallback.freshness.privateStateCachedAt), true);
    assert.deepEqual(fallback.privateState.settings.moderatorNames, ['Confirmed leader']);
    assert.equal(fallback.privateState.cases[0].tag, '#P0LYGQ');
});

test('authoritative workspace loads still fail instead of using cached state', async () => {
    let backendReads = 0;
    const service = loadService({
        getWarFollowupState: async () => {
            backendReads += 1;
            if (backendReads === 1) return { settings: {}, cases: [] };
            throw new Error('temporary Apps Script result failure');
        }
    });

    await service.loadWorkspace({ forcePrivate: true });
    await assert.rejects(
        () => service.loadWorkspace({ forcePrivate: true }),
        /temporary Apps Script result failure/
    );
});
