'use strict';

const { isStaffMember, canTakeAnyWarFollowupCase } = require('../permissions/staffPermissions');
const workflow = require('./workflow');
const service = require('./service');
const views = require('./views');
const moderation = require('./moderation');
const { isWarFollowupCustomId, parseCustomId } = require('./customIds');
const { isPlayerReplyCaptureEnabled, warFollowupStateStore } = require('./stateStore');
const { ensureDashboard, ensureModerationHub } = require('./dashboard');
const { prepareContactMessage } = require('./contactMessages');
const mutationOutbox = require('./mutationOutbox');

const directDmInFlight = new Set();
const CASE_MODAL_ACTIONS = new Set([
    'contactform',
    'waitform',
    'watchform',
    'removeform',
    'resolveform',
    'heroform',
    'extendform',
    'noteform',
    'markdmform',
    'assignform'
]);
const busyStateKey = Symbol('warFollowupBusyState');
const BUSY_LABELS = Object.freeze({
    home: 'Loading overview\u2026',
    refresh: 'Refreshing cases\u2026',
    modsettings: 'Loading settings\u2026',
    mycases: 'Loading your cases\u2026',
    coverage: 'Loading coverage\u2026',
    modclans: 'Saving clan coverage\u2026',
    modnotify: 'Saving notifications\u2026',
    modtoggle: 'Updating availability\u2026',
    gaps: 'Loading Discord gaps\u2026',
    gapspage: 'Loading Discord gaps\u2026',
    rules: 'Loading rules\u2026',
    ignored: 'Loading ignored players\u2026',
    ignoredpage: 'Loading ignored players\u2026',
    filter: 'Filtering cases\u2026',
    page: 'Loading cases\u2026',
    pick: 'Loading case\u2026',
    case: 'Loading case\u2026',
    evidence: 'Loading evidence\u2026',
    activity: 'Loading activity\u2026',
    conversation: 'Loading conversation\u2026',
    hero: 'Loading recovery rosters\u2026',
    extend: 'Loading recovery rosters\u2026',
    assignment: 'Loading moderators\u2026',
    ignoreask: 'Loading confirmation\u2026',
    closeask: 'Loading confirmation\u2026',
    assignpick: 'Reassigning case\u2026',
    dismiss: 'Closing case\u2026',
    escalate: 'Escalating case\u2026',
    reopen: 'Reopening case\u2026',
    approve: 'Approving return\u2026',
    close: 'Closing case\u2026',
    removalnodm: 'Continuing removal\u2026',
    removaldone: 'Confirming removal\u2026',
    cancelremoval: 'Cancelling removal\u2026',
    approverejoin: 'Approving return\u2026',
    senddm: 'Sending DM\u2026',
    togreg: 'Saving rules\u2026',
    togcwl: 'Saving rules\u2026',
    toggaps: 'Saving rules\u2026',
    defroster: 'Saving default roster\u2026',
    ignore: 'Ignoring player\u2026',
    restore: 'Restoring player\u2026',
    pendingcheck: 'Checking saved change\u2026',
    pendingdiscard: 'Discarding saved draft\u2026'
});

function isEphemeralSource(interaction) {
    const flags = Number(interaction?.message?.flags?.bitfield ?? interaction?.message?.flags ?? 0);
    return (flags & views.EPHEMERAL) === views.EPHEMERAL;
}

function toApiJson(value) {
    if (!value) return null;
    const raw = typeof value.toJSON === 'function' ? value.toJSON() : value;
    try {
        return JSON.parse(JSON.stringify(raw));
    } catch (_error) {
        return null;
    }
}

function messageSnapshot(interaction) {
    const message = interaction?.message || {};
    return {
        content: typeof message.content === 'string' ? message.content : '',
        components: (Array.isArray(message.components) ? message.components : []).map(toApiJson).filter(Boolean),
        allowedMentions: { parse: [] }
    };
}

function disableComponents(componentsRaw, clickedCustomId, label, selectedValuesRaw = []) {
    const interactiveTypes = new Set([2, 3, 5, 6, 7, 8]);
    const selectedValues = new Set((Array.isArray(selectedValuesRaw) ? selectedValuesRaw : []).map(String));
    const visit = componentRaw => {
        const component = toApiJson(componentRaw);
        if (!component) return null;
        if (Array.isArray(component.components)) {
            component.components = component.components.map(visit).filter(Boolean);
        }
        if (interactiveTypes.has(Number(component.type))) component.disabled = true;
        if (component.custom_id === clickedCustomId) {
            if (Number(component.type) === 2) component.label = String(label).slice(0, 80);
            else if (interactiveTypes.has(Number(component.type))) {
                component.placeholder = String(label).slice(0, 150);
                if (Number(component.type) === 3 && Array.isArray(component.options)) {
                    component.options = component.options.map(option => ({
                        ...option,
                        default: selectedValues.has(String(option.value))
                    }));
                }
            }
        }
        return component;
    };
    return (Array.isArray(componentsRaw) ? componentsRaw : []).map(visit).filter(Boolean);
}

function busyLabel(interaction, fallback = 'Working\u2026') {
    const parsed = parseCustomId(interaction?.customId);
    return BUSY_LABELS[parsed?.action] || fallback;
}

function buildBusyPayload(interaction, label = busyLabel(interaction)) {
    const original = messageSnapshot(interaction);
    const notice = `\u23f3 **${label}** Controls will unlock when this finishes.`;
    const combined = original.content ? `${notice}\n\n${original.content}` : notice;
    return {
        ...original,
        content: combined.length <= 2000 ? combined : notice,
        components: disableComponents(original.components, interaction?.customId, label, interaction?.values)
    };
}

function addStaleDataNotice(payloadRaw, workspace) {
    if (workspace?.freshness?.privateStateStale !== true) return payloadRaw;
    const payload = payloadRaw && typeof payloadRaw === 'object' ? { ...payloadRaw } : {};
    const cachedAtSeconds = Math.floor(Number(workspace.freshness.privateStateCachedAt) / 1000);
    const age = cachedAtSeconds > 0 ? ` from <t:${cachedAtSeconds}:R>` : '';
    const notice = `\u26a0\ufe0f **Backend temporarily unavailable** \u2014 showing the last confirmed case data${age}. No changes were made.`;
    const original = String(payload.content || '');
    payload.content = original && notice.length + original.length + 2 <= 2000
        ? `${notice}\n\n${original}`
        : notice;
    payload.allowedMentions = { parse: [] };
    return payload;
}

async function beginBusyUpdate(interaction, label = busyLabel(interaction)) {
    const restorePayload = messageSnapshot(interaction);
    await interaction.deferUpdate();

    // Updating a public panel would lock it for everyone. Public hub buttons use
    // deferred private replies instead, but keep this guard as a safe fallback.
    if (!isEphemeralSource(interaction)) return;

    const state = { restorePayload, shown: false };
    interaction[busyStateKey] = state;
    try {
        await interaction.editReply(buildBusyPayload(interaction, label));
        state.shown = true;
    } catch (error) {
        // A cosmetic update must never prevent the requested moderation action.
        console.error('War Follow Up busy state could not be shown:', {
            interactionId: interaction?.id || null,
            error: error?.message || String(error)
        });
    }
}

