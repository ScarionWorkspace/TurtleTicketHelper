const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.TURTLE_HELPER_SKIP_DOTENV = '1';

const {
    normalizeDeploymentScope,
    resolveDeploymentScope
} = require('../deploy-commands');

test('command deployment defaults to guild scope', () => {
    assert.equal(resolveDeploymentScope([], {}), 'guild');
});

test('command deployment supports explicit global scope', () => {
    assert.equal(resolveDeploymentScope(['--global'], {}), 'global');
    assert.equal(resolveDeploymentScope(['global'], {}), 'global');
    assert.equal(resolveDeploymentScope(['--scope=global'], {}), 'global');
});

test('command deployment supports explicit guild scope', () => {
    assert.equal(resolveDeploymentScope(['--guild'], {
        DISCORD_COMMAND_DEPLOYMENT_SCOPE: 'global'
    }), 'guild');
});

test('command deployment supports env-selected scope', () => {
    assert.equal(resolveDeploymentScope([], {
        DISCORD_COMMAND_DEPLOYMENT_SCOPE: 'global'
    }), 'global');
});

test('command deployment rejects invalid scopes and unknown arguments', () => {
    assert.throws(
        () => normalizeDeploymentScope('production'),
        /Invalid command deployment scope/
    );
    assert.throws(
        () => resolveDeploymentScope(['--prod'], {}),
        /Unknown command deployment argument/
    );
});
