'use strict';

const { isStaffMember, canTakeAnyWarFollowupCase } = require('../permissions/staffPermissions');
const workflow = require('./workflow');
const service = require('./service');

const OPEN_CASE_STATUSES = new Set(['needs_review', 'waiting', 'needs_dm', 'removal_pending', 'hero_down', 'ready']);
const MEMBER_FETCH_CONCURRENCY = 4;
const INACTIVITY_REASSIGN_MS = 72 * 60 * 60 * 1000;
const REASSIGNMENT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function toText(value) {
    return value == null ? '' : String(value);
}

function moderatorDisplayName(member, fallback = 'Moderator') {
    return toText(member?.displayName || member?.user?.globalName || member?.user?.username || fallback)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80) || fallback;
}

function caseClanTag(itemRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    return workflow.normalizeTag(item.case?.sourceClanTag || item.player?.clanTag);
}

function isOpenItem(item) {
    return Boolean(item && OPEN_CASE_STATUSES.has(toText(item.status)));
}

async function mapWithConcurrency(items, mapper) {
    const input = Array.isArray(items) ? items : [];
    let nextIndex = 0;
    async function worker() {
        while (nextIndex < input.length) {
            const index = nextIndex;
            nextIndex += 1;
            await mapper(input[index]);
        }
    }
    await Promise.all(Array.from(
        { length: Math.min(MEMBER_FETCH_CONCURRENCY, input.length) },
        () => worker()
    ));
}

function createMemberResolver(guild) {
    const pending = new Map();
    return async discordId => {
        if (pending.has(discordId)) return pending.get(discordId);
        const request = (async () => {
            if (!guild?.members || typeof guild.members.fetch !== 'function') return null;
            const cached = guild.members.cache?.get?.(discordId);
            if (cached) return cached;
            try {
                return await guild.members.fetch({ user: discordId, cache: false, force: true });
            } catch {
                return null;
            }
        })();
        pending.set(discordId, request);
        return request;
    };
}

async function getEligibleModerators(guild, guildRecord, clanTagRaw, options = {}) {
    const clanTag = workflow.normalizeTag(clanTagRaw);
    if (!clanTag) return [];
    const resolveMember = options.resolveMember || createMemberResolver(guild);
    const preferences = Object.values(guildRecord?.moderators || {})
        .filter(preference =>
            preference?.accepting === true &&
            Array.isArray(preference.clanTags) &&
            preference.clanTags.map(workflow.normalizeTag).includes(clanTag)
        );
    const eligible = [];
    await mapWithConcurrency(preferences, async preference => {
        const member = await resolveMember(preference.discordId);
        if (!member || !isStaffMember(member)) return;
        eligible.push({
            ...preference,
            displayName: moderatorDisplayName(member, preference.displayName || preference.discordId),
            member
        });
    });
    return eligible.sort((left, right) => left.discordId.localeCompare(right.discordId));
}

function openCaseCounts(itemsRaw) {
    const counts = {};
    for (const item of Array.isArray(itemsRaw) ? itemsRaw : []) {
        if (!isOpenItem(item)) continue;
        const moderatorId = toText(item.case?.assignedModeratorId).trim();
        if (moderatorId) counts[moderatorId] = (counts[moderatorId] || 0) + 1;
    }
    return counts;
}

function chooseModerator(eligibleRaw, itemsRaw, options = {}) {
    let candidates = Array.isArray(eligibleRaw) ? eligibleRaw.slice() : [];
    const avoidModeratorId = toText(options.avoidModeratorId).trim();
    if (avoidModeratorId && candidates.some(candidate => candidate.discordId !== avoidModeratorId)) {
        candidates = candidates.filter(candidate => candidate.discordId !== avoidModeratorId);
    }
    const blockedModeratorId = toText(options.blockedModeratorId).trim();
    const blockedUntilMs = workflow.parseMs(options.blockedUntil);
    const nowMs = Number(options.nowMs) || Date.now();
    if (blockedModeratorId && blockedUntilMs > nowMs) {
        candidates = candidates.filter(candidate => candidate.discordId !== blockedModeratorId);
    }
    const counts = openCaseCounts(itemsRaw);
    return candidates.sort((left, right) =>
        (counts[left.discordId] || 0) - (counts[right.discordId] || 0) ||
        (workflow.parseMs(left.lastAssignedAt) || 0) - (workflow.parseMs(right.lastAssignedAt) || 0) ||
        left.discordId.localeCompare(right.discordId)
    )[0] || null;
}

function replaceCase(workspace, caseValue) {
    const cases = Array.isArray(workspace?.privateState?.cases) ? workspace.privateState.cases : [];
    const nextCases = cases.filter(entry => workflow.normalizeTag(entry?.tag) !== workflow.normalizeTag(caseValue?.tag));
    nextCases.push(caseValue);
    workspace.privateState.cases = nextCases;
    workspace.work = workflow.buildWorkItems(workspace.rosterData, workspace.privateState);
    return workspace.work.items.find(item => item.tag === workflow.normalizeTag(caseValue?.tag)) || null;
}