async function restoreBusyUpdate(interaction) {
    const state = interaction?.[busyStateKey];
    if (!state?.shown) return;
    try {
        await interaction.editReply(state.restorePayload);
    } catch (error) {
        console.error('War Follow Up controls could not be restored after an error:', {
            interactionId: interaction?.id || null,
            error: error?.message || String(error)
        });
    } finally {
        delete interaction[busyStateKey];
    }
}

async function replyError(interaction, error, prefix = '') {
    const detail = String(error?.message || error || 'Unknown error').slice(0, 1500);
    const payload = {
        content: `${prefix}${detail}`,
        flags: views.EPHEMERAL,
        allowedMentions: { parse: [] }
    };
    const preservedDraft = modalDraftPreview(interaction);
    if (preservedDraft) {
        payload.embeds = [{
            color: views.COLORS.review,
            title: 'Your submitted text was not discarded',
            description: preservedDraft.split('\n').map(line => `> ${line || '\u200b'}`).join('\n').slice(0, 4096),
            footer: { text: 'Copy this text before dismissing the error.' }
        }];
    }
    try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(payload);
        else await interaction.reply(payload);
    } catch (replyFailure) {
        console.error('Failed to report War Follow Up interaction error:', {
            interactionId: interaction?.id || null,
            error: replyFailure?.message || String(replyFailure)
        });
    }
}

function modalDraftPreview(interaction) {
    if (!interaction?.isModalSubmit?.() || typeof interaction.fields?.getTextInputValue !== 'function') return '';
    const action = parseCustomId(interaction.customId)?.action || '';
    const fieldsByAction = {
        contactform: [['message', 'Message']],
        waitform: [['hours', 'Hours'], ['reason', 'Reason']],
        watchform: [['wars', 'Wars']],
        removeform: [['reason', 'Reason'], ['message', 'Player notice']],
        resolveform: [['resolution', 'Resolution']],
        heroform: [['wars', 'Clean wars'], ['no_misses', 'No misses'], ['message', 'Player message']],
        extendform: [['wars', 'Clean wars'], ['no_misses', 'No misses'], ['message', 'Player message']],
        noteform: [['note', 'Private note']],
        markdmform: [['message', 'Message']],
        assignform: [['handler', 'Handler']]
    };
    const values = [];
    for (const [id, label] of fieldsByAction[action] || []) {
        try {
            const value = String(interaction.fields.getTextInputValue(id) || '').trim();
            if (value) values.push(`${label}:\n${value}`);
        } catch {
            // Missing optional fields are not part of the preserved draft.
        }
    }
    return values.join('\n\n').slice(0, 3800);
}

async function authorize(interaction) {
    if (!interaction.inGuild?.()) {
        await interaction.reply({ content: 'War Follow Up is available only inside the server.', flags: views.EPHEMERAL });
        return false;
    }
    if (!isStaffMember(interaction.member)) {
        await interaction.reply({ content: 'This War Follow Up control is staff only.', flags: views.EPHEMERAL });
        return false;
    }
    return true;
}

function getConfig(interaction) {
    return warFollowupStateStore.getGuild(interaction.guildId).config;
}

function findItem(workspace, tagRaw) {
    const tag = workflow.normalizeTag(tagRaw);
    return workspace?.work?.items?.find(item => item.tag === tag) || null;
}

function findRosterByToken(workspace, tokenRaw) {
    return (workspace?.work?.directory?.rosters || [])
        .find(roster => views.rosterToken(roster.id) === tokenRaw) || null;
}

function assertCurrentCaseView(item, tokenRaw) {
    if (!item || !tokenRaw || views.caseToken(item) !== tokenRaw) {
        throw new Error('This follow-up changed after it was opened. Reopen it before taking action.');
    }
}

function assertCaseActionAllowed(item, action) {
    const status = item?.status || '';
    const caseStatus = item?.case?.status || '';
    const removalLocked = ['removal_pending', 'removal_evasion', 'removed'].includes(caseStatus);
    const allowedStatuses = {
        contact: ['needs_review', 'waiting'],
        watch: ['needs_review'],
        hero_down: ['needs_review'],
        remove: ['needs_review', 'waiting', 'hero_down', 'ready'],
        mark_dm_sent: ['needs_dm'],
        reopen: ['needs_dm', 'waiting', 'watching', 'closed'],
        extend: ['hero_down', 'ready'],
        close: ['hero_down', 'ready'],
        removal_no_dm: ['needs_dm'],
        removal_actioned: ['removal_pending'],
        cancel_removal: ['needs_dm', 'removal_pending'],
        approve_rejoin: ['needs_review', 'closed']
    };
    if (removalLocked && ['contact', 'watch', 'hero_down', 'wait', 'dismiss', 'resolve', 'reopen', 'close'].includes(action)) {
        throw new Error('Complete, repeat, approve, or cancel the removal workflow first.');
    }
    if (action === 'wait') {
        if (!['needs_review', 'waiting', 'needs_dm'].includes(status) || item?.case?.contactPurpose === 'removal') {
            throw new Error('This case cannot schedule a follow-up from its current state.');
        }
        return;
    }
    if (action === 'dismiss') {
        if (!['needs_review', 'watching'].includes(status)) {
            throw new Error('This case cannot be closed as no action from its current state.');
        }
        return;
    }
    if (action === 'resolve') {
        if (!['needs_review', 'needs_dm', 'waiting'].includes(status) || item?.case?.contactPurpose === 'removal') {
            throw new Error('This case cannot be recorded as resolved from its current state.');
        }
        return;
    }
    if (action === 'escalate') {
        if (!moderation.isOpenItem(item)) throw new Error('This moderation case is already closed.');
        return;
    }
    if (action === 'approve_return') {
        if (status !== 'ready' || item?.recovery?.ready !== true) {
            throw new Error('This player has not completed the required recovery period.');
        }
        return;
    }
    if (action === 'removal_no_dm' && item?.case?.contactPurpose !== 'removal') {
        throw new Error('This case is not waiting on a removal notice.');
    }
    if (action === 'cancel_removal' && item?.case?.contactPurpose !== 'removal') {
        throw new Error('This case is not in the removal workflow.');
    }
    if (action === 'approve_rejoin' && !['removed', 'removal_evasion'].includes(caseStatus)) {
        throw new Error('This account is not under rejoin monitoring.');
    }
    const allowed = allowedStatuses[action];
    if (allowed && !allowed.includes(status)) {
        throw new Error('That action is no longer valid for the current follow-up status. Reopen the case first.');
    }
}

function directDmDeliveryKey(itemRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const caseValue = item.case && typeof item.case === 'object' ? item.case : {};
    const activity = Array.isArray(caseValue.activity) ? caseValue.activity : [];
    const decisionActivity = activity.slice().reverse().find(entry =>
        ['hero_down_decision', 'extended', 'contact_prepared', 'removal_decision'].includes(String(entry?.type || ''))
    );
    const decisionRevision = workflow.stableRevision(JSON.stringify({
        decisionActivity: decisionActivity
            ? [decisionActivity.id || '', decisionActivity.at || '', decisionActivity.type || '']
            : [],
        dmText: String(caseValue.dmText || ''),
        contactPurpose: String(caseValue.contactPurpose || ''),
        removalStartedAt: String(caseValue.removalStartedAt || ''),
        targetRosterId: String(caseValue.targetRosterId || ''),
        targetClanTag: workflow.normalizeTag(caseValue.targetClanTag),
        recoveryWarTarget: Number(caseValue.recoveryWarTarget) || 0,
        requireNoMisses: caseValue.requireNoMisses !== false
    }));
    return `direct-dm:${workflow.normalizeTag(item.tag)}:${decisionRevision}`;
}

