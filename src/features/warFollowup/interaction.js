'use strict';

const { isStaffMember } = require('../permissions/staffPermissions');
const workflow = require('./workflow');
const service = require('./service');
const views = require('./views');
const { isWarFollowupCustomId, parseCustomId } = require('./customIds');
const { warFollowupStateStore } = require('./stateStore');
const { ensureDashboard } = require('./dashboard');

const directDmInFlight = new Set();

function isEphemeralSource(interaction) {
    const flags = Number(interaction?.message?.flags?.bitfield ?? interaction?.message?.flags ?? 0);
    return (flags & views.EPHEMERAL) === views.EPHEMERAL;
}

async function replyError(interaction, error, prefix = '') {
    const detail = String(error?.message || error || 'Unknown error').slice(0, 1500);
    const payload = {
        content: `${prefix}${detail}`,
        flags: views.EPHEMERAL,
        allowedMentions: { parse: [] }
    };
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
    const allowedStatuses = {
        dismiss: ['needs_review', 'watching'],
        watch: ['needs_review'],
        hero_down: ['needs_review'],
        mark_dm_sent: ['needs_dm'],
        reopen: ['needs_dm', 'watching', 'closed'],
        extend: ['hero_down', 'ready'],
        close: ['hero_down', 'ready']
    };
    if (action === 'approve_return') {
        if (status !== 'ready' || item?.recovery?.ready !== true) {
            throw new Error('This player has not completed the required recovery period.');
        }
        return;
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
        ['hero_down_decision', 'extended'].includes(String(entry?.type || ''))
    );
    const decisionRevision = workflow.stableRevision(JSON.stringify({
        decisionActivity: decisionActivity
            ? [decisionActivity.id || '', decisionActivity.at || '', decisionActivity.type || '']
            : [],
        dmText: String(caseValue.dmText || ''),
        targetRosterId: String(caseValue.targetRosterId || ''),
        targetClanTag: workflow.normalizeTag(caseValue.targetClanTag),
        recoveryWarTarget: Number(caseValue.recoveryWarTarget) || 0,
        requireNoMisses: caseValue.requireNoMisses !== false
    }));
    return `direct-dm:${workflow.normalizeTag(item.tag)}:${decisionRevision}`;
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
}

async function renderView(interaction, buildPayload, options = {}) {
    const updateExisting = isEphemeralSource(interaction);
    if (updateExisting) await interaction.deferUpdate();
    else await interaction.deferReply({ flags: views.EPHEMERAL });

    const workspace = await service.loadWorkspace({ forcePrivate: options.forcePrivate === true });
    const payload = buildPayload(workspace, getConfig(interaction));
    await interaction.editReply(views.asEditPayload(payload));
    return workspace;
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
    await interaction.showModal(modal);
}

async function mutateAndRender(interaction, action, tagRaw, viewTokenRaw, patch = {}) {
    await interaction.deferUpdate();
    const actor = service.getActorName(interaction);
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    const item = findItem(workspace, tagRaw);
    assertCurrentCaseView(item, viewTokenRaw);
    assertCaseActionAllowed(item, action);
    await service.mutateCase(item, action, patch, {
        actor,
        seed: `${interaction.id}:${action}:${item.tag}`
    });
    workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, getConfig(interaction))));
    await refreshDashboardQuietly(interaction, workspace);
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
    await interaction.deferUpdate();
    let dmDelivered = false;
    let deliveryReserved = false;
    let caseMarkedSent = false;
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    let item = findItem(workspace, tagRaw);
    let config = getConfig(interaction);
    assertCurrentCaseView(item, viewTokenRaw);
    if (item.status !== 'needs_dm') throw new Error('This follow-up is not waiting for a DM.');
    if (!config.features.directMessages) throw new Error('Direct DMs are not opted in for this server.');
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
        const message = String(item.case?.dmText || '').trim();
        if (!message) throw new Error('The prepared decision message is empty.');
        if (message.length > 2000) {
            throw new Error('The prepared decision message exceeds Discord\'s 2,000-character limit. Reopen the decision and shorten it first.');
        }
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
        await service.mutateCase(item, 'mark_dm_sent', { dmText: message }, {
            actor: service.getActorName(interaction),
            seed: `${interaction.id}:send-dm:${item.tag}`
        });
        caseMarkedSent = true;
        workspace = await service.loadWorkspace({ forcePrivate: true });
        await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, config)));
        await interaction.followUp({
            content: `Decision DM sent to <@${item.player.discordId}> and the recovery period is now active.`,
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
    await interaction.deferUpdate();
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
    await interaction.deferUpdate();
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

    if (action === 'home' || action === 'refresh') {
        await renderView(interaction, (workspace, config) => views.buildHomePayload(workspace, config), {
            forcePrivate: action === 'refresh'
        });
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
        await renderView(interaction, (workspace, config) => views.buildCasePayload(findItem(workspace, tag), workspace, config));
        return;
    }
    if (action === 'case') {
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
        await showCachedModal(interaction, workspace => {
            const item = findItem(workspace, first);
            assertCurrentCaseView(item, second);
            return item ? views.buildAssignmentModal(item) : null;
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
    if (action === 'dismiss') return mutateAndRender(interaction, 'dismiss', first, second);
    if (action === 'reopen') return mutateAndRender(interaction, 'reopen', first, second);
    if (action === 'approve') return mutateAndRender(interaction, 'approve_return', first, second);
    if (action === 'close') return mutateAndRender(interaction, 'close', first, second, { outcome: 'no_return' });
    if (action === 'senddm') return handleDirectMessage(interaction, first, second);
    if (action === 'togreg') return handleToggleRule(interaction, 'regularPerformanceEnabled');
    if (action === 'togcwl') return handleToggleRule(interaction, 'cwlPerformanceEnabled');
    if (action === 'toggaps') return handleToggleRule(interaction, 'missingDiscordEnabled');
    if (action === 'defroster') return handleDefaultRoster(interaction);

    if (action === 'ignore') {
        await interaction.deferUpdate();
        const beforeIgnore = await service.loadWorkspace({ forcePrivate: true });
        assertCurrentCaseView(findItem(beforeIgnore, first), second);
        await service.setTrustedAccount(first, true, { seed: `${interaction.id}:ignore:${first}` });
        const workspace = await service.loadWorkspace({ forcePrivate: true });
        await interaction.editReply(views.asEditPayload(views.buildHomePayload(workspace, getConfig(interaction))));
        await refreshDashboardQuietly(interaction, workspace);
        return;
    }
    if (action === 'restore') {
        await interaction.deferUpdate();
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
    await interaction.deferReply({ flags: views.EPHEMERAL });
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    const item = findItem(workspace, tagRaw);
    assertCurrentCaseView(item, viewTokenRaw);
    const actor = service.getActorName(interaction);
    let mutationAction = '';
    let patch = {};

    if (action === 'watchform') {
        mutationAction = 'watch';
        assertCaseActionAllowed(item, mutationAction);
        patch = {
            watchWarTarget: numberField(interaction, 'wars', 1, 8, 'Regular wars', true),
            handledBy: item.case?.handledBy || actor
        };
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
        patch = { dmText: String(interaction.fields.getTextInputValue('message') || '').trim() };
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

    await service.mutateCase(item, mutationAction, patch, {
        actor,
        seed: `${interaction.id}:${mutationAction}:${item.tag}`
    });
    workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildCasePayload(findItem(workspace, item.tag), workspace, getConfig(interaction))));
    await refreshDashboardQuietly(interaction, workspace);
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
