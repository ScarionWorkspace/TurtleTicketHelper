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