async function refreshModerationHubQuietly(interaction, workspace) {
    const moderationHub = warFollowupStateStore.getGuild(interaction.guildId).moderationHub || {};
    if (!moderationHub.channelId) return;
    try {
        await ensureModerationHub(interaction.client, interaction.guildId, workspace);
    } catch (error) {
        console.error('Moderation Hub refresh failed:', {
            guildId: interaction.guildId,
            error: error?.message || String(error)
        });
    }
}

async function refreshDashboardQuietly(interaction, workspace) {
    const config = getConfig(interaction);
    if (!config.enabled || !config.channelId) return;
    try {
        await ensureDashboard(interaction.client, interaction.guildId, workspace, config);
    } catch (error) {
        console.error('War Follow Up dashboard refresh failed:', {
            guildId: interaction.guildId,
            error: error?.message || String(error)
        });
    }
    await refreshModerationHubQuietly(interaction, workspace);
}

async function renderView(interaction, buildPayload, options = {}) {
    const updateExisting = isEphemeralSource(interaction);
    if (updateExisting) await beginBusyUpdate(interaction);
    else await interaction.deferReply({ flags: views.EPHEMERAL });

    const workspace = await service.loadWorkspace({
        forcePrivate: options.forcePrivate === true,
        allowStalePrivateOnError: true
    });
    const payload = addStaleDataNotice(buildPayload(workspace, getConfig(interaction)), workspace);
    await interaction.editReply(views.asEditPayload(payload));
    return workspace;
}

function moderatorIdentity(interaction) {
    return {
        discordId: String(interaction.user?.id || interaction.member?.id || '').trim(),
        displayName: service.getActorName(interaction)
    };
}

async function syncModeratorPreferenceQuietly(interaction, preference) {
    try {
        await service.syncModeratorPreference(interaction.guildId, preference, { maxAttempts: 1, timeoutMs: 10_000 });
        return true;
    } catch (error) {
        console.error('War Follow Up moderator website sync failed:', {
            guildId: interaction.guildId,
            discordId: preference?.discordId || '',
            error: error?.message || String(error)
        });
        return false;
    }
}

async function buildCoverageForInteraction(interaction, workspace) {
    const guildRecord = warFollowupStateStore.getGuild(interaction.guildId);
    const resolveMember = moderation.createMemberResolver(interaction.guild);
    const eligibleIds = new Set();
    for (const roster of workspace?.work?.directory?.rosters || []) {
        const eligible = await moderation.getEligibleModerators(
            interaction.guild,
            guildRecord,
            roster.clanTag,
            { resolveMember }
        );
        for (const moderator of eligible) eligibleIds.add(moderator.discordId);
    }
    return views.buildCoveragePayload(workspace, guildRecord, { eligibleIds });
}

async function showCachedModal(interaction, builder) {
    // Discord modal responses cannot be deferred. Every view is populated by
    // loadWorkspace first, so use that in-memory snapshot synchronously and
    // perform the authoritative stale-token check again on modal submission.
    const workspace = service.peekWorkspace();
    if (!workspace) {
        throw new Error('This view expired. Reopen the follow-up before opening a form.');
    }
    const modal = builder(workspace);
    if (!modal) throw new Error('This follow-up changed. Reopen it and try again.');
    const modalJson = modal.toJSON();
    const parsed = parseCustomId(modalJson.custom_id);
    let contextSaved = false;
    if (parsed && CASE_MODAL_ACTIONS.has(parsed.action)) {
        const item = findItem(workspace, parsed.values[0]);
        if (!item) throw new Error('This follow-up changed. Reopen it and try again.');
        warFollowupStateStore.recordModalContext(
            interaction.guildId,
            interaction.user?.id || interaction.member?.id,
            modalJson.custom_id,
            {
                action: parsed.action,
                tag: item.tag,
                viewToken: parsed.values[1] || '',
                item,
                workspaceContext: {
                    rosters: (workspace?.work?.directory?.rosters || []).map(roster => ({
                        id: roster.id,
                        title: roster.title,
                        clanTag: roster.clanTag
                    }))
                }
            }
        );
        contextSaved = true;
    }
    try {
        await interaction.showModal(modal);
    } catch (error) {
        if (contextSaved) {
            warFollowupStateStore.removeModalContext(
                interaction.guildId,
                interaction.user?.id || interaction.member?.id,
                modalJson.custom_id
            );
        }
        throw error;
    }
}

function draftPreviewForMutation(action, patch) {
    const blocks = [];
    const add = (label, value) => {
        const shown = String(value == null ? '' : value).trim();
        if (shown) blocks.push(`${label}:\n${shown}`);
    };
    if (action === 'contact') add('Message', patch.dmText);
    else if (action === 'wait') {
        add('Follow-up', `${patch.followupHours} hours`);
        add('Reason', patch.waitingReason);
    } else if (action === 'watch') add('Monitoring period', `${patch.watchWarTarget} wars`);
    else if (action === 'remove') {
        add('Reason', patch.removalReason);
        add('Player notice', patch.dmText);
    } else if (action === 'resolve') add('Resolution', patch.resolutionNote);
    else if (action === 'hero_down' || action === 'extend') {
        add('Recovery period', `${patch.recoveryWarTarget} clean wars`);
        add('Player message', patch.dmText);
    } else if (action === 'add_note') add('Private note', patch.note);
    else if (action === 'mark_dm_sent') add('Recorded message', patch.dmText);
    else if (action === 'set_handler') add('Handler', patch.handledBy || 'Unassigned');
    return blocks.join('\n\n').slice(0, 6000);
}

function latestLocalMutationForTag(guildId, tagRaw) {
    const tag = workflow.normalizeTag(tagRaw);
    return warFollowupStateStore.listMutations(guildId)
        .filter(record => record.tag === tag && ['pending', 'conflict', 'failed'].includes(record.state))
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0] || null;
}

async function mutateAndRender(interaction, action, tagRaw, viewTokenRaw, patch = {}) {
    await beginBusyUpdate(interaction);
    const actor = service.getActorName(interaction);
    const pending = latestLocalMutationForTag(interaction.guildId, tagRaw);
    if (pending) {
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(pending)));
        return;
    }
    let workspace = service.peekWorkspace();
    if (!workspace) workspace = await service.loadWorkspace({ forcePrivate: true });
    const item = findItem(workspace, tagRaw);
    assertCurrentCaseView(item, viewTokenRaw);
    assertCaseActionAllowed(item, action);
    const requestPatch = ['dismiss', 'approve_return', 'close', 'cancel_removal', 'approve_rejoin'].includes(action)
        ? { ...patch, evidence: patch.evidence || item.evidence }
        : patch;
    const mutationId = service.mutationId(`${interaction.id}:${action}:${item.tag}`);
    const request = service.buildMutationRequest(item, action, requestPatch, {
        actor,
        mutationId
    });
    let record = warFollowupStateStore.enqueueMutation(interaction.guildId, {
        id: mutationId,
        state: 'pending',
        action,
        tag: item.tag,
        actorId: interaction.user?.id || interaction.member?.id || '',
        actorName: actor,
        draftPreview: draftPreviewForMutation(action, requestPatch),
        request,
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
    const outcome = await mutationOutbox.executeMutation(interaction.guildId, mutationId, {
        store: warFollowupStateStore,
        force: true
    });
    record = outcome.record || record;
    if (record.state === 'committed' && outcome.result && workspace?.rosterData) {
        workspace = service.acceptConfirmedCase(workspace, outcome.result);
        await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, getConfig(interaction))));
        await refreshDashboardQuietly(interaction, workspace);
        return;
    }
    await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
}

