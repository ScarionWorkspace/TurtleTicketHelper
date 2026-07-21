const test = require('node:test');
const assert = require('node:assert/strict');

const rosterBackend = require('../src/features/rosterBackend/rosterBackendClient');
const rosterPublicData = require('../src/features/rosterPublicData/rosterPublicDataReadClient');
const handleSeasonEventInteraction = require('../src/features/seasonEvents/handleSeasonEventInteraction');

test('admin seasonal refresh acknowledges the interaction and renders Cloudflare data during Apps Script reauthorization', async () => {
    const originals = {
        isRosterBackendConfigured: rosterBackend.isRosterBackendConfigured,
        reconcileCurrentSeasonEvents: rosterBackend.reconcileCurrentSeasonEvents,
        getCurrentSeasonEvents: rosterBackend.getCurrentSeasonEvents,
        getSeasonEventLeaderboard: rosterBackend.getSeasonEventLeaderboard,
        readCurrentSeasonEventPointer: rosterPublicData.readCurrentSeasonEventPointer,
        readSeasonEventById: rosterPublicData.readSeasonEventById,
        readAllActivePlayerMetricsByTag: rosterPublicData.readAllActivePlayerMetricsByTag,
        readDonationRefreshSeasonOverlay: rosterPublicData.readDonationRefreshSeasonOverlay
    };
    const originalWarn = console.warn;
    const originalError = console.error;
    let backendCurrentReads = 0;
    let backendLeaderboardReads = 0;
    let edits = 0;
    let followUps = 0;

    rosterBackend.isRosterBackendConfigured = () => true;
    rosterBackend.reconcileCurrentSeasonEvents = async () => {
        const error = new Error('Apps Script owner authorization is required');
        error.code = 'BACKEND_AUTHORIZATION_REQUIRED';
        error.status = 403;
        throw error;
    };
    rosterBackend.getCurrentSeasonEvents = async () => {
        backendCurrentReads += 1;
        throw new Error('authorization failure must suppress a second backend read');
    };
    rosterBackend.getSeasonEventLeaderboard = async () => {
        backendLeaderboardReads += 1;
        throw new Error('authorization failure must suppress a leaderboard read');
    };
    rosterPublicData.readCurrentSeasonEventPointer = async type => ({
        eventId: `${type}-cloudflare-current`
    });
    rosterPublicData.readSeasonEventById = async eventId => ({
        eventId,
        type: 'push',
        title: 'Push Event',
        status: 'open',
        signupsOpen: true,
        participantsByDiscordId: {}
    });
    rosterPublicData.readAllActivePlayerMetricsByTag = async () => ({});
    rosterPublicData.readDonationRefreshSeasonOverlay = async () => null;

    const interaction = {
        customId: 'season_event:v1:refresh:push',
        deferred: false,
        replied: false,
        user: {
            id: 'admin-1',
            username: 'admin'
        },
        member: {
            displayName: 'Admin',
            roles: {
                cache: {
                    has: () => true
                }
            }
        },
        message: {
            id: 'season-message-1',
            async edit(payload) {
                edits += 1;
                assert.ok(payload);
            }
        },
        isButton: () => true,
        isStringSelectMenu: () => false,
        isModalSubmit: () => false,
        isRepliable: () => true,
        async deferUpdate() {
            this.deferred = true;
        },
        async followUp() {
            followUps += 1;
        }
    };

    console.warn = () => {};
    console.error = () => {};
    try {
        assert.equal(await handleSeasonEventInteraction(interaction), true);
        assert.equal(interaction.deferred, true);
        assert.equal(edits, 1);
        assert.equal(followUps, 0);
        assert.equal(backendCurrentReads, 0);
        assert.equal(backendLeaderboardReads, 0);
    } finally {
        console.warn = originalWarn;
        console.error = originalError;
        Object.assign(rosterBackend, {
            isRosterBackendConfigured: originals.isRosterBackendConfigured,
            reconcileCurrentSeasonEvents: originals.reconcileCurrentSeasonEvents,
            getCurrentSeasonEvents: originals.getCurrentSeasonEvents,
            getSeasonEventLeaderboard: originals.getSeasonEventLeaderboard
        });
        Object.assign(rosterPublicData, {
            readCurrentSeasonEventPointer: originals.readCurrentSeasonEventPointer,
            readSeasonEventById: originals.readSeasonEventById,
            readAllActivePlayerMetricsByTag: originals.readAllActivePlayerMetricsByTag,
            readDonationRefreshSeasonOverlay: originals.readDonationRefreshSeasonOverlay
        });
    }
});