function assignmentPatch(moderator, options = {}) {
    return moderator ? {
        assignedModeratorId: moderator.discordId,
        assignedModeratorName: moderator.displayName,
        handledBy: moderator.displayName,
        assignmentCoverageOverride: options.outsideCoverage === true
    } : {};
}

async function mutateAndReplace(workspace, item, action, patch, seed) {
    const result = await service.mutateCase(item, action, patch, {
        actor: 'War Follow Up',
        seed
    });
    return replaceCase(workspace, result);
}

async function synchronizeModerationCases(guild, guildId, workspaceRaw, store, options = {}) {
    const workspace = workspaceRaw;
    const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
    const nowMs = Number.isFinite(now.getTime()) ? now.getTime() : Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const resolveMember = createMemberResolver(guild);
    const mutations = [];

    const tags = Array.from(new Set((workspace?.work?.items || []).map(item => item.tag)));
    for (const tag of tags) {
        let item = workspace.work.items.find(candidate => candidate.tag === tag);
        if (!item) continue;
        const clanTag = caseClanTag(item);
        const guildRecord = store.getGuild(guildId);
        const eligible = await getEligibleModerators(guild, guildRecord, clanTag, { resolveMember });
        const currentPlayer = workspace?.work?.directory?.byTag?.[tag] || null;

        if (item.case?.status === 'watching') {
            if (item.status === 'needs_review' && item.signals?.length) {
                const chosen = chooseModerator(eligible, workspace.work.items, { nowMs });
                item = await mutateAndReplace(workspace, item, 'watch_triggered', {
                    reasonCodes: item.signals.map(signal => signal.reasonCode),
                    triggerSignalIds: item.signalIds,
                    evidence: item.watching?.evidence || item.evidence,
                    ...assignmentPatch(chosen)
                }, `scheduler:watch-triggered:${tag}:${workflow.buildCaseFingerprint(item)}:${chosen?.discordId || 'unassigned'}`);
                if (chosen) store.recordModeratorAssignment(guildId, chosen.discordId, item.case?.assignedAt || nowIso);
                mutations.push({ tag, action: 'watch_triggered', moderatorId: chosen?.discordId || '' });
            } else if (item.status === 'closed' && item.watching?.ready) {
                item = await mutateAndReplace(
                    workspace,
                    item,
                    'watch_complete',
                    {},
                    `scheduler:watch-complete:${tag}:${item.case.updatedAt}:${item.watching.completedWars}`
                );
                mutations.push({ tag, action: 'watch_complete', moderatorId: '' });
            }
        }

        if (item?.case?.status === 'removal_pending' && !currentPlayer) {
            item = await mutateAndReplace(
                workspace,
                item,
                'removal_confirmed',
                {},
                `scheduler:removal-confirmed:${tag}:${item.case.updatedAt}`
            );
            mutations.push({ tag, action: 'removal_confirmed', moderatorId: item.case?.assignedModeratorId || '' });
        } else if (item?.case?.status === 'removed' && item.removalRejoinDetected && currentPlayer) {
            item = await mutateAndReplace(workspace, item, 'removal_rejoined', {
                rejoinRosterId: currentPlayer.rosterId,
                rejoinRosterTitle: currentPlayer.rosterTitle,
                rejoinClanTag: currentPlayer.clanTag
            }, `scheduler:removal-rejoined:${tag}:${item.case.removalAbsentObservedAt}:${currentPlayer.rosterId || currentPlayer.clanTag}`);
            mutations.push({ tag, action: 'removal_rejoined', moderatorId: item.case?.assignedModeratorId || '' });
        }

        const virtualAutomaticCase = !item.case && item.signals?.length > 0;
        const reopenedAutomaticCase = item.case && ['closed', 'dismissed'].includes(item.case.status) && item.status === 'needs_review';
        if (virtualAutomaticCase || reopenedAutomaticCase) {
            const chosen = chooseModerator(eligible, workspace.work.items, { nowMs });
            item = await mutateAndReplace(workspace, item, 'create_automatic', {
                sourceRosterId: item.player?.rosterId || '',
                sourceRosterTitle: item.player?.rosterTitle || '',
                sourceClanTag: workflow.normalizeTag(item.player?.clanTag),
                reasonCodes: item.signals.map(signal => signal.reasonCode),
                triggerSignalIds: item.signalIds,
                evidence: item.evidence,
                ...assignmentPatch(chosen)
            }, `scheduler:create:${tag}:${workflow.buildCaseFingerprint(item)}:${chosen?.discordId || 'unassigned'}`);
            if (chosen) store.recordModeratorAssignment(guildId, chosen.discordId, item.case?.assignedAt || nowIso);
            mutations.push({ tag, action: 'create_automatic', moderatorId: chosen?.discordId || '' });
        }

        if (!item?.case || !isOpenItem(item)) continue;

        if (
            item.case.status === 'waiting' &&
            workflow.parseMs(item.case.waitingUntil) > 0 &&
            workflow.parseMs(item.case.waitingUntil) <= nowMs
        ) {
            const botManagedContact = item.case.contactPurpose === 'general' &&
                item.case.dmDeliveryMode === 'bot' &&
                item.case.dmMessageId;
            if (botManagedContact) continue;
            item = await mutateAndReplace(
                workspace,
                item,
                'waiting_due',
                {},
                `scheduler:waiting-due:${tag}:${item.case.waitingUntil}`
            );
            mutations.push({ tag, action: 'waiting_due', moderatorId: item.case?.assignedModeratorId || '' });
        }

        const assignedModeratorId = toText(item.case.assignedModeratorId).trim();
        if (assignedModeratorId) {
            const assignedEligible = eligible.find(candidate => candidate.discordId === assignedModeratorId);
            const assignedMember = item.case.assignmentCoverageOverride === true
                ? await resolveMember(assignedModeratorId)
                : null;
            const validCoverageOverride = Boolean(
                item.case.assignmentCoverageOverride === true &&
                assignedMember &&
                isStaffMember(assignedMember) &&
                canTakeAnyWarFollowupCase(assignedMember)
            );
            const waitingUntilMs = workflow.parseMs(item.case.waitingUntil);
            const hasFutureWaitingFollowup = item.case.status === 'waiting' && waitingUntilMs > nowMs;
            const anchorMs = workflow.parseMs(
                item.case.lastMeaningfulActionAt || item.case.assignedAt || item.case.updatedAt
            );
            const inactiveForMs = anchorMs > 0 ? nowMs - anchorMs : 0;
            if ((!assignedEligible && !validCoverageOverride) || (!hasFutureWaitingFollowup && inactiveForMs >= INACTIVITY_REASSIGN_MS)) {
                const chosen = chooseModerator(eligible, workspace.work.items, {
                    avoidModeratorId: assignedModeratorId,
                    nowMs
                });
                if (chosen && chosen.discordId !== assignedModeratorId) {
                    item = await mutateAndReplace(
                        workspace,
                        item,
                        'assign_owner',
                        assignmentPatch(chosen),
                        `scheduler:reassign:${tag}:${item.case.updatedAt}:${chosen.discordId}`
                    );
                    store.recordModeratorAssignment(guildId, chosen.discordId, item.case?.assignedAt || nowIso);
                    mutations.push({ tag, action: 'reassign', moderatorId: chosen.discordId });
                } else {
                    const blockedUntil = new Date(nowMs + REASSIGNMENT_COOLDOWN_MS).toISOString();
                    item = await mutateAndReplace(workspace, item, 'unassign_owner', {
                        blockedModeratorId: inactiveForMs >= INACTIVITY_REASSIGN_MS ? assignedModeratorId : '',
                        blockedUntil: inactiveForMs >= INACTIVITY_REASSIGN_MS ? blockedUntil : ''
                    }, `scheduler:unassign:${tag}:${item.case.updatedAt}:${assignedModeratorId}`);
                    mutations.push({ tag, action: 'unassign', moderatorId: '' });
                }
            }
            continue;
        }

        // Preserve legacy free-text assignments until a leader explicitly
        // replaces them; they cannot be safely mapped to a Discord account.
        if (toText(item.case.handledBy).trim()) continue;
        const chosen = chooseModerator(eligible, workspace.work.items, {
            blockedModeratorId: item.case.assignmentBlockedModeratorId,
            blockedUntil: item.case.assignmentBlockedUntil,
            nowMs
        });
        if (!chosen) continue;
        item = await mutateAndReplace(
            workspace,
            item,
            'assign_owner',
            assignmentPatch(chosen),
            `scheduler:assign:${tag}:${item.case.updatedAt}:${chosen.discordId}`
        );
        store.recordModeratorAssignment(guildId, chosen.discordId, item.case?.assignedAt || nowIso);
        mutations.push({ tag, action: 'assign', moderatorId: chosen.discordId });
    }

    return { workspace, mutations };
}

module.exports = {
    OPEN_CASE_STATUSES,
    INACTIVITY_REASSIGN_MS,
    REASSIGNMENT_COOLDOWN_MS,
    moderatorDisplayName,
    caseClanTag,
    isOpenItem,
    createMemberResolver,
    getEligibleModerators,
    openCaseCounts,
    chooseModerator,
    assignmentPatch,
    replaceCase,
    synchronizeModerationCases
};