function numberField(interaction, id, min, max, label, integer = false) {
    const raw = String(interaction.fields.getTextInputValue(id) || '').trim();
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new Error(`${label} must be ${integer ? 'a whole number' : 'a number'} from ${min} to ${max}.`);
    }
    return value;
}

function yesNoField(interaction, id) {
    const value = String(interaction.fields.getTextInputValue(id) || '').trim().toLowerCase();
    if (['yes', 'y', 'true', '1', 'on'].includes(value)) return true;
    if (['no', 'n', 'false', '0', 'off'].includes(value)) return false;
    throw new Error('Use yes or no for the missed-attack requirement.');
}

async function handleDirectMessage(interaction, tagRaw, viewTokenRaw) {
    await beginBusyUpdate(interaction);
    let dmDelivered = false;
    let deliveryReserved = false;
    let caseMarkedSent = false;
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    let item = findItem(workspace, tagRaw);
    let config = getConfig(interaction);
    assertCurrentCaseView(item, viewTokenRaw);
    if (item.status !== 'needs_dm') throw new Error('This follow-up is not waiting for a DM.');
    if (!config.features.directMessages) throw new Error('Direct DMs are not opted in for this server.');
    const generalContact = item.case?.contactPurpose === 'general';
    const removalContact = item.case?.contactPurpose === 'removal';
    if (generalContact && !isPlayerReplyCaptureEnabled(config)) {
        throw new Error('Player reply capture is disabled. Enable it before sending a Contact player message through the bot.');
    }
    if (!item.player?.discordId) throw new Error('This player has no linked Discord ID.');
    const deliveryKey = directDmDeliveryKey(item);
    const scopedDeliveryKey = `${interaction.guildId}:${deliveryKey}`;
    if (warFollowupStateStore.hasDelivery(interaction.guildId, deliveryKey) || directDmInFlight.has(scopedDeliveryKey)) {
        throw new Error('This exact decision DM was already delivered or safely reserved after an ambiguous attempt. Verify the DM, then use “Mark DM sent” instead of sending it again.');
    }
    directDmInFlight.add(scopedDeliveryKey);

    try {
        const user = await interaction.client.users.fetch(item.player.discordId);
        // Recheck both shared case state and the local opt-in immediately before
        // the irreversible Discord send. Backend optimistic concurrency protects
        // the later state mutation, but it cannot recall an already-delivered DM.
        workspace = await service.loadWorkspace({ forcePrivate: true });
        item = findItem(workspace, tagRaw);
        config = getConfig(interaction);
        assertCurrentCaseView(item, viewTokenRaw);
        if (item.status !== 'needs_dm') throw new Error('This follow-up is no longer waiting for a DM.');
        if (!config.features.directMessages) throw new Error('Direct DMs were disabled before this message was sent.');
        if (generalContact && !isPlayerReplyCaptureEnabled(config)) {
            throw new Error('Player reply capture was disabled before this message was sent.');
        }
        const message = prepareContactMessage(item.case?.dmText, item.case?.contactPurpose);
        // Persist an at-most-once reservation before the irreversible API call.
        // If the process stops after Discord accepts the DM, the next attempt
        // remains safely blocked instead of sending the same decision twice.
        warFollowupStateStore.recordDeliveries(interaction.guildId, deliveryKey, {
            disposition: 'direct-dm-pending'
        });
        deliveryReserved = true;
        const dmMessage = await user.send({ content: message, allowedMentions: { parse: [] } });
        dmDelivered = true;
        warFollowupStateStore.recordDeliveries(interaction.guildId, deliveryKey, {
            messageId: dmMessage?.id,
            disposition: 'direct-dm-sent'
        });
        const actor = service.getActorName(interaction);
        const mutationId = service.mutationId(`${interaction.id}:send-dm:${item.tag}`);
        const patch = {
            dmText: message,
            dmDeliveryMode: 'bot',
            dmMessageId: dmMessage?.id || '',
            dmSentByDiscordId: interaction.user?.id || interaction.member?.id || '',
            dmSentByName: actor
        };
        const request = service.buildMutationRequest(item, 'mark_dm_sent', patch, { actor, mutationId });
        let record = warFollowupStateStore.enqueueMutation(interaction.guildId, {
            id: mutationId,
            state: 'pending',
            action: 'mark_dm_sent',
            tag: item.tag,
            actorId: interaction.user?.id || interaction.member?.id || '',
            actorName: actor,
            draftPreview: draftPreviewForMutation('mark_dm_sent', patch),
            request,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
        const outcome = await mutationOutbox.executeMutation(interaction.guildId, mutationId, {
            store: warFollowupStateStore,
            force: true
        });
        record = outcome.record || record;
        caseMarkedSent = record.state === 'committed';
        if (!caseMarkedSent || !outcome.result) {
            await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
            return;
        }
        workspace = service.acceptConfirmedCase(workspace, outcome.result);
        await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, config)));
        await interaction.followUp({
            content: generalContact
                ? `Contact message sent to <@${item.player.discordId}>. The case is waiting for a response with a 24-hour follow-up.`
                : removalContact
                    ? `Removal notice sent to <@${item.player.discordId}>. Remove the player in game; the case will stay open until roster data confirms they left.`
                    : `Decision DM sent to <@${item.player.discordId}> and the recovery period is now active.`,
            flags: views.EPHEMERAL,
            allowedMentions: { parse: [] }
        });
        await refreshDashboardQuietly(interaction, workspace);
    } catch (error) {
        if (!dmDelivered && deliveryReserved) {
            try {
                warFollowupStateStore.removeDeliveries(interaction.guildId, deliveryKey);
                deliveryReserved = false;
            } catch (releaseError) {
                throw new Error(
                    `${String(error?.message || error)} The failed attempt remains safely reserved because its delivery marker could not be cleared: ${String(releaseError?.message || releaseError)}`
                );
            }
        }
        if (dmDelivered) {
            await interaction.editReply({
                content: [
                    caseMarkedSent
                        ? '⚠️ The DM was delivered and the case update succeeded, but the final Discord confirmation could not be completed.'
                        : '⚠️ The DM was delivered, but the case could not be marked sent.',
                    caseMarkedSent
                        ? 'This copy of the controls has been retired. Reopen the case to see the authoritative status; do not send the DM again.'
                        : 'To prevent a duplicate DM, this copy of the controls has been retired. Reopen the case and use **Mark DM sent** once the backend is available.',
                    `Detail: ${String(error?.message || error).slice(0, 1000)}`
                ].join('\n'),
                embeds: [],
                components: [views.navigationRow()],
                allowedMentions: { parse: [] }
            });
            return;
        }
        throw error;
    } finally {
        directDmInFlight.delete(scopedDeliveryKey);
    }
}

async function handleToggleRule(interaction, key) {
    await beginBusyUpdate(interaction);
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    const settings = workspace.work.settings;
    await service.saveRules({ [key]: !settings[key] }, settings.rulesUpdatedAt, {
        seed: `${interaction.id}:toggle:${key}`
    });
    workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildRulesPayload(workspace)));
    await refreshDashboardQuietly(interaction, workspace);
}

async function handleDefaultRoster(interaction) {
    await beginBusyUpdate(interaction);
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    const token = interaction.values?.[0] || '';
    const roster = token === '__none__' ? null : findRosterByToken(workspace, token);
    if (token !== '__none__' && !roster) throw new Error('That roster is no longer available.');
    await service.saveRules(
        { defaultHeroDownRosterId: roster?.id || '' },
        workspace.work.settings.rulesUpdatedAt,
        { seed: `${interaction.id}:default-roster:${roster?.id || 'none'}` }
    );
    workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildRulesPayload(workspace)));
}

async function handleButtonOrSelect(interaction, parsed) {
    const action = parsed.action;
    const [first, second, third] = parsed.values;

    if (action === 'pendingcheck') {
        await beginBusyUpdate(interaction);
        const current = warFollowupStateStore.getMutation(interaction.guildId, first);
        if (!current) throw new Error('This saved change is no longer in the local queue. Open the current case to see its authoritative state.');
        const outcome = await mutationOutbox.executeMutation(interaction.guildId, first, {
            store: warFollowupStateStore,
            force: true
        });
        const record = outcome.record || current;
        if (record.state === 'committed' && outcome.result) {
            const cachedWorkspace = service.peekWorkspace();
            if (cachedWorkspace?.rosterData) {
                const confirmedWorkspace = service.acceptConfirmedCase(cachedWorkspace, outcome.result);
                await interaction.editReply(views.asEditPayload(views.buildCasePayload(
                    findItem(confirmedWorkspace, record.tag),
                    confirmedWorkspace,
                    getConfig(interaction)
                )));
                await refreshDashboardQuietly(interaction, confirmedWorkspace);
                return;
            }
        }
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
        return;
    }
    if (action === 'pendingdiscard') {
        await beginBusyUpdate(interaction);
        const record = warFollowupStateStore.getMutation(interaction.guildId, first);
        if (!record) throw new Error('This saved draft was already removed.');
        if (record.state === 'pending') throw new Error('A possibly in-flight change cannot be discarded safely. Check its status first.');
        const identity = moderatorIdentity(interaction);
        if (record.actorId && record.actorId !== identity.discordId && !canTakeAnyWarFollowupCase(interaction.member)) {
            throw new Error('Only the moderator who submitted this draft or senior leadership can discard it.');
        }
        warFollowupStateStore.removeMutation(interaction.guildId, first);
        await interaction.editReply({
            content: record.state === 'committed' ? 'Saved-change confirmation dismissed.' : 'Saved draft discarded. No backend change was made by this record.',
            embeds: [],
            components: [views.navigationRow()],
            allowedMentions: { parse: [] }
        });
        return;
    }
    if (action === 'pendingpick') {
        if (isEphemeralSource(interaction)) await beginBusyUpdate(interaction);
        else await interaction.deferReply({ flags: views.EPHEMERAL });
        const mutationId = interaction.values?.[0] || '';
        const record = warFollowupStateStore.getMutation(interaction.guildId, mutationId);
        const identity = moderatorIdentity(interaction);
        if (!record || (record.actorId && record.actorId !== identity.discordId && !canTakeAnyWarFollowupCase(interaction.member))) {
            throw new Error('That saved moderation change is no longer available to you.');
        }
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
        return;
    }

    if (action === 'home' || action === 'refresh') {
        await renderView(interaction, (workspace, config) => views.buildHomePayload(workspace, config), {
            forcePrivate: action === 'refresh'
        });
        return;
    }
    if (action === 'modsettings') {
        await renderView(interaction, workspace => {
            const identity = moderatorIdentity(interaction);
            return views.buildModeratorSettingsPayload(
                workspace,
                warFollowupStateStore.getGuild(interaction.guildId),
                identity.discordId,
                identity.displayName
            );
        }, { forcePrivate: true });
        return;
    }
    if (action === 'mycases') {
        const identity = moderatorIdentity(interaction);
        const pendingMutations = warFollowupStateStore.listMutations(interaction.guildId)
            .filter(record => record.actorId === identity.discordId && ['pending', 'conflict', 'failed'].includes(record.state));
        await renderView(interaction, workspace => views.buildMyCasesPayload(workspace, identity.discordId, { pendingMutations }), {
            forcePrivate: true
        });
        return;
    }
    if (action === 'coverage') {
        if (isEphemeralSource(interaction)) await beginBusyUpdate(interaction);
        else await interaction.deferReply({ flags: views.EPHEMERAL });
        const workspace = await service.loadWorkspace({
            forcePrivate: true,
            allowStalePrivateOnError: true
        });
        const payload = addStaleDataNotice(await buildCoverageForInteraction(interaction, workspace), workspace);
        await interaction.editReply(views.asEditPayload(payload));
        return;
    }
    if (action === 'modclans') {
        await beginBusyUpdate(interaction);
        const workspace = await service.loadWorkspace({ forcePrivate: false });
        const available = new Set((workspace?.work?.directory?.rosters || []).map(roster => workflow.normalizeTag(roster.clanTag)).filter(Boolean));
        const clanTags = (interaction.values || []).map(workflow.normalizeTag).filter(tag => available.has(tag));
        if (clanTags.length !== (interaction.values || []).length) throw new Error('One selected clan is no longer available. Reopen your settings.');
        const identity = moderatorIdentity(interaction);
        const preference = warFollowupStateStore.upsertModerator(interaction.guildId, identity.discordId, {
            displayName: identity.displayName,
            clanTags
        });
        await interaction.editReply(views.asEditPayload(views.buildModeratorSettingsPayload(
            workspace,
            warFollowupStateStore.getGuild(interaction.guildId),
            identity.discordId,
            identity.displayName
        )));
        await refreshModerationHubQuietly(interaction, workspace);
        const synced = await syncModeratorPreferenceQuietly(interaction, preference);
        if (!synced) {
            await interaction.followUp({
                content: 'Your Discord settings were saved. Website access will sync automatically when the backend is reachable.',
                flags: views.EPHEMERAL,
                allowedMentions: { parse: [] }
            });
        }
        return;
    }
    if (action === 'modnotify' || action === 'modtoggle') {
        await beginBusyUpdate(interaction);
        const identity = moderatorIdentity(interaction);
        const record = warFollowupStateStore.getGuild(interaction.guildId);
        const current = record.moderators?.[identity.discordId] || {};
        const patch = { displayName: identity.displayName };
        if (action === 'modnotify') {
            if (!['dm', 'channel', 'both'].includes(first)) throw new Error('Invalid notification preference.');
            patch.notificationMode = first;
        } else {
            if (!Array.isArray(current.clanTags) || !current.clanTags.length) {
                throw new Error('Select at least one clan before accepting assignments.');
            }
            patch.accepting = current.accepting !== true;
        }
        const preference = warFollowupStateStore.upsertModerator(interaction.guildId, identity.discordId, patch);
        const workspace = await service.loadWorkspace({ forcePrivate: false });
        await interaction.editReply(views.asEditPayload(views.buildModeratorSettingsPayload(
            workspace,
            warFollowupStateStore.getGuild(interaction.guildId),
            identity.discordId,
            identity.displayName
        )));
        await refreshModerationHubQuietly(interaction, workspace);
        const synced = await syncModeratorPreferenceQuietly(interaction, preference);
        if (!synced) {
            await interaction.followUp({
                content: 'Your Discord settings were saved. Website access will sync automatically when the backend is reachable.',
                flags: views.EPHEMERAL,
                allowedMentions: { parse: [] }
            });
        }
        return;
    }
    if (action === 'gaps') {
        await renderView(interaction, workspace => views.buildGapsPayload(workspace));
        return;
    }
    if (action === 'gapspage') {
        await renderView(interaction, workspace => views.buildGapsPayload(workspace, { page: Number(first) || 0 }));
        return;
    }
    if (action === 'rules') {
        await renderView(interaction, workspace => views.buildRulesPayload(workspace), { forcePrivate: true });
        return;
    }
    if (action === 'ignored') {
        await renderView(interaction, workspace => views.buildIgnoredPayload(workspace), { forcePrivate: true });
        return;
    }
    if (action === 'ignoredpage') {
        await renderView(interaction, workspace => views.buildIgnoredPayload(workspace, { page: Number(first) || 0 }), { forcePrivate: true });
        return;
    }
    if (action === 'filter') {
        await renderView(interaction, (workspace, config) => views.buildHomePayload(workspace, config, { status: first }));
        return;
    }
    if (action === 'page') {
        await renderView(interaction, (workspace, config) => views.buildHomePayload(workspace, config, {
            page: Number(first) || 0,
            status: second
        }));
        return;
    }
    if (action === 'pick') {
        const tag = interaction.values?.[0];
        const localMutation = latestLocalMutationForTag(interaction.guildId, tag);
        if (localMutation) {
            if (isEphemeralSource(interaction)) await beginBusyUpdate(interaction);
            else await interaction.deferReply({ flags: views.EPHEMERAL });
            await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(localMutation)));
            return;
        }
        await renderView(interaction, (workspace, config) => views.buildCasePayload(findItem(workspace, tag), workspace, config));
        return;
    }
    if (action === 'case' || action === 'casecurrent') {
        const localMutation = action === 'case' ? latestLocalMutationForTag(interaction.guildId, first) : null;
        if (localMutation) {
            if (isEphemeralSource(interaction)) await beginBusyUpdate(interaction);
            else await interaction.deferReply({ flags: views.EPHEMERAL });
            await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(localMutation)));
            return;
        }
        await renderView(interaction, (workspace, config) => views.buildCasePayload(findItem(workspace, first), workspace, config));
        return;
    }
    if (action === 'evidence') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return views.buildEvidencePayload(item);
        });
        return;
    }
    if (action === 'activity') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return views.buildActivityPayload(item, third);
        });
        return;
    }
    if (action === 'conversation') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return views.buildConversationPayload(item, third);
        });
        return;
    }
    if (action === 'hero') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return views.buildHeroRosterPicker(item, workspace);
        });
        return;
    }
    if (action === 'herotarget' || action === 'extendtarget') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            const target = findRosterByToken(workspace, interaction.values?.[0]);
            if (!target?.clanTag) return null;
            return action === 'extendtarget'
                ? views.buildExtendModal(item, target)
                : views.buildHeroModal(item, target, workspace);
        });
        return;
    }
    if (action === 'watch') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return item ? views.buildWatchModal(item) : null;
        });
        return;
    }
    if (action === 'remove' || action === 'resolveask') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            if (action === 'remove') {
                assertCaseActionAllowed(item, 'remove');
                return views.buildRemovalModal(item);
            }
            assertCaseActionAllowed(item, 'resolve');
            return views.buildResolveModal(item);
        });
        return;
    }
    if (action === 'extend') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            assertCaseActionAllowed(item, 'extend');
            return views.buildHeroRosterPicker(item, workspace, { extending: true });
        });
        return;
    }
    if (action === 'note') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return item ? views.buildNoteModal(item) : null;
        });
        return;
    }
    if (action === 'markdm') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return item ? views.buildMarkDmModal(item) : null;
        });
        return;
    }
    if (action === 'assignment') {
        if (isEphemeralSource(interaction)) await beginBusyUpdate(interaction);
        else await interaction.deferReply({ flags: views.EPHEMERAL });
        const workspace = await service.loadWorkspace({
            forcePrivate: true,
            allowStalePrivateOnError: true
        });
        const item = findItem(workspace, first);
        assertCurrentCaseView(item, second);
        const eligible = await moderation.getEligibleModerators(
            interaction.guild,
            warFollowupStateStore.getGuild(interaction.guildId),
            moderation.caseClanTag(item)
        );
        const identity = moderatorIdentity(interaction);
        const payload = addStaleDataNotice(views.buildReassignmentPayload(item, eligible, {
            currentModeratorId: identity.discordId,
            currentModeratorName: identity.displayName,
            canTakeAnyCase: canTakeAnyWarFollowupCase(interaction.member)
        }), workspace);
        await interaction.editReply(views.asEditPayload(payload));
        return;
    }
    if (action === 'contact' || action === 'wait') {
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return item ? (action === 'contact' ? views.buildContactModal(item) : views.buildWaitModal(item)) : null;
        });
        return;
    }
    if (action === 'editreg' || action === 'editcwl' || action === 'editflow') {
        await showCachedModal(interaction, workspace => {
            if (action === 'editreg') return views.buildRegularRulesModal(workspace.work.settings);
            if (action === 'editcwl') return views.buildCwlRulesModal(workspace.work.settings);
            return views.buildWorkflowRulesModal(workspace.work.settings);
        });
        return;
    }
    if (action === 'ignoreask' || action === 'closeask') {
        await renderView(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return views.buildConfirmationPayload(action === 'ignoreask' ? 'ignore' : 'close', item);
        });
        return;
    }
    if (action === 'assignpick') {
        await beginBusyUpdate(interaction);
        const existingPending = latestLocalMutationForTag(interaction.guildId, first);
        if (existingPending) {
            await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(existingPending)));
            return;
        }
        let workspace = service.peekWorkspace();
        if (!workspace) workspace = await service.loadWorkspace({ forcePrivate: true });
        const item = findItem(workspace, first);
        assertCurrentCaseView(item, second);
        const eligible = await moderation.getEligibleModerators(
            interaction.guild,
            warFollowupStateStore.getGuild(interaction.guildId),
            moderation.caseClanTag(item)
        );
        const selected = String(interaction.values?.[0] || '');
        const identity = moderatorIdentity(interaction);
        const eligibleSelf = eligible.find(candidate => candidate.discordId === identity.discordId) || null;
        const unrestrictedSelf = canTakeAnyWarFollowupCase(interaction.member)
            ? {
                discordId: identity.discordId,
                displayName: identity.displayName
            }
            : null;
        const chosen = selected === '__auto__'
            ? moderation.chooseModerator(eligible, workspace.work.items, {
                avoidModeratorId: item.case?.assignedModeratorId,
                blockedModeratorId: item.case?.assignmentBlockedModeratorId,
                blockedUntil: item.case?.assignmentBlockedUntil,
                nowMs: Date.now()
            })
            : selected === '__self__'
                ? eligibleSelf || unrestrictedSelf
            : eligible.find(candidate => candidate.discordId === selected) || null;
        let mutationAction = 'assign_owner';
        let patch = moderation.assignmentPatch(chosen, {
            outsideCoverage: selected === '__self__' && !eligibleSelf && Boolean(unrestrictedSelf)
        });
        if (selected === '__unassigned__') {
            mutationAction = 'unassign_owner';
            patch = {};
        } else if (!chosen) {
            throw new Error(selected === '__self__'
                ? 'To take ownership outside your selected clans, a senior leadership role is required.'
                : 'No eligible moderator is currently available for that assignment.');
        }
        const actor = service.getActorName(interaction);
        const mutationId = service.mutationId(`${interaction.id}:${mutationAction}:${item.tag}:${chosen?.discordId || 'unassigned'}`);
        const request = service.buildMutationRequest(item, mutationAction, patch, { actor, mutationId });
        let record = warFollowupStateStore.enqueueMutation(interaction.guildId, {
            id: mutationId,
            state: 'pending',
            action: mutationAction,
            tag: item.tag,
            actorId: identity.discordId,
            actorName: actor,
            draftPreview: chosen ? `Owner:\n${chosen.displayName}` : 'Owner:\nUnassigned',
            request,
            attempts: 0,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
        const outcome = await mutationOutbox.executeMutation(interaction.guildId, mutationId, {
            store: warFollowupStateStore,
            force: true
        });
        record = outcome.record || record;
        if (record.state === 'committed' && outcome.result && workspace?.rosterData) {
            workspace = service.acceptConfirmedCase(workspace, outcome.result);
            await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, getConfig(interaction))));
            await refreshDashboardQuietly(interaction, workspace);
            return;
        }
        await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
        return;
    }
    if (action === 'dismiss') return mutateAndRender(interaction, 'dismiss', first, second);
    if (action === 'escalate') return mutateAndRender(interaction, 'escalate', first, second);
    if (action === 'reopen') return mutateAndRender(interaction, 'reopen', first, second);
    if (action === 'approve') return mutateAndRender(interaction, 'approve_return', first, second);
    if (action === 'close') return mutateAndRender(interaction, 'close', first, second, { outcome: 'no_return' });
    if (action === 'removalnodm') return mutateAndRender(interaction, 'removal_no_dm', first, second);
    if (action === 'removaldone') return mutateAndRender(interaction, 'removal_actioned', first, second);
    if (action === 'cancelremoval') return mutateAndRender(interaction, 'cancel_removal', first, second);
    if (action === 'approverejoin') return mutateAndRender(interaction, 'approve_rejoin', first, second);
    if (action === 'senddm') return handleDirectMessage(interaction, first, second);
    if (action === 'togreg') return handleToggleRule(interaction, 'regularPerformanceEnabled');
    if (action === 'togcwl') return handleToggleRule(interaction, 'cwlPerformanceEnabled');
    if (action === 'toggaps') return handleToggleRule(interaction, 'missingDiscordEnabled');
    if (action === 'defroster') return handleDefaultRoster(interaction);

    if (action === 'ignore') {
        await beginBusyUpdate(interaction);
        const beforeIgnore = await service.loadWorkspace({ forcePrivate: true });
        assertCurrentCaseView(findItem(beforeIgnore, first), second);
        await service.setTrustedAccount(first, true, { seed: `${interaction.id}:ignore:${first}` });
        const workspace = await service.loadWorkspace({ forcePrivate: true });
        await interaction.editReply(views.asEditPayload(views.buildHomePayload(workspace, getConfig(interaction))));
        await refreshDashboardQuietly(interaction, workspace);
        return;
    }
    if (action === 'restore') {
        await beginBusyUpdate(interaction);
        const tag = interaction.values?.[0];
        await service.setTrustedAccount(tag, false, { seed: `${interaction.id}:restore:${tag}` });
        const workspace = await service.loadWorkspace({ forcePrivate: true });
        await interaction.editReply(views.asEditPayload(views.buildIgnoredPayload(workspace, { page: Number(first) || 0 })));
        await refreshDashboardQuietly(interaction, workspace);
        return;
    }

    throw new Error('Unsupported War Follow Up control.');
}

async function handleCaseModal(interaction, parsed) {
    const action = parsed.action;
    const [tagRaw, viewTokenRaw, rosterTokenRaw] = parsed.values;
    const userId = interaction.user?.id || interaction.member?.id || '';
    const savedContext = warFollowupStateStore.getModalContext(
        interaction.guildId,
        userId,
        interaction.customId
    );
    let workspace = null;
    let item = null;
    if (savedContext) {
        item = savedContext.item;
        workspace = {
            work: {
                directory: {
                    rosters: Array.isArray(savedContext.workspaceContext?.rosters)
                        ? savedContext.workspaceContext.rosters
                        : []
                }
            }
        };
    } else {
        // Compatibility for a modal opened just before a bot deployment. New
        // modals always have a durable context and do not need this read.
        await interaction.deferReply({ flags: views.EPHEMERAL });
        workspace = service.peekWorkspace() || await service.loadWorkspace({ forcePrivate: true });
        item = findItem(workspace, tagRaw);
    }
    assertCurrentCaseView(item, viewTokenRaw);
    const actor = service.getActorName(interaction);
    let mutationAction = '';
    let patch = {};

    if (action === 'contactform') {
        mutationAction = 'contact';
        assertCaseActionAllowed(item, mutationAction);
        patch = {
            dmText: String(interaction.fields.getTextInputValue('message') || '').trim(),
            suppressAutomaticReminder: ['no_response', 'reminder_failed'].includes(String(item.case?.contactStage || '').trim())
        };
        if (!patch.dmText) throw new Error('The contact message cannot be empty.');
    } else if (action === 'waitform') {
        mutationAction = 'wait';
        assertCaseActionAllowed(item, mutationAction);
        const followupHours = Number(String(interaction.fields.getTextInputValue('hours') || '').trim());
        if (![24, 48, 72].includes(followupHours)) throw new Error('Follow-up hours must be 24, 48, or 72.');
        patch = {
            followupHours,
            waitingReason: String(interaction.fields.getTextInputValue('reason') || '').trim().slice(0, 1000)
        };
    } else if (action === 'watchform') {
        mutationAction = 'watch';
        assertCaseActionAllowed(item, mutationAction);
        patch = {
            watchWarTarget: numberField(interaction, 'wars', 1, 8, 'Regular wars', true),
            handledBy: item.case?.handledBy || actor
        };
    } else if (action === 'removeform') {
        mutationAction = 'remove';
        assertCaseActionAllowed(item, mutationAction);
        const removalReason = String(interaction.fields.getTextInputValue('reason') || '').trim();
        const message = String(interaction.fields.getTextInputValue('message') || '').trim();
        if (!removalReason) throw new Error('The removal reason cannot be empty.');
        if (!message) throw new Error('The player notice cannot be empty.');
        patch = {
            removalReason,
            dmText: message,
            evidence: item.evidence,
            discordId: item.player?.discordId || item.case?.discordId || ''
        };
    } else if (action === 'resolveform') {
        mutationAction = 'resolve';
        assertCaseActionAllowed(item, mutationAction);
        const resolutionNote = String(interaction.fields.getTextInputValue('resolution') || '').trim();
        if (!resolutionNote) throw new Error('Add a short note explaining what resolved the case.');
        patch = { resolutionNote, evidence: item.evidence };
    } else if (action === 'heroform') {
        assertCaseActionAllowed(item, 'hero_down');
        const target = findRosterByToken(workspace, rosterTokenRaw);
        if (!target?.clanTag) throw new Error('The selected hero-down roster is no longer connected to a clan.');
        const message = String(interaction.fields.getTextInputValue('message') || '').trim();
        if (!message) throw new Error('The decision message cannot be empty.');
        mutationAction = 'hero_down';
        const reasonCodes = item.signals.map(signal => signal.reasonCode);
        patch = {
            targetRosterId: target.id,
            targetRosterTitle: target.title,
            targetClanTag: target.clanTag,
            recoveryWarTarget: numberField(interaction, 'wars', 1, 8, 'Clean wars', true),
            requireNoMisses: yesNoField(interaction, 'no_misses'),
            reasonCodes: reasonCodes.length ? reasonCodes : ['manual'],
            evidence: item.evidence,
            dmText: message,
            handledBy: item.case?.handledBy || actor
        };
    } else if (action === 'extendform') {
        const target = findRosterByToken(workspace, rosterTokenRaw);
        if (!target?.clanTag) throw new Error('The selected hero-down roster is no longer connected to a clan.');
        const message = String(interaction.fields.getTextInputValue('message') || '').trim();
        if (!message) throw new Error('The updated decision message cannot be empty.');
        mutationAction = 'extend';
        assertCaseActionAllowed(item, mutationAction);
        patch = {
            recoveryWarTarget: numberField(interaction, 'wars', 1, 8, 'Clean wars', true),
            requireNoMisses: yesNoField(interaction, 'no_misses'),
            dmText: message,
            targetRosterId: target.id,
            targetRosterTitle: target.title,
            targetClanTag: target.clanTag
        };
    } else if (action === 'noteform') {
        mutationAction = 'add_note';
        patch = { note: String(interaction.fields.getTextInputValue('note') || '').trim() };
        if (!patch.note) throw new Error('The private note cannot be empty.');
    } else if (action === 'markdmform') {
        mutationAction = 'mark_dm_sent';
        assertCaseActionAllowed(item, mutationAction);
        patch = {
            dmText: String(interaction.fields.getTextInputValue('message') || '').trim(),
            dmDeliveryMode: 'manual',
            dmMessageId: '',
            dmSentByDiscordId: interaction.user?.id || interaction.member?.id || '',
            dmSentByName: actor
        };
        if (!patch.dmText) throw new Error('The decision message cannot be empty.');
    } else if (action === 'assignform') {
        mutationAction = 'set_handler';
        patch = {
            handledBy: String(interaction.fields.getTextInputValue('handler') || '')
                .replace(/\s+/g, ' ')
                .trim()
                .slice(0, 80)
        };
    } else {
        throw new Error('Unsupported War Follow Up case form.');
    }

    const mutationId = service.mutationId(`${interaction.id}:${mutationAction}:${item.tag}`);
    const request = service.buildMutationRequest(item, mutationAction, patch, {
        actor,
        mutationId
    });
    let record = warFollowupStateStore.enqueueMutation(interaction.guildId, {
        id: mutationId,
        state: 'pending',
        action: mutationAction,
        tag: item.tag,
        actorId: userId,
        actorName: actor,
        draftPreview: draftPreviewForMutation(mutationAction, patch),
        request,
        attempts: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    });
    if (!interaction.deferred && !interaction.replied) {
        await interaction.deferReply({ flags: views.EPHEMERAL });
    }
    warFollowupStateStore.removeModalContext(interaction.guildId, userId, interaction.customId);
    await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));

    const outcome = await mutationOutbox.executeMutation(interaction.guildId, mutationId, {
        store: warFollowupStateStore,
        force: true
    });
    record = outcome.record || record;
    if (record.state === 'committed' && outcome.result) {
        const cachedWorkspace = service.peekWorkspace();
        if (cachedWorkspace?.rosterData) {
            const confirmedWorkspace = service.acceptConfirmedCase(cachedWorkspace, outcome.result);
            await interaction.editReply(views.asEditPayload(views.buildCasePayload(
                findItem(confirmedWorkspace, item.tag),
                confirmedWorkspace,
                getConfig(interaction)
            )));
            await refreshDashboardQuietly(interaction, confirmedWorkspace);
            return;
        }
    }
    await interaction.editReply(views.asEditPayload(views.buildMutationOutboxPayload(record)));
}

async function handleRulesModal(interaction, parsed) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const expectedRulesUpdatedAt = parsed.values[0] || '';
    let patch = {};

    if (parsed.action === 'regform') {
        patch = {
            regularLookbackWars: numberField(interaction, 'lookback', 1, 8, 'Recent wars', true),
            regularMissedThreshold: numberField(interaction, 'missed', 1, 16, 'Missed attacks', true),
            regularMinimumAttacks: numberField(interaction, 'minimum', 2, 32, 'Minimum attacks', true),
            regularAverageStarsThreshold: numberField(interaction, 'stars', 0.5, 3, 'Average stars'),
            regularAverageDestructionThreshold: numberField(interaction, 'destruction', 25, 100, 'Destruction')
        };
    } else if (parsed.action === 'cwlform') {
        patch = {
            cwlLookbackSeasons: numberField(interaction, 'lookback', 1, 8, 'Recent seasons', true),
            cwlMissedThreshold: numberField(interaction, 'missed', 1, 8, 'Missed attacks', true),
            cwlMinimumAttacks: numberField(interaction, 'minimum', 2, 24, 'Minimum attacks', true),
            cwlAverageStarsThreshold: numberField(interaction, 'stars', 0.5, 3, 'Average stars'),
            cwlAverageDestructionThreshold: numberField(interaction, 'destruction', 25, 100, 'Destruction')
        };
    } else if (parsed.action === 'flowform') {
        patch = {
            defaultRecoveryWars: numberField(interaction, 'recovery', 1, 8, 'Default clean wars', true),
            moderatorNames: Array.from(new Set(
                String(interaction.fields.getTextInputValue('moderators') || '')
                    .split(/\r?\n/)
                    .map(name => name.replace(/\s+/g, ' ').trim())
                    .filter(Boolean)
            )).slice(0, 40)
        };
    } else {
        throw new Error('Unsupported War Follow Up rules form.');
    }

    await service.saveRules(patch, expectedRulesUpdatedAt, {
        seed: `${interaction.id}:${parsed.action}`
    });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildRulesPayload(workspace)));
    await refreshDashboardQuietly(interaction, workspace);
}

async function handleWarFollowupInteraction(interaction) {
    if (!isWarFollowupCustomId(interaction.customId)) return false;

    try {
        if (!await authorize(interaction)) return true;
        const parsed = parseCustomId(interaction.customId);
        if (!parsed) throw new Error('Invalid War Follow Up control.');

        if (interaction.isModalSubmit?.()) {
            if (['regform', 'cwlform', 'flowform'].includes(parsed.action)) {
                await handleRulesModal(interaction, parsed);
            } else {
                await handleCaseModal(interaction, parsed);
            }
            return true;
        }

        await handleButtonOrSelect(interaction, parsed);
        return true;
    } catch (error) {
        await restoreBusyUpdate(interaction);
        await replyError(interaction, error, 'War Follow Up could not complete that action: ');
        return true;
    }
}

module.exports = {
    isEphemeralSource,
    numberField,
    yesNoField,
    assertCaseActionAllowed,
    directDmDeliveryKey,
    handleWarFollowupInteraction
};
