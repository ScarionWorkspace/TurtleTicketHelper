'use strict';

const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const workflow = require('./workflow');
const { buildCustomId } = require('./customIds');
const { isPlayerReplyCaptureEnabled } = require('./stateStore');

const COLORS = Object.freeze({
    neutral: 0x5865f2,
    review: 0xf59e0b,
    danger: 0xed4245,
    success: 0x57f287,
    cwl: 0x9b59b6,
    closed: 0x95a5a6
});
const EPHEMERAL = 64;
const PAGE_SIZE = 25;
const MODERATION_HUB_UI_REVISION = 2;
const ACTIVE_CASE_STATUSES = new Set(['needs_review', 'waiting', 'needs_dm', 'removal_pending', 'hero_down', 'ready']);

function toText(value) {
    return value == null ? '' : String(value);
}

function truncate(value, maxLength, suffix = '…') {
    const text = toText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - suffix.length))}${suffix}`;
}

function safeInline(value) {
    return toText(value)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\s+/g, ' ')
        .trim();
}

function safeMultiline(value) {
    return toText(value)
        .replace(/[`*_~|>\[\]\\]/g, '\\$&')
        .replace(/@/g, '@\u200b')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function rosterToken(rosterIdRaw) {
    return workflow.stableRevision(toText(rosterIdRaw).trim());
}

function caseToken(itemRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    return workflow.stableRevision([
        workflow.buildCaseFingerprint(item),
        toText(item.case?.updatedAt),
        toText(item.player?.discordId),
        toText(item.player?.rosterId),
        toText(item.player?.name)
    ].join('|'));
}

function statusCounts(work) {
    const counts = Object.fromEntries(workflow.STATUS_ORDER.map(status => [status, 0]));
    for (const item of Array.isArray(work?.items) ? work.items : []) {
        if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
    }
    return counts;
}

function pendingAttackCounts(rosterData) {
    let regularPlayers = 0;
    let regularAttacks = 0;
    let cwlPlayers = 0;
    for (const roster of Array.isArray(rosterData?.rosters) ? rosterData.rosters : []) {
        if (toText(roster?.regularWar?.currentWar?.state).toLowerCase() === 'inwar') {
            for (const value of Object.values(roster?.regularWar?.byTag || {})) {
                const remaining = Number(value?.current?.attacksRemaining || 0);
                if (value?.current?.inWar === true && remaining > 0) {
                    regularPlayers += 1;
                    regularAttacks += remaining;
                }
            }
        }
        if (toText(roster?.cwlStats?.currentWar?.state).toLowerCase() === 'inwar') {
            cwlPlayers += Object.values(roster?.cwlStats?.byTag || {})
                .filter(stats => Number(stats?.currentWarAttackPending) > 0).length;
        }
    }
    return { regularPlayers, regularAttacks, cwlPlayers };
}

function discordGapCount(work) {
    return (Array.isArray(work?.directory?.players) ? work.directory.players : [])
        .filter(player => !player.discordId && !player.trusted)
        .length;
}

function actionButton(action, label, style = ButtonStyle.Secondary, ...values) {
    return new ButtonBuilder()
        .setCustomId(buildCustomId(action, ...values))
        .setLabel(label)
        .setStyle(style);
}

function asEditPayload(payloadRaw) {
    const payload = payloadRaw && typeof payloadRaw === 'object' ? payloadRaw : {};
    const { flags, ...editable } = payload;
    return editable;
}

function navigationRow() {
    return new ActionRowBuilder().addComponents(
        actionButton('home', 'Queue', ButtonStyle.Secondary),
        actionButton('gaps', 'Discord gaps', ButtonStyle.Secondary),
        actionButton('rules', 'Rules', ButtonStyle.Secondary),
        actionButton('ignored', 'Ignored', ButtonStyle.Secondary),
        actionButton('refresh', 'Refresh', ButtonStyle.Primary)
    );
}

function moderationNavigationRow() {
    return new ActionRowBuilder().addComponents(
        actionButton('mycases', 'My cases', ButtonStyle.Secondary),
        actionButton('attention', 'Needs attention', ButtonStyle.Secondary, '0'),
        actionButton('recent', 'Recent activity', ButtonStyle.Secondary, '0')
    );
}

function connectedRosters(workspace) {
    const seenClanTags = new Set();
    return (workspace?.work?.directory?.rosters || []).filter(roster => {
        const clanTag = workflow.normalizeTag(roster.clanTag);
        if (!clanTag || seenClanTags.has(clanTag)) return false;
        seenClanTags.add(clanTag);
        return true;
    });
}

function moderationAttentionItems(workspace, guildRecord, nowRaw = new Date()) {
    const summary = moderationCaseSummary(workspace, guildRecord, nowRaw);
    const unassigned = new Set(summary.unassigned);
    const overdue = new Set(summary.overdue);
    const nowMs = nowRaw instanceof Date ? nowRaw.getTime() : new Date(nowRaw).getTime();
    const priority = new Map([
        ['Unassigned', 0],
        ['Delivery failed', 1],
        ['Overdue', 2],
        ['Escalated', 3],
        ['Player replied', 4],
        ['Follow-up due', 5]
    ]);
    const entries = [];
    for (const item of summary.items) {
        const caseValue = item.case || {};
        const reasons = [];
        const meaningfulAt = workflow.parseMs(caseValue.lastMeaningfulActionAt || caseValue.updatedAt);
        const waitingUntilMs = workflow.parseMs(caseValue.waitingUntil);
        const waitingDue = item.status === 'waiting' && waitingUntilMs > 0 && waitingUntilMs <= nowMs;
        const isCurrentEvent = timestamp => {
            const eventAt = workflow.parseMs(timestamp);
            return eventAt > 0 && (!meaningfulAt || eventAt >= meaningfulAt);
        };
        if (unassigned.has(item)) reasons.push('Unassigned');
        if (overdue.has(item) && !waitingDue) reasons.push('Overdue');
        if (isCurrentEvent(caseValue.dmDeliveryFailedAt) || isCurrentEvent(caseValue.contactReminderFailedAt)) {
            reasons.push('Delivery failed');
        }
        if (isCurrentEvent(caseValue.escalatedAt)) reasons.push('Escalated');
        if (caseValue.contactStage === 'responded' && isCurrentEvent(caseValue.playerResponseAt)) {
            reasons.push('Player replied');
        }
        if (waitingDue) reasons.push('Follow-up due');
        const uniqueReasons = Array.from(new Set(reasons));
        if (!uniqueReasons.length) continue;
        entries.push({
            item,
            reasons: uniqueReasons,
            priority: Math.min(...uniqueReasons.map(reason => priority.get(reason) ?? 99)),
            at: Math.max(
                meaningfulAt,
                workflow.parseMs(caseValue.playerResponseAt),
                workflow.parseMs(caseValue.escalatedAt),
                workflow.parseMs(caseValue.dmDeliveryFailedAt),
                workflow.parseMs(caseValue.contactReminderFailedAt),
                waitingUntilMs
            )
        });
    }
    return entries.sort((left, right) =>
        left.priority - right.priority ||
        right.at - left.at ||
        left.item.tag.localeCompare(right.item.tag)
    );
}

function buildModerationHubPayload(workspace, guildRecord, options = {}) {
    const rosters = connectedRosters(workspace);
    const moderators = Object.values(guildRecord?.moderators || {});
    const summary = moderationCaseSummary(workspace, guildRecord, options.now || new Date());
    const pending = pendingAttackCounts(workspace?.rosterData);
    const activeModerators = moderators.filter(moderator => moderator.accepting && moderator.clanTags?.length);
    const coverageLines = rosters.map(roster => {
        const clanTag = workflow.normalizeTag(roster.clanTag);
        const subscribed = moderators.filter(moderator =>
            (moderator.clanTags || []).map(workflow.normalizeTag).includes(clanTag)
        );
        const accepting = subscribed.filter(moderator => moderator.accepting);
        const indicator = accepting.length ? '🟢' : (subscribed.length ? '🟡' : '🔴');
        const detail = accepting.length
            ? `${accepting.length} leader${accepting.length === 1 ? '' : 's'}${subscribed.length > accepting.length ? ` · ${subscribed.length - accepting.length} paused` : ''}`
            : (subscribed.length ? `${subscribed.length} paused` : 'needs coverage');
        return `${indicator} **${safeInline(roster.title || clanTag)}** · ${detail}`;
    });
    const coveredClanCount = rosters.filter(roster => moderators.some(moderator =>
        moderator.accepting &&
        (moderator.clanTags || []).map(workflow.normalizeTag).includes(workflow.normalizeTag(roster.clanTag))
    )).length;
    const snapshot = workflow.discordRelativeTimestamp(workspace?.rosterData?.lastUpdatedAt);
    const attention = summary.actionable.length + summary.unassigned.length + summary.overdue.length;
    const attentionItems = moderationAttentionItems(workspace, guildRecord, options.now || new Date());
    const stateParts = [
        summary.awaitingPlayer.length ? `**${summary.awaitingPlayer.length} awaiting player repl${summary.awaitingPlayer.length === 1 ? 'y' : 'ies'}**` : '',
        summary.scheduledWaiting.length ? `**${summary.scheduledWaiting.length} scheduled follow-up${summary.scheduledWaiting.length === 1 ? '' : 's'}**` : '',
        summary.heroDownRecovery.length ? `**${summary.heroDownRecovery.length} hero-down recover${summary.heroDownRecovery.length === 1 ? 'y' : 'ies'}**` : '',
        summary.awaitingRemovalConfirmation.length ? `**${summary.awaitingRemovalConfirmation.length} awaiting removal confirmation**` : ''
    ].filter(Boolean);
    const regularStatus = pending.regularAttacks
        ? `**${pending.regularAttacks} attack${pending.regularAttacks === 1 ? '' : 's'} pending** · ${pending.regularPlayers} player${pending.regularPlayers === 1 ? '' : 's'}`
        : '**No attacks pending**';
    const cwlStatus = pending.cwlPlayers
        ? `**${pending.cwlPlayers} attack${pending.cwlPlayers === 1 ? '' : 's'} pending**`
        : '**No attacks pending**';
    const semantic = JSON.stringify({
        uiRevision: MODERATION_HUB_UI_REVISION,
        rosters: rosters.map(roster => [roster.id, roster.title, workflow.normalizeTag(roster.clanTag)]),
        moderators: moderators.map(moderator => [
            moderator.discordId,
            moderator.accepting,
            moderator.clanTags
        ]).sort((left, right) => left[0].localeCompare(right[0])),
        cases: {
            tracked: summary.items.length,
            actionable: summary.actionable.length,
            assigned: summary.assigned.length,
            unassigned: summary.unassigned.length,
            awaitingPlayer: summary.awaitingPlayer.length,
            scheduledWaiting: summary.scheduledWaiting.length,
            heroDownRecovery: summary.heroDownRecovery.length,
            awaitingRemovalConfirmation: summary.awaitingRemovalConfirmation.length,
            overdue: summary.overdue.length,
            needsAttention: attentionItems.length
        },
        pending,
        notificationChannelId: guildRecord?.config?.channelId || '',
        lastUpdatedAt: workspace?.rosterData?.lastUpdatedAt || ''
    });
    const embed = new EmbedBuilder()
        .setColor(attention || coveredClanCount < rosters.length ? COLORS.review : COLORS.success)
        .setTitle('Moderation Hub')
        .setDescription([
            '**Choose the clans you help moderate, then turn on new assignments.**',
            'Your settings and cases open privately.'
        ].join('\n'))
        .addFields(
            {
                name: 'Clan coverage',
                value: truncate(coverageLines.join('\n') || 'No connected clan rosters are currently available.', 1024)
            },
            {
                name: 'Current workload',
                value: [
                    `Cases: **${summary.items.length} tracked** · **${summary.actionable.length} actionable**`,
                    `State: ${stateParts.join(' · ') || '**Nothing waiting or active**'}`,
                    `Ownership: **${summary.assigned.length} assigned** · **${summary.unassigned.length} unassigned** · **${summary.overdue.length} overdue**`,
                    `Coverage: **${activeModerators.length} active leader${activeModerators.length === 1 ? '' : 's'}** · **${coveredClanCount}/${rosters.length} clans**`
                ].join('\n')
            },
            {
                name: 'War activity',
                value: [
                    `Regular war: ${regularStatus}`,
                    `CWL: ${cwlStatus}`,
                    [
                        snapshot ? `Data updated ${snapshot}` : 'Update time unavailable',
                        guildRecord?.config?.channelId ? `Notifications <#${guildRecord.config.channelId}>` : ''
                    ].filter(Boolean).join(' · ')
                ].join('\n')
            }
        );

    return {
        payload: {
            content: '',
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(
                    actionButton('mycases', 'My cases', ButtonStyle.Primary).setEmoji('📥'),
                    actionButton('modsettings', 'Choose clans', ButtonStyle.Primary).setEmoji('⚙️')
                ),
                new ActionRowBuilder().addComponents(
                    actionButton('attention', `Needs attention (${attentionItems.length})`, attentionItems.length ? ButtonStyle.Danger : ButtonStyle.Secondary, '0'),
                    actionButton('recent', 'Recent activity', ButtonStyle.Secondary, '0'),
                    actionButton('home', 'All cases', ButtonStyle.Secondary)
                ),
                new ActionRowBuilder().addComponents(
                    actionButton('gaps', 'Discord gaps', ButtonStyle.Secondary),
                    actionButton('rules', 'Rules', ButtonStyle.Secondary),
                    actionButton('ignored', 'Ignored', ButtonStyle.Secondary)
                )
            ],
            allowedMentions: { parse: [] }
        },
        semanticHash: workflow.stableRevision(semantic)
    };
}

function buildDashboardPayload(workspace, config) {
    const work = workspace?.work || {};
    const counts = statusCounts(work);
    const pending = pendingAttackCounts(workspace?.rosterData);
    const gaps = discordGapCount(work);
    const actionable = counts.needs_review + counts.needs_dm + counts.removal_pending + counts.ready;
    const featuresEnabled = Object.entries(config?.features || {})
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key);
    const semantic = JSON.stringify({ counts, pending, gaps, featuresEnabled, enabled: config?.enabled === true });
    const embed = new EmbedBuilder()
        .setColor(actionable > 0 ? COLORS.review : COLORS.success)
        .setTitle('War Follow Up')
        .setDescription(
            actionable > 0
                ? `**${actionable} action${actionable === 1 ? '' : 's'} need staff attention.**`
                : 'The follow-up queue has no action due right now.'
        )
        .addFields(
            {
                name: 'Workflow',
                value: [
                    `Waiting: **${counts.waiting}**`,
                    `🔎 Review: **${counts.needs_review}**`,
                    `✉️ Needs DM: **${counts.needs_dm}**`,
                    `🚫 Removal: **${counts.removal_pending}**`,
                    `🛡️ Hero-down: **${counts.hero_down}**`,
                    `✅ Ready: **${counts.ready}**`,
                    `👀 Watching: **${counts.watching}**`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Live wars',
                value: [
                    `Regular: **${pending.regularAttacks}** attacks / ${pending.regularPlayers} players`,
                    `CWL: **${pending.cwlPlayers}** attacks pending`,
                    `Discord gaps: **${gaps}**`
                ].join('\n'),
                inline: true
            },
            {
                name: 'Opt-in automation',
                value: featuresEnabled.length
                    ? `${featuresEnabled.length} notification categor${featuresEnabled.length === 1 ? 'y' : 'ies'} enabled. Use \`/war-follow-up setup\` to change them.`
                    : 'Dashboard only. Every notification category is off until explicitly enabled with `/war-follow-up setup`.'
            }
        )
        .setFooter({ text: 'Private moderation details only appear in staff-only responses.' });

    return {
        payload: {
            content: '',
            embeds: [embed],
            components: [navigationRow()],
            allowedMentions: { parse: [] }
        },
        semanticHash: workflow.stableRevision(semantic)
    };
}

function normalizeStatusFilter(value) {
    const status = toText(value).trim();
    return workflow.STATUS_ORDER.includes(status) ? status : 'all';
}

function filteredItems(work, statusRaw) {
    const status = normalizeStatusFilter(statusRaw);
    const items = Array.isArray(work?.items) ? work.items : [];
    return status === 'all' ? items : items.filter(item => item.status === status);
}

function caseOption(item) {
    const removalEvasion = item.case?.status === 'removal_evasion' || item.removalRejoinDetected === true;
    const meta = removalEvasion
        ? { label: 'Removal evasion', next: 'Remove the player again or approve their return', emoji: '🚨' }
        : casePresentation(item);
    const description = item.signals?.length
        ? item.signals.map(signal => signal.title).join(', ')
        : meta.next;
    return new StringSelectMenuOptionBuilder()
        .setLabel(truncate(`${meta.emoji} ${item.player?.name || item.tag}`, 100))
        .setDescription(truncate(`${meta.label} · ${description}`, 100))
        .setValue(item.tag);
}

const ACTIVITY_PRESENTATION = Object.freeze({
    automatic_case: ['\uD83D\uDD0E', 'Opened automatically'],
    manual_review: ['\uD83D\uDD0E', 'Opened for review'],
    assigned: ['\uD83D\uDCE5', 'Changed assignment'],
    unassigned: ['\uD83D\uDCE4', 'Cleared assignment'],
    handler: ['\uD83D\uDCE5', 'Changed assignment'],
    dismissed: ['\u2705', 'Closed with no action'],
    watching: ['\uD83D\uDC40', 'Started war monitoring'],
    watch_triggered: ['\u26A0\uFE0F', 'Monitoring reopened the case'],
    watch_complete: ['\u2705', 'Monitoring completed cleanly'],
    waiting: ['\u23F3', 'Set a follow-up'],
    waiting_due: ['\u23F0', 'Follow-up became due'],
    contact_prepared: ['\u2709\uFE0F', 'Prepared a player message'],
    dm_sent: ['\u2709\uFE0F', 'Sent a player message'],
    dm_delivery_failed: ['\u26A0\uFE0F', 'Player message delivery failed'],
    contact_reminder_sent: ['\uD83D\uDD14', 'Sent the automatic reminder'],
    contact_reminder_failed: ['\u26A0\uFE0F', 'Automatic reminder failed'],
    contact_no_response: ['\u23F0', 'Player did not respond'],
    player_response: ['\uD83D\uDCAC', 'Player replied'],
    hero_down_decision: ['\uD83D\uDEE1\uFE0F', 'Started hero-down recovery'],
    extended: ['\uD83D\uDEE1\uFE0F', 'Extended hero-down recovery'],
    removal_decision: ['\uD83D\uDEAB', 'Started community removal'],
    removal_no_dm: ['\uD83D\uDEAB', 'Continued removal without a DM'],
    removal_actioned: ['\uD83D\uDEAB', 'Recorded the in-game removal'],
    removal_confirmed: ['\u2705', 'Roster confirmed the removal'],
    removal_rejoined: ['\uD83D\uDEA8', 'Detected a removed player rejoining'],
    removal_cancelled: ['\u21A9\uFE0F', 'Cancelled community removal'],
    rejoin_approved: ['\u2705', 'Approved the player rejoining'],
    approved_return: ['\u2705', 'Approved return to regular wars'],
    closed: ['\u2705', 'Closed the follow-up'],
    resolved: ['\u2705', 'Resolved case'],
    reopened: ['\uD83D\uDD0E', 'Reopened the follow-up'],
    note: ['\uD83D\uDCDD', 'Added a private note'],
    escalated: ['\uD83D\uDEA8', 'Escalated for leadership review']
});

function activityPresentation(activityRaw) {
    const activity = activityRaw && typeof activityRaw === 'object' ? activityRaw : {};
    const type = toText(activity.type).trim().toLowerCase();
    const mapped = ACTIVITY_PRESENTATION[type] || ['\u2022', 'Updated the case'];
    if (type === 'assigned') {
        const assigned = /^Assigned to\s+(.+?)(?:\s+\(\d{17,20}\))?\.(?:\s|$)/i.exec(toText(activity.text));
        if (assigned?.[1]) return [mapped[0], `Assigned to ${truncate(safeInline(assigned[1]), 70)}`];
    }
    return mapped;
}

function recentCaseActivity(workspace) {
    const itemsByTag = new Map((workspace?.work?.items || []).map(item => [workflow.normalizeTag(item.tag), item]));
    const entries = [];
    for (const caseRaw of Array.isArray(workspace?.privateState?.cases) ? workspace.privateState.cases : []) {
        const caseValue = workflow.normalizeCase(caseRaw);
        if (!caseValue) continue;
        const item = itemsByTag.get(caseValue.tag) || null;
        for (const activity of Array.isArray(caseValue.activity) ? caseValue.activity : []) {
            const at = workflow.parseMs(activity?.at);
            const type = toText(activity?.type).trim().toLowerCase();
            if (!at || !type || type === 'dm_queued') continue;
            const [emoji, label] = activityPresentation(activity);
            entries.push({
                id: toText(activity.id).trim() || `${caseValue.tag}:${activity.at}:${type}`,
                at,
                atIso: activity.at,
                tag: caseValue.tag,
                name: toText(item?.player?.name || caseValue.name || caseValue.tag).trim(),
                actor: toText(activity.actor).trim() || 'War Follow Up',
                emoji,
                label,
                item
            });
        }
    }
    return entries.sort((left, right) => right.at - left.at || right.id.localeCompare(left.id));
}

function recentActivityNavigationRow() {
    return new ActionRowBuilder().addComponents(
        actionButton('mycases', 'My cases', ButtonStyle.Secondary),
        actionButton('attention', 'Needs attention', ButtonStyle.Secondary, '0'),
        actionButton('home', 'All cases', ButtonStyle.Primary)
    );
}

function buildRecentActivityPayload(workspace, options = {}) {
    const pageSize = 12;
    const entries = recentCaseActivity(workspace);
    const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(Math.max(0, Number(options.page) || 0), pageCount - 1);
    const visible = entries.slice(page * pageSize, (page + 1) * pageSize);
    const lines = visible.map(entry => [
        entry.emoji,
        workflow.discordRelativeTimestamp(entry.atIso),
        `**${safeInline(entry.name || entry.tag)}**`,
        `${safeInline(entry.actor)} \u2014 ${entry.label}`
    ].filter(Boolean).join(' \u00B7 '));
    const embed = new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setTitle('Recent case activity')
        .setDescription(truncate(lines.join('\n') || 'No case activity has been recorded yet.', 4096))
        .setFooter({ text: `Private note and message contents stay inside each case \u00B7 page ${page + 1}/${pageCount}` });
    const components = [];
    const selectable = [];
    const seenTags = new Set();
    for (const entry of visible) {
        if (!entry.item || seenTags.has(entry.tag)) continue;
        seenTags.add(entry.tag);
        selectable.push(new StringSelectMenuOptionBuilder()
            .setLabel(truncate(entry.name || entry.tag, 100))
            .setDescription(truncate(`${entry.label} \u00B7 ${entry.tag}`, 100))
            .setValue(entry.tag));
    }
    if (selectable.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pick'))
                .setPlaceholder('Open a case from this page')
                .addOptions(selectable)
        ));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('recent', 'Previous', ButtonStyle.Secondary, String(page - 1)).setDisabled(page <= 0),
            actionButton('recent', 'Next', ButtonStyle.Secondary, String(page + 1)).setDisabled(page >= pageCount - 1)
        ));
    }
    components.push(recentActivityNavigationRow());
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function buildAttentionPayload(workspace, guildRecord, options = {}) {
    const entries = moderationAttentionItems(workspace, guildRecord, options.now || new Date());
    const pageCount = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(options.page) || 0), pageCount - 1);
    const visible = entries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const lines = visible.map(({ item, reasons }) => {
        const owner = item.case?.assignedModeratorName || item.case?.handledBy || 'No owner';
        return `\u26A0\uFE0F **${safeInline(item.player?.name || item.tag)}** \u00B7 ${reasons.join(', ')} \u00B7 ${safeInline(owner)}`;
    });
    const embed = new EmbedBuilder()
        .setColor(entries.length ? COLORS.review : COLORS.success)
        .setTitle('Needs attention')
        .setDescription(truncate(lines.join('\n') || 'Nothing needs team attention right now.', 4096))
        .setFooter({ text: `Shared exceptions only; assigned routine work stays in My cases \u00B7 page ${page + 1}/${pageCount}` });
    const components = [];
    if (visible.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pick'))
                .setPlaceholder('Open a case that needs attention')
                .addOptions(visible.map(({ item }) => caseOption(item)))
        ));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('attention', 'Previous', ButtonStyle.Secondary, String(page - 1)).setDisabled(page <= 0),
            actionButton('attention', 'Next', ButtonStyle.Secondary, String(page + 1)).setDisabled(page >= pageCount - 1)
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        actionButton('mycases', 'My cases', ButtonStyle.Secondary),
        actionButton('recent', 'Recent activity', ButtonStyle.Secondary, '0'),
        actionButton('home', 'All cases', ButtonStyle.Primary)
    ));
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function buildHomePayload(workspace, config, options = {}) {
    const work = workspace?.work || {};
    const status = normalizeStatusFilter(options.status);
    const allItems = filteredItems(work, status);
    const pageCount = Math.max(1, Math.ceil(allItems.length / PAGE_SIZE));
    const page = Math.min(Math.max(0, Number(options.page) || 0), pageCount - 1);
    const items = allItems.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const counts = statusCounts(work);
    const lines = items.slice(0, 12).map(item => {
        const meta = casePresentation(item);
        const handler = item.case?.assignedModeratorName || item.case?.handledBy;
        return `${meta.emoji} **${safeInline(item.player?.name || item.tag)}** · ${meta.label} · ${handler ? safeInline(handler) : 'Unassigned'}`;
    });
    if (items.length > lines.length) lines.push(`…and ${items.length - lines.length} more on this page.`);
    const embed = new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setTitle('War Follow Up · staff queue')
        .setDescription(lines.length ? lines.join('\n') : 'No follow-up items match this view.')
        .addFields({
            name: 'Counts',
            value: `Review ${counts.needs_review} · Waiting ${counts.waiting} · DM ${counts.needs_dm} · Removal ${counts.removal_pending} · Hero-down ${counts.hero_down} · Ready ${counts.ready} · Monitoring ${counts.watching} · Closed ${counts.closed}`
        })
        .setFooter({ text: `${status === 'all' ? 'All statuses' : workflow.STATUS_META[status].label} · page ${page + 1}/${pageCount}` });
    const components = [];

    if (items.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pick'))
                .setPlaceholder('Open a player follow-up')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(items.map(caseOption))
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        actionButton('filter', `Review (${counts.needs_review})`, status === 'needs_review' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'needs_review'),
        actionButton('filter', `Needs DM (${counts.needs_dm})`, status === 'needs_dm' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'needs_dm'),
        actionButton('filter', `Removal (${counts.removal_pending})`, status === 'removal_pending' ? ButtonStyle.Danger : ButtonStyle.Secondary, 'removal_pending'),
        actionButton('filter', `Hero-down (${counts.hero_down})`, status === 'hero_down' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'hero_down'),
        actionButton('filter', `Ready (${counts.ready})`, status === 'ready' ? ButtonStyle.Success : ButtonStyle.Secondary, 'ready')
    ));

    const pagingRow = new ActionRowBuilder().addComponents(
        actionButton('page', 'Previous', ButtonStyle.Secondary, String(page - 1), status).setDisabled(page <= 0),
        actionButton('filter', `Waiting (${counts.waiting})`, status === 'waiting' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'waiting'),
        actionButton('filter', `Closed (${counts.closed})`, status === 'closed' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'closed'),
        actionButton('filter', 'All', status === 'all' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'all'),
        actionButton('page', 'Next', ButtonStyle.Secondary, String(page + 1), status).setDisabled(page >= pageCount - 1)
    );
    components.push(pagingRow, moderationNavigationRow(), navigationRow());

    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function evidenceValue(statsRaw) {
    const stats = workflow.statsSummary(statsRaw);
    if (!stats.possibleAttacks && !stats.countedAttacks) return 'No tracked opportunities.';
    const parts = [];
    if (stats.possibleAttacks) parts.push(`${stats.usedAttacks}/${stats.possibleAttacks} attacks · ${stats.missedAttacks} missed`);
    if (stats.countedAttacks) parts.push(`${workflow.formatNumber(stats.averageStars, 1)} avg stars · ${workflow.formatNumber(stats.averageDestruction, 0)}% avg`);
    return parts.join('\n').slice(0, 1024);
}

function conversationEntries(item) {
    return Array.isArray(item?.case?.conversation) ? item.case.conversation : [];
}

function conversationBlock(entry, maxTextLength = 2000) {
    const staff = entry?.direction === 'staff';
    const speaker = staff
        ? `Sent by ${safeInline(entry.actor || 'Staff')}`
        : 'Player replied';
    const meta = [speaker, workflow.formatDate(entry?.at)].filter(Boolean).join(' / ');
    return `**${meta}**\n${truncate(safeMultiline(entry?.text), maxTextLength)}`;
}

function recentConversationValue(item) {
    const entries = conversationEntries(item).slice(-2);
    if (!entries.length) return '';
    return entries.map(entry => conversationBlock(entry, 380)).join('\n\n').slice(0, 1024);
}

function casePresentation(item) {
    const caseValue = item?.case || {};
    if (item?.status === 'needs_dm' && caseValue.dmQueueId) {
        return { label: 'Sending DM', next: 'Waiting to be sent', emoji: '⏳' };
    }
    if (item?.status === 'needs_dm' && caseValue.dmDeliveryFailedAt) {
        return { label: 'DM delivery failed', next: 'Retry the bot DM or record a manual message', emoji: '⚠️' };
    }
    if (item?.status === 'waiting' && caseValue.contactPurpose === 'general') {
        if (caseValue.contactStage === 'awaiting_final_response' || caseValue.contactAutomaticReminderAllowed === false) {
            return { label: 'Awaiting final reply', next: 'Final message sent; no automatic reminder will follow', emoji: '⏳' };
        }
        return caseValue.contactStage === 'awaiting_after_reminder' || caseValue.contactReminderSentAt
            ? { label: 'Awaiting reply after reminder', next: 'One reminder sent; no more automatic DMs', emoji: '⏳' }
            : { label: 'Awaiting first reply', next: 'One automatic reminder will be sent after 24 hours', emoji: '⏳' };
    }
    if (caseValue.contactStage === 'no_response') {
        return caseValue.contactAutomaticReminderAllowed === false
            ? { label: 'No response to final message', next: 'Choose an outcome; no more automatic DMs will be sent', emoji: '⚠️' }
            : { label: 'No response after reminder', next: 'Choose an outcome; no more automatic DMs will be sent', emoji: '⚠️' };
    }
    if (caseValue.contactStage === 'reminder_failed') {
        return { label: 'Reminder delivery failed', next: 'Choose how to continue', emoji: '⚠️' };
    }
    if (caseValue.contactStage === 'responded' && item?.status === 'needs_review') {
        return { label: 'Player replied', next: 'Read the conversation and decide what happens next', emoji: '💬' };
    }
    if (item?.status === 'hero_down') {
        return { label: 'Hero-down recovery', next: 'Recovery period is active', emoji: '🛡️' };
    }
    if (item?.status === 'removal_pending' && caseValue.removalActionedAt) {
        return { label: 'Awaiting removal confirmation', next: 'Waiting for refreshed roster data', emoji: '⏳' };
    }
    return workflow.STATUS_META[item?.status] || workflow.STATUS_META.needs_review;
}

function conversationPages(entriesRaw) {
    const entries = Array.isArray(entriesRaw) ? entriesRaw : [];
    const pages = [];
    let current = [];
    let currentLength = 0;
    for (const entry of entries) {
        const block = conversationBlock(entry, 2000);
        const addition = block.length + (current.length ? 2 : 0);
        if (current.length && currentLength + addition > 3800) {
            pages.push(current);
            current = [];
            currentLength = 0;
        }
        current.push({ entry, block });
        currentLength += block.length + (current.length > 1 ? 2 : 0);
    }
    if (current.length) pages.push(current);
    return pages.length ? pages : [[]];
}

function hasEvidenceData(evidenceRaw) {
    const evidence = evidenceRaw && typeof evidenceRaw === 'object' ? evidenceRaw : {};
    return Boolean(
        toText(evidence.capturedAt).trim() ||
        Number(evidence.regular?.possibleAttacks) ||
        Number(evidence.regular?.countedAttacks) ||
        Number(evidence.cwl?.possibleAttacks) ||
        Number(evidence.cwl?.countedAttacks) ||
        (Array.isArray(evidence.regularEvents) && evidence.regularEvents.length) ||
        (Array.isArray(evidence.cwlEvents) && evidence.cwlEvents.length)
    );
}

function evidenceForDisplay(itemRaw) {
    const item = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const decisionEvidence = item.case?.evidence;
    const usesDecisionEvidence = hasEvidenceData(decisionEvidence) && Boolean(
        item.case?.openedAt || !['needs_review', 'watching', 'waiting'].includes(item.status)
    );
    return {
        evidence: usesDecisionEvidence ? decisionEvidence : (item.evidence || {}),
        usesDecisionEvidence
    };
}

function evidenceEventLines(eventsRaw, kind) {
    const events = Array.isArray(eventsRaw) ? eventsRaw : [];
    return events.map(event => {
        const stats = workflow.statsSummary(event?.stats);
        const label = kind === 'cwl'
            ? (safeInline(event?.label) || 'CWL')
            : (workflow.formatDate(event?.at) || 'Regular war');
        const details = [
            workflow.normalizeTag(event?.clanTag),
            stats.possibleAttacks ? `${stats.usedAttacks}/${stats.possibleAttacks} used` : '',
            stats.countedAttacks ? `${workflow.formatNumber(stats.averageStars, 1)} avg stars` : '',
            stats.missedAttacks ? `${stats.missedAttacks} missed` : ''
        ].filter(Boolean).join(' · ');
        return `• **${label}**${details ? ` — ${details}` : ''}`;
    });
}

function buildEvidencePayload(item) {
    if (!item) return buildCasePayload(null);
    const shown = evidenceForDisplay(item);
    const evidence = shown.evidence;
    const regularLines = evidenceEventLines(evidence.regularEvents, 'regular');
    const cwlLines = evidenceEventLines(evidence.cwlEvents, 'cwl');
    const embed = new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setTitle(truncate(`War details · ${item.player?.name || item.tag}`, 256))
        .setDescription(shown.usesDecisionEvidence
            ? `This is the evidence snapshot used for the current decision${evidence.capturedAt ? `, captured ${workflow.discordRelativeTimestamp(evidence.capturedAt)}` : ''}.`
            : 'This is the latest evidence used by the automatic follow-up rules.')
        .addFields(
            { name: 'Regular-war totals', value: evidenceValue(evidence.regular), inline: true },
            { name: 'CWL totals', value: evidenceValue(evidence.cwl), inline: true },
            { name: 'Regular war details', value: truncate(regularLines.join('\n') || 'No regular-war details in this lookback.', 1024) },
            { name: 'CWL details', value: truncate(cwlLines.join('\n') || 'No CWL details in this lookback.', 1024) }
        );
    return {
        embeds: [embed],
        components: [
            new ActionRowBuilder().addComponents(actionButton('case', 'Back to follow-up', ButtonStyle.Primary, item.tag))
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildActivityPayload(item, pageRaw = 0) {
    if (!item) return buildCasePayload(null);
    const entries = (Array.isArray(item.case?.activity) ? item.case.activity : []).slice().reverse();
    const pageSize = 8;
    const pageCount = Math.max(1, Math.ceil(entries.length / pageSize));
    const page = Math.min(Math.max(0, Number(pageRaw) || 0), pageCount - 1);
    const visible = entries.slice(page * pageSize, (page + 1) * pageSize);
    const lines = visible.map(entry => {
        const meta = [workflow.formatDate(entry.at) || 'Unknown date', safeInline(entry.actor)].filter(Boolean).join(' · ');
        return `**${meta}**\n${truncate(safeInline(entry.text || entry.type), 320)}`;
    });
    const token = caseToken(item);
    return {
        embeds: [new EmbedBuilder()
            .setColor(COLORS.neutral)
            .setTitle(truncate(`Private activity · ${item.player?.name || item.tag}`, 256))
            .setDescription(lines.join('\n\n') || 'No private activity has been recorded for this follow-up.')
            .setFooter({ text: `Newest first · page ${page + 1}/${pageCount}` })],
        components: [
            new ActionRowBuilder().addComponents(
                actionButton('activity', 'Previous', ButtonStyle.Secondary, item.tag, token, String(page - 1)).setDisabled(page <= 0),
                actionButton('case', 'Back to follow-up', ButtonStyle.Primary, item.tag),
                actionButton('activity', 'Next', ButtonStyle.Secondary, item.tag, token, String(page + 1)).setDisabled(page >= pageCount - 1),
                actionButton('conversation', 'Conversation', ButtonStyle.Secondary, item.tag, token, 'latest')
                    .setDisabled(conversationEntries(item).length === 0)
            )
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildConversationPayload(item, pageRaw = 'latest') {
    if (!item) return buildCasePayload(null);
    const entries = conversationEntries(item);
    const pages = conversationPages(entries);
    const requestedPage = pageRaw === 'latest' ? pages.length - 1 : Number(pageRaw);
    const page = Math.min(Math.max(0, Number.isFinite(requestedPage) ? requestedPage : pages.length - 1), pages.length - 1);
    const visible = pages[page];
    const firstIndex = visible.length ? entries.indexOf(visible[0].entry) + 1 : 0;
    const lastIndex = visible.length ? firstIndex + visible.length - 1 : 0;
    const trimmed = Math.max(0, Number(item.case?.conversationTrimmedCount) || 0);
    const description = visible.length
        ? visible.map(value => value.block).join('\n\n')
        : 'No sent messages or player replies have been recorded for this case yet.';
    const token = caseToken(item);
    const footerParts = [
        visible.length ? `Messages ${firstIndex}-${lastIndex} of ${entries.length}` : 'No messages',
        `page ${page + 1}/${pages.length}`,
        trimmed ? `${trimmed} older message${trimmed === 1 ? '' : 's'} not shown` : ''
    ].filter(Boolean);
    return {
        embeds: [new EmbedBuilder()
            .setColor(COLORS.neutral)
            .setTitle(truncate(`Private conversation - ${item.player?.name || item.tag}`, 256))
            .setDescription(description)
            .setFooter({ text: footerParts.join(' / ') })],
        components: [
            new ActionRowBuilder().addComponents(
                actionButton('conversation', 'Previous', ButtonStyle.Secondary, item.tag, token, String(page - 1)).setDisabled(page <= 0),
                actionButton('case', 'Back to follow-up', ButtonStyle.Primary, item.tag),
                actionButton('conversation', 'Next', ButtonStyle.Secondary, item.tag, token, String(page + 1)).setDisabled(page >= pages.length - 1),
                actionButton('activity', 'Audit log', ButtonStyle.Secondary, item.tag, token, '0')
            )
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildCasePayload(item, workspace, config) {
    if (!item) {
        return {
            content: 'That follow-up is no longer in the queue. Refresh and try again.',
            embeds: [],
            components: [navigationRow()],
            flags: EPHEMERAL,
            allowedMentions: { parse: [] }
        };
    }
    const removalEvasion = item.case?.status === 'removal_evasion' || item.removalRejoinDetected === true;
    const removedMonitoring = item.case?.status === 'removed' && !removalEvasion;
    const meta = removalEvasion
        ? { label: 'Removal evasion', next: 'Remove the player again or approve their return', emoji: '🚨' }
        : casePresentation(item);
    const player = item.player || {};
    const shownEvidence = evidenceForDisplay(item);
    const embed = new EmbedBuilder()
        .setColor(item.status === 'ready' ? COLORS.success : (item.status === 'closed' ? COLORS.closed : COLORS.review))
        .setTitle(truncate(`${meta.emoji} ${player.name || item.tag}`, 256))
        .setDescription([
            `\`${item.tag}\` · ${safeInline(player.rosterTitle || 'No current roster')} · TH${player.th || '?'}`,
            `Discord: ${player.discordId ? `<@${player.discordId}>` : safeInline(player.discord || 'Not linked')}`,
            `**${meta.label}:** ${meta.next}`
        ].join('\n'));

    if (shownEvidence.usesDecisionEvidence) {
        embed.addFields({
            name: 'Why this decision was made',
            value: [
                `**Regular:** ${evidenceValue(shownEvidence.evidence?.regular)}`,
                `**CWL:** ${evidenceValue(shownEvidence.evidence?.cwl)}`
            ].join('\n').slice(0, 1024)
        });
    } else if (item.signals?.length) {
        embed.addFields({
            name: 'Why this needs review',
            value: item.signals.map(signal => `• **${safeInline(signal.title)}:** ${safeInline(signal.text)}`).join('\n').slice(0, 1024)
        });
    } else if (hasEvidenceData(shownEvidence.evidence)) {
        embed.addFields({
            name: 'Evidence snapshot',
            value: [
                `**Regular:** ${evidenceValue(shownEvidence.evidence?.regular)}`,
                `**CWL:** ${evidenceValue(shownEvidence.evidence?.cwl)}`
            ].join('\n').slice(0, 1024)
        });
    }
    if (item.recovery) {
        embed.addFields({
            name: 'Hero-down progress',
            value: `${item.recovery.completedWars}/${item.recovery.targetWars} consecutive clean wars · ${item.recovery.usedAttacks}/${item.recovery.possibleAttacks} attacks used`
        });
    }
    if (item.watching) {
        embed.addFields({
            name: 'Monitoring progress',
            value: `${item.watching.completedWars}/${item.watching.targetWars} regular wars observed`
        });
    }
    embed.addFields({
        name: 'Assigned moderator',
        value: safeInline(item.case?.assignedModeratorName || item.case?.handledBy || 'Unassigned'),
        inline: true
    });
    const currentRosterTitle = toText(player.rosterTitle).trim();
    const currentClanTag = workflow.normalizeTag(player.clanTag);
    const sourceRosterTitle = toText(item.case?.sourceRosterTitle).trim();
    const sourceClanTag = workflow.normalizeTag(item.case?.sourceClanTag);
    const sourceDiffersFromCurrent = (!currentRosterTitle && !currentClanTag) ||
        (currentRosterTitle && sourceRosterTitle && currentRosterTitle.toLowerCase() !== sourceRosterTitle.toLowerCase()) ||
        (currentClanTag && sourceClanTag && currentClanTag !== sourceClanTag);
    if ((sourceRosterTitle || sourceClanTag) && sourceDiffersFromCurrent) {
        embed.addFields({
            name: 'Opened from',
            value: [safeInline(sourceRosterTitle), sourceClanTag].filter(Boolean).join(' · '),
            inline: true
        });
    }
    if (item.case?.waitingUntil) embed.addFields({ name: 'Follow-up due', value: workflow.discordRelativeTimestamp(item.case.waitingUntil), inline: true });
    if (item.case?.dmQueueId) {
        embed.addFields({ name: 'Discord delivery', value: `Scheduled ${workflow.discordRelativeTimestamp(item.case.dmQueuedAt)}. Do not send this message again.` });
    }
    if (item.case?.dmDeliveryFailedAt) {
        embed.addFields({ name: 'Discord delivery failed', value: truncate(safeInline(item.case.dmDeliveryFailureReason || 'The message could not be delivered.'), 1024) });
    }
    if (item.case?.contactStage === 'awaiting_first_response') {
        embed.addFields({ name: 'What happens next', value: `No action is needed now. If there is no reply by ${workflow.discordRelativeTimestamp(item.case.waitingUntil)}, the bot sends one polite reminder without pinging staff.` });
    } else if (item.case?.contactStage === 'awaiting_after_reminder') {
        embed.addFields({ name: 'What happens next', value: `The one automatic reminder was sent ${workflow.discordRelativeTimestamp(item.case.contactReminderSentAt)}. If there is still no reply by ${workflow.discordRelativeTimestamp(item.case.waitingUntil)}, this returns to **Needs action**. No further automatic DMs will be sent.` });
    } else if (item.case?.contactStage === 'awaiting_final_response') {
        embed.addFields({ name: 'What happens next', value: `A moderator approved this final message. No automatic reminder will follow. If there is still no reply by ${workflow.discordRelativeTimestamp(item.case.waitingUntil)}, this returns to **Needs action**.` });
    } else if (item.case?.contactStage === 'no_response') {
        embed.addFields({ name: 'Response status', value: item.case?.contactAutomaticReminderAllowed === false
            ? '**No response to the moderator-approved final message.** Decide without a response, give more time, send another explicitly approved message, or escalate.'
            : '**No response after the initial DM and one reminder.** Decide without a response, give more time, approve a final message, or escalate.' });
    } else if (item.case?.contactStage === 'reminder_failed') {
        embed.addFields({ name: 'Response status', value: `**The automatic reminder could not be delivered.** ${truncate(safeInline(item.case.contactReminderFailureReason || ''), 800)}` });
    } else if (item.case?.contactStage === 'responded') {
        embed.addFields({ name: 'Response status', value: '**The player replied.** Read the recent or full conversation before deciding.' });
    }
    if (item.case?.escalatedAt) embed.addFields({ name: 'Leadership review', value: `Escalated ${workflow.discordRelativeTimestamp(item.case.escalatedAt)}`, inline: true });
    if (item.case?.targetRosterTitle) embed.addFields({ name: 'Hero-down roster', value: safeInline(item.case.targetRosterTitle), inline: true });
    if (item.case?.removalReason) embed.addFields({ name: 'Removal reason', value: truncate(safeInline(item.case.removalReason), 1024) });
    if (item.case?.status === 'removal_pending') {
        embed.addFields({
            name: 'In-game removal',
            value: item.case.removalActionedAt
                ? `Recorded ${workflow.discordRelativeTimestamp(item.case.removalActionedAt)} · this case will update when the roster confirms the player left.`
                : 'Remove the player from the clan in game, then record it below. The case closes only after roster data confirms they left.'
        });
    }
    if (removalEvasion) {
        embed.addFields({
            name: 'Rejoin detected',
            value: [
                safeInline(item.case.rejoinRosterTitle || player.rosterTitle || 'Connected clan'),
                workflow.normalizeTag(item.case.rejoinClanTag || player.clanTag),
                item.case.removalRejoinedAt ? workflow.discordRelativeTimestamp(item.case.removalRejoinedAt) : 'Detected in the latest roster data'
            ].filter(Boolean).join(' · ')
        });
    }
    if (removedMonitoring) {
        embed.addFields({ name: 'Rejoin monitoring', value: 'Active. If this account appears in any connected clan again, a new removal review will open automatically.' });
    }
    if (item.case?.dmText && item.status === 'needs_dm') {
        embed.addFields({ name: 'Prepared message (not sent yet)', value: truncate(safeMultiline(item.case.dmText), 1000) });
    }
    const recentConversation = recentConversationValue(item);
    if (recentConversation) {
        embed.addFields({
            name: `Recent conversation · ${conversationEntries(item).length} message${conversationEntries(item).length === 1 ? '' : 's'}`,
            value: recentConversation
        });
    }
    if (item.status === 'waiting' && item.case?.contactPurpose === 'general' && item.case?.dmDeliveryMode === 'bot' && item.case?.dmMessageId && isPlayerReplyCaptureEnabled(config)) {
        embed.addFields({
            name: 'Reply capture',
            value: 'Player replies are added to the private conversation and forwarded privately. The bot never makes a moderation decision from a reply.'
        });
    }
    const components = [];
    const tag = item.tag;
    const token = caseToken(item);
    const contactStage = toText(item.case?.contactStage).trim();
    if (removalEvasion) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('remove', 'Remove again', ButtonStyle.Danger, tag, token),
            actionButton('approverejoin', 'Approve rejoin', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
    } else if (item.status === 'needs_review') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('dismiss', 'No action', ButtonStyle.Secondary, tag, token),
            actionButton('watch', 'Monitor next wars', ButtonStyle.Secondary, tag, token),
            actionButton('hero', 'Hero-down period', ButtonStyle.Primary, tag, token),
            actionButton('remove', 'Remove from community', ButtonStyle.Danger, tag, token)
        ));
        components.push(new ActionRowBuilder().addComponents(
            actionButton(
                'contact',
                ['no_response', 'reminder_failed'].includes(contactStage)
                    ? 'Send final message'
                    : (conversationEntries(item).some(entry => entry.direction === 'player') ? 'Reply to player' : 'Contact player'),
                ButtonStyle.Primary,
                tag,
                token
            ),
            actionButton('wait', ['no_response', 'reminder_failed'].includes(contactStage) ? 'Give more time' : 'Set follow-up', ButtonStyle.Secondary, tag, token),
            actionButton('resolveask', 'Record resolution', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
    } else if (item.status === 'needs_dm') {
        if (item.case?.dmQueueId) {
            components.push(new ActionRowBuilder().addComponents(
                actionButton('case', 'Refresh status', ButtonStyle.Primary, tag),
                ...(item.case?.contactPurpose === 'removal'
                    ? [actionButton('cancelremoval', 'Cancel removal', ButtonStyle.Secondary, tag, token)]
                    : [actionButton('reopen', 'Cancel / change decision', ButtonStyle.Secondary, tag, token)]),
                actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
            ));
        } else {
        const row = new ActionRowBuilder();
        if (config?.features?.directMessages === true && player.discordId) {
            row.addComponents(actionButton('senddm', 'Send DM now', ButtonStyle.Success, tag, token));
        }
        row.addComponents(actionButton('markdm', item.case?.contactPurpose === 'removal' ? 'Mark notice sent' : 'Mark DM sent', ButtonStyle.Primary, tag, token));
        if (item.case?.contactPurpose !== 'removal') {
            row.addComponents(actionButton('reopen', 'Change decision', ButtonStyle.Secondary, tag, token));
        }
        if (item.case?.contactPurpose === 'removal' && !player.discordId) {
            row.addComponents(actionButton('removalnodm', 'Continue without DM', ButtonStyle.Secondary, tag, token));
        }
        components.push(row);
        components.push(new ActionRowBuilder().addComponents(
            ...(item.case?.contactPurpose === 'removal'
                ? [actionButton('cancelremoval', 'Cancel removal', ButtonStyle.Secondary, tag, token)]
                : [
                    actionButton('wait', 'Set follow-up', ButtonStyle.Secondary, tag, token),
                    actionButton('resolveask', 'Close case', ButtonStyle.Success, tag, token)
                ]),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
        }
    } else if (item.status === 'removal_pending') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('removaldone', item.case?.removalActionedAt ? 'Removal recorded' : 'I removed them in game', ButtonStyle.Danger, tag, token)
                .setDisabled(Boolean(item.case?.removalActionedAt)),
            actionButton('cancelremoval', 'Cancel removal', ButtonStyle.Secondary, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
    } else if (item.status === 'hero_down' || item.status === 'ready') {
        const row = new ActionRowBuilder();
        if (item.recovery?.ready) row.addComponents(actionButton('approve', 'Approve return', ButtonStyle.Success, tag, token));
        row.addComponents(
            actionButton('extend', 'Extend period', ButtonStyle.Secondary, tag, token),
            actionButton('closeask', 'Close without return', ButtonStyle.Danger, tag, token),
            actionButton('remove', 'Remove from community', ButtonStyle.Danger, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        );
        components.push(row);
    } else if (item.status === 'waiting') {
        if (item.case?.contactPurpose === 'general' && item.case?.dmDeliveryMode === 'bot') {
            components.push(new ActionRowBuilder().addComponents(
                actionButton('reopen', 'Decide now', ButtonStyle.Secondary, tag, token),
                actionButton('wait', 'Give more time', ButtonStyle.Secondary, tag, token),
                actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
            ));
        } else {
            components.push(new ActionRowBuilder().addComponents(
                actionButton('reopen', 'Review now', ButtonStyle.Primary, tag, token),
                actionButton('wait', 'Change follow-up', ButtonStyle.Secondary, tag, token),
                actionButton('resolveask', 'Close case', ButtonStyle.Success, tag, token),
                actionButton('remove', 'Remove from community', ButtonStyle.Danger, tag, token),
                actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
            ));
        }
    } else if (item.status === 'watching') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('reopen', 'Review now', ButtonStyle.Primary, tag, token),
            actionButton('dismiss', 'Stop monitoring', ButtonStyle.Secondary, tag, token)
        ));
    } else if (removedMonitoring) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('approverejoin', 'Stop rejoin monitoring', ButtonStyle.Secondary, tag, token)
        ));
    } else {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('reopen', 'Reopen', ButtonStyle.Secondary, tag, token)
        ));
    }

    if (!(item.status === 'needs_dm' && item.case?.dmQueueId)) {
        const refreshButton = actionButton('case', 'Refresh case', ButtonStyle.Secondary, tag);
        const availableDecisionRow = components.slice().reverse()
            .find(row => row.components.length < 5);
        if (availableDecisionRow) availableDecisionRow.addComponents(refreshButton);
        else components.push(new ActionRowBuilder().addComponents(refreshButton));
    }

    const coordination = new ActionRowBuilder();
    if (ACTIVE_CASE_STATUSES.has(item.status)) {
        coordination.addComponents(actionButton(
            'assignment',
            item.case?.assignedModeratorId || item.case?.handledBy ? 'Change owner' : 'Assign owner',
            ButtonStyle.Secondary,
            tag,
            token
        ));
    }
    coordination.addComponents(
        actionButton('note', 'Add private note', ButtonStyle.Secondary, tag, token),
        actionButton('evidence', 'War details', ButtonStyle.Secondary, tag, token),
        conversationEntries(item).length
            ? actionButton('conversation', `Conversation (${conversationEntries(item).length})`, ButtonStyle.Secondary, tag, token, 'latest')
            : actionButton('activity', 'Activity', ButtonStyle.Secondary, tag, token, '0')
    );
    if (!removedMonitoring && !removalEvasion) coordination.addComponents(actionButton('ignoreask', 'Always ignore', ButtonStyle.Danger, tag, token));
    components.push(coordination);
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function buildConfirmationPayload(kind, item) {
    const ignore = kind === 'ignore';
    const token = caseToken(item);
    return {
        embeds: [new EmbedBuilder()
            .setColor(COLORS.danger)
            .setTitle(ignore ? 'Always ignore this account?' : 'Close without return?')
            .setDescription(ignore
                ? `**${safeInline(item?.player?.name || item?.tag)}** will disappear from automatic war work and Discord gaps until restored.`
                : `**${safeInline(item?.player?.name || item?.tag)}** will be closed with the outcome "no return". It can still be reopened.`)],
        components: [new ActionRowBuilder().addComponents(
            actionButton(ignore ? 'ignore' : 'close', ignore ? 'Confirm ignore' : 'Confirm close', ButtonStyle.Danger, item.tag, token),
            actionButton('case', 'Cancel', ButtonStyle.Secondary, item.tag)
        )],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildIgnoredCasePayload(item) {
    return {
        embeds: [new EmbedBuilder()
            .setColor(COLORS.closed)
            .setTitle(truncate(`Ignored · ${item?.player?.name || item?.tag || 'Account'}`, 256))
            .setDescription([
                `\`${item?.tag || 'Unknown tag'}\` is no longer included in automatic war follow-up or Discord-gap reports.`,
                'This account can be restored from **Ignored** in the Moderation Hub.'
            ].join('\n'))],
        components: [],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildHeroRosterPicker(item, workspace, options = {}) {
    const extending = options.extending === true;
    const rosters = (Array.isArray(workspace?.work?.directory?.rosters) ? workspace.work.directory.rosters : [])
        .filter(roster => workflow.normalizeTag(roster.clanTag));
    if (!rosters.length) {
        return {
            content: 'No connected roster is available for a hero-down period.',
            components: [new ActionRowBuilder().addComponents(actionButton('case', 'Back to case', ButtonStyle.Secondary, item.tag))],
            flags: EPHEMERAL
        };
    }
    const select = new StringSelectMenuBuilder()
        .setCustomId(buildCustomId(extending ? 'extendtarget' : 'herotarget', item.tag, caseToken(item)))
        .setPlaceholder('Choose the hero-down roster')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(rosters.slice(0, 25).map(roster =>
            new StringSelectMenuOptionBuilder()
                .setLabel(truncate(roster.title || roster.id, 100))
                .setDescription(truncate(roster.clanTag || 'No clan tag', 100))
                .setValue(rosterToken(roster.id))
                .setDefault(roster.id === (
                    extending
                        ? item.case?.targetRosterId
                        : workspace.work.settings.defaultHeroDownRosterId
                ))
        ));
    return {
        content: `Choose where **${safeInline(item.player?.name || item.tag)}** should complete the ${extending ? 'extended ' : ''}hero-down period.`,
        embeds: [],
        components: [
            new ActionRowBuilder().addComponents(select),
            new ActionRowBuilder().addComponents(actionButton('case', 'Back to case', ButtonStyle.Secondary, item.tag))
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildGapsPayload(workspace, options = {}) {
    const gaps = (Array.isArray(workspace?.work?.directory?.players) ? workspace.work.directory.players : [])
        .filter(player => !player.discordId && !player.trusted)
        .sort((left, right) => toText(left.rosterTitle).localeCompare(toText(right.rosterTitle)) || toText(left.name).localeCompare(toText(right.name)));
    const pageSize = 40;
    const pageCount = Math.max(1, Math.ceil(gaps.length / pageSize));
    const page = Math.min(Math.max(0, Number(options.page) || 0), pageCount - 1);
    const visible = gaps.slice(page * pageSize, (page + 1) * pageSize);
    const lines = visible.map(player =>
        `• **${safeInline(player.name)}** · \`${player.tag}\` · ${safeInline(player.rosterTitle || 'No roster')}`
    );
    const embed = new EmbedBuilder()
        .setColor(gaps.length ? COLORS.review : COLORS.success)
        .setTitle('War Follow Up · Discord gaps')
        .setDescription(truncate(lines.join('\n') || 'Every eligible roster account has a Discord link.', 4000))
        .setFooter({ text: `${gaps.length} gap${gaps.length === 1 ? '' : 's'} · ignored accounts excluded · page ${page + 1}/${pageCount}` });
    const components = [];
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('gapspage', 'Previous', ButtonStyle.Secondary, String(page - 1)).setDisabled(page <= 0),
            actionButton('gapspage', 'Next', ButtonStyle.Secondary, String(page + 1)).setDisabled(page >= pageCount - 1)
        ));
    }
    components.push(navigationRow());
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function buildIgnoredPayload(workspace, options = {}) {
    const ignored = workflow.buildIgnoredPlayerEntries(
        workspace?.work?.directory,
        workspace?.work?.settings,
        workspace?.privateState?.cases
    );
    const pageSize = 25;
    const pageCount = Math.max(1, Math.ceil(ignored.length / pageSize));
    const page = Math.min(Math.max(0, Number(options.page) || 0), pageCount - 1);
    const visible = ignored.slice(page * pageSize, (page + 1) * pageSize);
    const embed = new EmbedBuilder()
        .setColor(COLORS.closed)
        .setTitle('War Follow Up · ignored accounts')
        .setDescription(ignored.length
            ? visible.map(entry => `• **${safeInline(entry.name)}** · \`${entry.tag}\`${entry.inCurrentRoster ? '' : ' · no current roster'}`).join('\n').slice(0, 4000)
            : 'No accounts are permanently ignored.')
        .setFooter({ text: `${ignored.length} ignored account${ignored.length === 1 ? '' : 's'} · page ${page + 1}/${pageCount}` });
    const components = [];
    if (ignored.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('restore', String(page)))
                .setPlaceholder('Restore an ignored account')
                .setMinValues(1)
                .setMaxValues(1)
                .addOptions(visible.map(entry =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(truncate(entry.name, 100))
                        .setDescription(truncate(`${entry.tag} · ${entry.rosterTitle || 'No current roster'}`, 100))
                        .setValue(entry.tag)
                ))
        ));
    }
    if (pageCount > 1) {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('ignoredpage', 'Previous', ButtonStyle.Secondary, String(page - 1)).setDisabled(page <= 0),
            actionButton('ignoredpage', 'Next', ButtonStyle.Secondary, String(page + 1)).setDisabled(page >= pageCount - 1)
        ));
    }
    components.push(navigationRow());
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function yesNo(value) {
    return value ? 'On' : 'Off';
}

function buildRulesPayload(workspace) {
    const settings = workspace?.work?.settings || workflow.sanitizeSettings(null);
    const embed = new EmbedBuilder()
        .setColor(COLORS.neutral)
        .setTitle('War Follow Up · rules')
        .setDescription('These are the same private rules used by the web admin panel. Changes here take effect in both places.')
        .addFields(
            {
                name: 'Regular wars',
                value: [
                    `${settings.regularLookbackWars} recent wars · flag at ${settings.regularMissedThreshold} missed attacks`,
                    `Performance: ${yesNo(settings.regularPerformanceEnabled)} · min ${settings.regularMinimumAttacks} attacks · below ${settings.regularAverageStarsThreshold} stars and ${settings.regularAverageDestructionThreshold}%`
                ].join('\n')
            },
            {
                name: 'CWL',
                value: [
                    `${settings.cwlLookbackSeasons} recent seasons · flag at ${settings.cwlMissedThreshold} missed attacks`,
                    `Performance: ${yesNo(settings.cwlPerformanceEnabled)} · min ${settings.cwlMinimumAttacks} attacks · below ${settings.cwlAverageStarsThreshold} stars and ${settings.cwlAverageDestructionThreshold}%`
                ].join('\n')
            },
            {
                name: 'Workflow',
                value: [
                    `Default recovery: ${settings.defaultRecoveryWars} clean wars`,
                    `Default roster: ${safeInline(settings.defaultHeroDownRosterId || 'Choose per case')}`,
                    `Discord gaps: ${yesNo(settings.missingDiscordEnabled)}`,
                    `Moderators: ${settings.moderatorNames.length ? settings.moderatorNames.map(safeInline).join(', ') : 'None configured'}`
                ].join('\n').slice(0, 1024)
            }
        );
    const components = [
        new ActionRowBuilder().addComponents(
            actionButton('editreg', 'Edit regular rules', ButtonStyle.Secondary),
            actionButton('togreg', `Performance ${yesNo(settings.regularPerformanceEnabled)}`, settings.regularPerformanceEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
            actionButton('editcwl', 'Edit CWL rules', ButtonStyle.Secondary),
            actionButton('togcwl', `Performance ${yesNo(settings.cwlPerformanceEnabled)}`, settings.cwlPerformanceEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        ),
        new ActionRowBuilder().addComponents(
            actionButton('editflow', 'Edit workflow', ButtonStyle.Secondary),
            actionButton('toggaps', `Discord gaps ${yesNo(settings.missingDiscordEnabled)}`, settings.missingDiscordEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
        )
    ];
    const rosters = (Array.isArray(workspace?.work?.directory?.rosters) ? workspace.work.directory.rosters : [])
        .filter(roster => workflow.normalizeTag(roster.clanTag));
    if (rosters.length) {
        const options = [new StringSelectMenuOptionBuilder()
            .setLabel('Choose per case')
            .setValue('__none__')
            .setDefault(!settings.defaultHeroDownRosterId)];
        for (const roster of rosters.slice(0, 24)) {
            options.push(new StringSelectMenuOptionBuilder()
                .setLabel(truncate(roster.title || roster.id, 100))
                .setDescription(truncate(roster.clanTag || 'No clan tag', 100))
                .setValue(rosterToken(roster.id))
                .setDefault(roster.id === settings.defaultHeroDownRosterId));
        }
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('defroster'))
                .setPlaceholder('Default hero-down roster')
                .addOptions(options)
        ));
    }
    components.push(navigationRow());
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function textInput(customId, label, value, options = {}) {
    const input = new TextInputBuilder()
        .setCustomId(customId)
        .setLabel(label)
        .setStyle(options.style || TextInputStyle.Short)
        .setRequired(options.required !== false)
        .setMaxLength(options.maxLength || 100);
    if (options.minLength != null) input.setMinLength(options.minLength);
    else if (options.required !== false) input.setMinLength(1);
    const currentValue = truncate(toText(value), options.maxLength || 100, '');
    if (currentValue) input.setValue(currentValue);
    return input;
}

function modal(title, customId, inputs) {
    return new ModalBuilder()
        .setCustomId(customId)
        .setTitle(truncate(title, 45, ''))
        .addComponents(inputs.map(input => new ActionRowBuilder().addComponents(input)));
}

function buildWatchModal(item) {
    return modal('Monitor next wars', buildCustomId('watchform', item.tag, caseToken(item)), [
        textInput('wars', 'Clean wars before monitoring ends (1-8)', item.case?.watchWarTarget || 2, { maxLength: 1 })
    ]);
}

function buildRemovalModal(item) {
    const reason = item.case?.removalReason || (item.signals?.length
        ? item.signals.map(signal => signal.title).join(', ')
        : 'Leadership moderation decision');
    const message = workflow.buildRemovalDmText({
        playerName: item.player?.name || item.tag,
        reason
    });
    return modal('Remove from community', buildCustomId('removeform', item.tag, caseToken(item)), [
        textInput('reason', 'Removal reason', reason, { style: TextInputStyle.Paragraph, maxLength: 1000 }),
        textInput('message', 'Message to the player', message, { style: TextInputStyle.Paragraph, maxLength: 2000 })
    ]);
}

function buildResolveModal(item) {
    return modal('Close moderation case', buildCustomId('resolveform', item.tag, caseToken(item)), [
        textInput('resolution', 'What resolved this case?', item.case?.resolutionNote || '', {
            style: TextInputStyle.Paragraph,
            maxLength: 2000
        })
    ]);
}

function buildHeroModal(item, targetRoster, workspace) {
    const recoveryWars = workspace?.work?.settings?.defaultRecoveryWars || 3;
    const message = workflow.buildDmText({
        playerName: item.player?.name,
        sourceClan: item.player?.rosterTitle,
        targetClan: targetRoster.title,
        targetClanTag: targetRoster.clanTag,
        nextWarStartAt: targetRoster.nextWarStartAt,
        recoveryWars,
        reasonCodes: item.signals?.map(signal => signal.reasonCode),
        evidence: item.evidence
    });
    return modal('Prepare hero-down decision', buildCustomId('heroform', item.tag, caseToken(item), rosterToken(targetRoster.id)), [
        textInput('wars', 'Consecutive clean wars (1-8)', recoveryWars, { maxLength: 1 }),
        textInput('no_misses', 'Require no missed attacks? (yes/no)', 'yes', { maxLength: 3 }),
        textInput('message', 'Decision message', message, { style: TextInputStyle.Paragraph, maxLength: 2000 })
    ]);
}

function buildExtendModal(item, targetRoster) {
    const recoveryWars = item.case?.recoveryWarTarget || 3;
    const shownEvidence = evidenceForDisplay(item);
    const message = workflow.buildDmText({
        playerName: item.player?.name,
        sourceClan: item.player?.rosterTitle || item.case?.sourceRosterTitle,
        targetClan: targetRoster?.title,
        targetClanTag: targetRoster?.clanTag,
        nextWarStartAt: targetRoster?.nextWarStartAt,
        recoveryWars,
        reasonCodes: item.case?.reasonCodes?.length
            ? item.case.reasonCodes
            : item.signals?.map(signal => signal.reasonCode),
        evidence: shownEvidence.evidence
    });
    return modal('Extend hero-down period', buildCustomId('extendform', item.tag, caseToken(item), rosterToken(targetRoster?.id)), [
        textInput('wars', 'Consecutive clean wars (1-8)', recoveryWars, { maxLength: 1 }),
        textInput('no_misses', 'Require no missed attacks? (yes/no)', item.case?.requireNoMisses === false ? 'no' : 'yes', { maxLength: 3 }),
        textInput('message', 'Updated decision message', message, { style: TextInputStyle.Paragraph, maxLength: 2000 })
    ]);
}

function buildNoteModal(item) {
    return modal('Add private note', buildCustomId('noteform', item.tag, caseToken(item)), [
        textInput('note', 'Private note', '', { style: TextInputStyle.Paragraph, maxLength: 2000 })
    ]);
}

function buildMarkDmModal(item) {
    return modal('Review and mark DM sent', buildCustomId('markdmform', item.tag, caseToken(item)), [
        textInput('message', 'Message that was sent', item.case?.dmText || '', {
            style: TextInputStyle.Paragraph,
            maxLength: 2000
        })
    ]);
}

function buildContactModal(item) {
    const playerName = safeInline(item.player?.name || item.tag);
    const isReply = conversationEntries(item).some(entry => entry.direction === 'player');
    const isFinal = ['no_response', 'reminder_failed'].includes(toText(item.case?.contactStage).trim());
    return modal(isFinal ? 'Prepare final message' : (isReply ? 'Prepare reply to player' : 'Prepare player contact'), buildCustomId('contactform', item.tag, caseToken(item)), [
        textInput('message', 'Message (reply instructions added)', isFinal
            ? `Hi ${playerName}. We still need your response before leadership can finish reviewing this. Please reply when you can.`
            : isReply
            ? `Hi ${playerName}. Thanks for getting back to us. We would like to follow up about your recent war activity.`
            : `Hi ${playerName}. A leader is reviewing your recent war activity and would like to follow up with you.`, {
            style: TextInputStyle.Paragraph,
            maxLength: 1800
        })
    ]);
}

function buildWaitModal(item) {
    return modal('Schedule a follow-up', buildCustomId('waitform', item.tag, caseToken(item)), [
        textInput('hours', 'Follow-up in hours (24, 48, or 72)', '24', { maxLength: 2 }),
        textInput('reason', 'Waiting for (optional)', item.case?.waitingReason || '', {
            style: TextInputStyle.Paragraph,
            maxLength: 1000,
            required: false,
            minLength: 0
        })
    ]);
}

function buildAssignmentModal(item) {
    return modal('Assign follow-up', buildCustomId('assignform', item.tag, caseToken(item)), [
        textInput('handler', 'Moderator (leave blank to clear)', item.case?.handledBy || '', {
            maxLength: 80,
            required: false,
            minLength: 0
        })
    ]);
}

function buildReassignmentPayload(item, moderatorsRaw, optionsRaw = {}) {
    const moderators = Array.isArray(moderatorsRaw) ? moderatorsRaw : [];
    const optionsValue = optionsRaw && typeof optionsRaw === 'object' ? optionsRaw : {};
    const currentModeratorId = toText(optionsValue.currentModeratorId).trim();
    const currentModeratorName = toText(optionsValue.currentModeratorName).trim();
    const coveredByModerator = moderators.some(moderator => moderator.discordId === currentModeratorId);
    const canTakeAnyCase = optionsValue.canTakeAnyCase === true;
    const canTakeOwnership = coveredByModerator || canTakeAnyCase;
    const options = [
        new StringSelectMenuOptionBuilder()
            .setLabel('Assign automatically')
            .setDescription('Use current clan coverage and workload balancing.')
            .setValue('__auto__')
    ];
    if (currentModeratorId && currentModeratorId !== item.case?.assignedModeratorId) {
        options.push(new StringSelectMenuOptionBuilder()
            .setLabel(truncate(`Take ownership${currentModeratorName ? ` · ${currentModeratorName}` : ''}`, 100))
            .setDescription(canTakeOwnership
                ? (coveredByModerator
                    ? 'Assign this case directly to you.'
                    : 'Take this case without changing your automatic coverage.')
                : 'Select this clan and accept assignments first.')
            .setValue('__self__'));
    }
    for (const moderator of moderators.filter(moderator => moderator.discordId !== currentModeratorId).slice(0, 23)) {
        options.push(new StringSelectMenuOptionBuilder()
            .setLabel(truncate(moderator.displayName || moderator.discordId, 100))
            .setDescription(truncate(`${moderator.notificationMode || 'channel'} notifications · accepting`, 100))
            .setValue(moderator.discordId)
            .setDefault(moderator.discordId === item.case?.assignedModeratorId));
    }
    return {
        embeds: [new EmbedBuilder()
            .setColor(COLORS.neutral)
            .setTitle(`Assign · ${truncate(item.player?.name || item.tag, 220)}`)
            .setDescription([
                `Eligible moderators for **${safeInline(item.case?.sourceRosterTitle || item.player?.rosterTitle || 'this clan')}** are shown below.`,
                'Choose a person to reassign the case, take ownership yourself, or use automatic balancing.'
            ].join('\n'))],
        components: [
            new ActionRowBuilder().addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(buildCustomId('assignpick', item.tag, caseToken(item)))
                    .setPlaceholder('Choose assignment')
                    .addOptions(options)
            ),
            new ActionRowBuilder().addComponents(actionButton('case', 'Back to case', ButtonStyle.Secondary, item.tag))
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function buildRegularRulesModal(settings) {
    return modal('Edit regular-war rules', buildCustomId('regform', settings.rulesUpdatedAt || ''), [
        textInput('lookback', 'Recent wars (1-8)', settings.regularLookbackWars, { maxLength: 1 }),
        textInput('missed', 'Missed attacks threshold (1-16)', settings.regularMissedThreshold, { maxLength: 2 }),
        textInput('minimum', 'Minimum counted attacks (2-32)', settings.regularMinimumAttacks, { maxLength: 2 }),
        textInput('stars', 'Average stars below (0.5-3)', settings.regularAverageStarsThreshold, { maxLength: 4 }),
        textInput('destruction', 'Destruction below (25-100)', settings.regularAverageDestructionThreshold, { maxLength: 5 })
    ]);
}

function buildCwlRulesModal(settings) {
    return modal('Edit CWL rules', buildCustomId('cwlform', settings.rulesUpdatedAt || ''), [
        textInput('lookback', 'Recent seasons (1-8)', settings.cwlLookbackSeasons, { maxLength: 1 }),
        textInput('missed', 'Missed attacks threshold (1-8)', settings.cwlMissedThreshold, { maxLength: 1 }),
        textInput('minimum', 'Minimum counted attacks (2-24)', settings.cwlMinimumAttacks, { maxLength: 2 }),
        textInput('stars', 'Average stars below (0.5-3)', settings.cwlAverageStarsThreshold, { maxLength: 4 }),
        textInput('destruction', 'Destruction below (25-100)', settings.cwlAverageDestructionThreshold, { maxLength: 5 })
    ]);
}

function buildWorkflowRulesModal(settings) {
    return modal('Edit workflow defaults', buildCustomId('flowform', settings.rulesUpdatedAt || ''), [
        textInput('recovery', 'Default clean wars (1-8)', settings.defaultRecoveryWars, { maxLength: 1 }),
        textInput('moderators', 'Moderators (one per line)', settings.moderatorNames.join('\n'), {
            style: TextInputStyle.Paragraph,
            maxLength: 2000,
            required: false,
            minLength: 0
        })
    ]);
}

function moderatorTeamSnapshot(workspace, guildRecord, options = {}) {
    const moderators = Object.values(guildRecord?.moderators || {});
    const rosters = connectedRosters(workspace).slice(0, 25);
    const eligibleIds = options.eligibleIds instanceof Set ? options.eligibleIds : null;
    const activeCases = moderationCaseSummary(workspace, guildRecord, options.now || new Date()).items;
    const openCounts = {};
    for (const item of activeCases) {
        const moderatorId = toText(item.case?.assignedModeratorId).trim();
        if (moderatorId) openCounts[moderatorId] = (openCounts[moderatorId] || 0) + 1;
    }
    const statusFor = moderator => {
        if (!moderator.accepting) return 'paused';
        if (eligibleIds && !eligibleIds.has(moderator.discordId)) return 'unavailable';
        return 'available';
    };
    const rosterSummaries = new Map();
    const coverageLines = rosters.map(roster => {
        const clanTag = workflow.normalizeTag(roster.clanTag);
        const subscribed = moderators.filter(moderator =>
            (moderator.clanTags || []).map(workflow.normalizeTag).includes(clanTag)
        );
        const byStatus = {
            available: subscribed.filter(moderator => statusFor(moderator) === 'available'),
            paused: subscribed.filter(moderator => statusFor(moderator) === 'paused'),
            unavailable: subscribed.filter(moderator => statusFor(moderator) === 'unavailable')
        };
        const summaryParts = [
            byStatus.available.length ? `${byStatus.available.length} available` : 'needs coverage',
            byStatus.paused.length ? `${byStatus.paused.length} paused` : '',
            byStatus.unavailable.length ? `${byStatus.unavailable.length} unavailable` : ''
        ].filter(Boolean);
        rosterSummaries.set(clanTag, `${clanTag} \u00B7 ${summaryParts.join(' \u00B7 ')}`);
        const names = [
            ...byStatus.available.map(moderator => safeInline(moderator.displayName || moderator.discordId)),
            ...byStatus.paused.map(moderator => `${safeInline(moderator.displayName || moderator.discordId)} (paused)`),
            ...byStatus.unavailable.map(moderator => `${safeInline(moderator.displayName || moderator.discordId)} (unavailable)`)
        ];
        const indicator = byStatus.available.length ? '\uD83D\uDFE2' : (subscribed.length ? '\uD83D\uDFE1' : '\uD83D\uDD34');
        return `${indicator} **${safeInline(roster.title || clanTag)}** \u00B7 ${summaryParts.join(' \u00B7 ')}${names.length ? `\n${names.join(', ')}` : ''}`;
    });
    const workloadModerators = moderators
        .filter(moderator => Array.isArray(moderator.clanTags) && moderator.clanTags.length)
        .sort((left, right) =>
            Number(right.discordId === options.currentUserId) - Number(left.discordId === options.currentUserId) ||
            safeInline(left.displayName || left.discordId).localeCompare(safeInline(right.displayName || right.discordId))
        );
    const workloadLines = workloadModerators.map(moderator => {
        const count = openCounts[moderator.discordId] || 0;
        const status = statusFor(moderator);
        const lastAssigned = workflow.discordRelativeTimestamp(moderator.lastAssignedAt);
        return `**${safeInline(moderator.displayName || moderator.discordId)}** \u00B7 ${count} active case${count === 1 ? '' : 's'} \u00B7 ${status}${lastAssigned ? ` \u00B7 last assignment ${lastAssigned}` : ''}`;
    });
    return { coverageLines, workloadLines, rosterSummaries };
}

function buildModeratorSettingsPayload(workspace, guildRecord, userIdRaw, displayNameRaw, options = {}) {
    const userId = toText(userIdRaw).trim();
    const preference = guildRecord?.moderators?.[userId] || {
        discordId: userId,
        displayName: displayNameRaw,
        clanTags: [],
        notificationMode: 'channel',
        accepting: false
    };
    const selectedClanTags = new Set((preference.clanTags || []).map(workflow.normalizeTag));
    const rosters = connectedRosters(workspace).slice(0, 25);
    const team = moderatorTeamSnapshot(workspace, guildRecord, {
        ...options,
        currentUserId: userId
    });
    const embed = new EmbedBuilder()
        .setColor(preference.accepting ? COLORS.success : COLORS.closed)
        .setTitle('Moderation settings')
        .setDescription([
            'Choose the clans you help with and where new assignment alerts should go.',
            'Turn on new assignments when you are ready. Changes save immediately.'
        ].join('\n'))
        .addFields(
            {
                name: 'Clans',
                value: selectedClanTags.size
                    ? truncate(rosters.filter(roster => selectedClanTags.has(workflow.normalizeTag(roster.clanTag)))
                        .map(roster => safeInline(roster.title || roster.clanTag)).join(', ') || 'Saved clans are no longer connected.', 1024)
                    : 'No clans selected'
            },
            { name: 'Notifications', value: preference.notificationMode === 'both' ? 'DM and channel alerts' : (preference.notificationMode === 'dm' ? 'DM alerts' : 'Channel alerts'), inline: true },
            { name: 'New assignments', value: preference.accepting ? 'On — accepting cases' : 'Paused', inline: true }
        );
    embed.addFields(
        {
            name: 'Team coverage',
            value: truncate(team.coverageLines.join('\n') || 'No connected clans are available.', 1024)
        },
        {
            name: 'Team workload',
            value: truncate(team.workloadLines.join('\n') || 'No moderators have selected clans yet.', 1024)
        }
    );
    const components = [];
    if (rosters.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('modclans'))
                .setPlaceholder('Choose clans')
                .setMinValues(0)
                .setMaxValues(rosters.length)
                .addOptions(rosters.map(roster =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(truncate(roster.title || roster.id, 100))
                        .setDescription(truncate(team.rosterSummaries.get(workflow.normalizeTag(roster.clanTag)) || roster.clanTag, 100))
                        .setValue(workflow.normalizeTag(roster.clanTag))
                        .setDefault(selectedClanTags.has(workflow.normalizeTag(roster.clanTag)))
                ))
        ));
    }
    components.push(
        new ActionRowBuilder().addComponents(
            actionButton('modnotify', 'DM', preference.notificationMode === 'dm' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'dm'),
            actionButton('modnotify', 'Channel', preference.notificationMode === 'channel' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'channel'),
            actionButton('modnotify', 'DM + channel', preference.notificationMode === 'both' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'both')
        ),
        new ActionRowBuilder().addComponents(
            actionButton('modtoggle', preference.accepting ? 'Pause new assignments' : 'Accept new assignments', preference.accepting ? ButtonStyle.Danger : ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
            actionButton('mycases', 'My cases', ButtonStyle.Secondary),
            actionButton('recent', 'Recent activity', ButtonStyle.Secondary, '0'),
            actionButton('home', 'All cases', ButtonStyle.Primary)
        )
    );
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function moderationCaseSummary(workspace, guildRecord, nowRaw = new Date()) {
    const items = (workspace?.work?.items || []).filter(item => ACTIVE_CASE_STATUSES.has(item.status));
    const nowMs = nowRaw instanceof Date ? nowRaw.getTime() : new Date(nowRaw).getTime();
    const assigned = items.filter(item => item.case?.assignedModeratorId || item.case?.handledBy);
    const unassigned = items.filter(item => !item.case?.assignedModeratorId && !item.case?.handledBy);
    const waitingIsDue = item => {
        const dueMs = workflow.parseMs(item.case?.waitingUntil);
        return item.status === 'waiting' && dueMs > 0 && dueMs <= nowMs;
    };
    const waiting = items.filter(item => item.status === 'waiting' && !waitingIsDue(item));
    const awaitingPlayer = waiting.filter(item =>
        item.case?.contactPurpose === 'general' && workflow.parseMs(item.case?.dmSentAt) > 0
    ).concat(items.filter(item =>
        item.status === 'needs_dm' && item.case?.contactPurpose === 'general' && Boolean(item.case?.dmQueueId)
    ));
    const scheduledWaiting = waiting.filter(item => !awaitingPlayer.includes(item));
    const actionable = items.filter(item =>
        item.status === 'needs_review' ||
        (item.status === 'needs_dm' && !item.case?.dmQueueId) ||
        item.status === 'ready' ||
        (item.status === 'removal_pending' && !item.case?.removalActionedAt) ||
        waitingIsDue(item)
    );
    const heroDownRecovery = items.filter(item => item.status === 'hero_down');
    const awaitingRemovalConfirmation = items.filter(item =>
        item.status === 'removal_pending' && Boolean(item.case?.removalActionedAt)
    );
    const overdue = items.filter(item => {
        const dueMs = workflow.parseMs(item.case?.waitingUntil);
        const anchorMs = workflow.parseMs(item.case?.lastMeaningfulActionAt || item.case?.assignedAt || item.case?.updatedAt);
        if (item.status === 'waiting' && dueMs > 0) return dueMs <= nowMs;
        return Boolean(item.case?.assignedModeratorId && anchorMs > 0 && nowMs - anchorMs >= 24 * 60 * 60 * 1000);
    });
    return {
        items,
        actionable,
        assigned,
        unassigned,
        waiting,
        awaitingPlayer,
        scheduledWaiting,
        heroDownRecovery,
        awaitingRemovalConfirmation,
        overdue
    };
}

function buildCoveragePayload(workspace, guildRecord, options = {}) {
    const moderators = Object.values(guildRecord?.moderators || {});
    const rosters = connectedRosters(workspace);
    const eligibleIds = options.eligibleIds instanceof Set ? options.eligibleIds : null;
    const coverageLines = rosters.map(roster => {
        const clanTag = workflow.normalizeTag(roster.clanTag);
        const subscribed = moderators.filter(moderator => (moderator.clanTags || []).map(workflow.normalizeTag).includes(clanTag));
        const labels = subscribed.map(moderator => {
            const eligible = moderator.accepting && (!eligibleIds || eligibleIds.has(moderator.discordId));
            return `${safeInline(moderator.displayName || moderator.discordId)}${eligible ? '' : ' (paused/ineligible)'}`;
        });
        return `**${safeInline(roster.title || clanTag)}** · ${labels.length ? labels.join(', ') : 'No coverage'}`;
    });
    const summary = moderationCaseSummary(workspace, guildRecord, options.now || new Date());
    const uncovered = rosters.filter(roster => !moderators.some(moderator =>
        moderator.accepting &&
        (!eligibleIds || eligibleIds.has(moderator.discordId)) &&
        (moderator.clanTags || []).map(workflow.normalizeTag).includes(workflow.normalizeTag(roster.clanTag))
    ));
    const embed = new EmbedBuilder()
        .setColor(uncovered.length || summary.unassigned.length || summary.overdue.length ? COLORS.review : COLORS.success)
        .setTitle('Moderation coverage overview')
        .setDescription(truncate(coverageLines.join('\n') || 'No connected clans are available.', 4000))
        .addFields(
            { name: 'No active coverage', value: uncovered.length ? truncate(uncovered.map(roster => safeInline(roster.title || roster.clanTag)).join(', '), 1024) : 'None' },
            { name: 'Case ownership', value: `Assigned **${summary.assigned.length}** · Unassigned **${summary.unassigned.length}**`, inline: true },
            {
                name: 'Case status',
                value: `Actionable **${summary.actionable.length}** · Awaiting replies **${summary.awaitingPlayer.length}** · Scheduled **${summary.scheduledWaiting.length}** · Hero-down recovery **${summary.heroDownRecovery.length}** · Removal confirmation **${summary.awaitingRemovalConfirmation.length}** · Overdue **${summary.overdue.length}**`,
                inline: true
            }
        );
    return {
        embeds: [embed],
        components: [new ActionRowBuilder().addComponents(
            actionButton('modsettings', 'My settings', ButtonStyle.Secondary),
            actionButton('mycases', 'My cases', ButtonStyle.Secondary),
            actionButton('home', 'Open queue', ButtonStyle.Primary)
        )],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

function personalCaseLine(item) {
    const meta = casePresentation(item);
    let state = meta.label;
    if (item.status === 'hero_down') state = 'Hero-down recovery';
    if (item.status === 'removal_pending' && item.case?.removalActionedAt) state = 'Awaiting removal confirmation';
    return `${meta.emoji} **${safeInline(item.player?.name || item.tag)}** · ${state} · \`${item.tag}\``;
}

function personalCaseGroupValue(items, emptyText) {
    if (!items.length) return emptyText;
    return truncate(items.map(personalCaseLine).join('\n'), 1024);
}

function buildMyCasesPayload(workspace, userIdRaw, options = {}) {
    const userId = toText(userIdRaw).trim();
    const pendingMutations = (Array.isArray(options.pendingMutations) ? options.pendingMutations : [])
        .filter(record => record && ['pending', 'conflict', 'failed'].includes(record.state))
        .slice(0, 25);
    const locallyHeldTags = new Set(pendingMutations.map(record => workflow.normalizeTag(record.tag)));
    const items = (workspace?.work?.items || []).filter(item =>
        ACTIVE_CASE_STATUSES.has(item.status) &&
        item.case?.assignedModeratorId === userId &&
        !locallyHeldTags.has(item.tag)
    );
    const summary = moderationCaseSummary({ work: { items } }, {}, options.now || new Date());
    const activeRecoveryOrRemoval = [
        ...summary.heroDownRecovery,
        ...summary.awaitingRemovalConfirmation
    ];
    const orderedItems = [
        ...summary.actionable,
        ...summary.awaitingPlayer,
        ...summary.scheduledWaiting,
        ...activeRecoveryOrRemoval
    ];
    const visibleItems = orderedItems.slice(0, 25);
    const visibleSet = new Set(visibleItems);
    const visible = category => category.filter(item => visibleSet.has(item));
    const hasModeratorPreference = Object.prototype.hasOwnProperty.call(options, 'moderatorPreference');
    const connectedClanTags = new Set(connectedRosters(workspace).map(roster => workflow.normalizeTag(roster.clanTag)));
    const selectedConnectedClan = (options.moderatorPreference?.clanTags || [])
        .map(workflow.normalizeTag)
        .some(clanTag => connectedClanTags.has(clanTag));
    const setupIncomplete = hasModeratorPreference && connectedClanTags.size > 0 && !selectedConnectedClan;
    const caseDescription = items.length || pendingMutations.length
        ? (summary.actionable.length
            ? '**Start with Needs action.** Waiting and active recovery cases remain visible for reference.'
            : (pendingMutations.some(record => record.state !== 'pending')
                ? '**A saved draft needs review.** Nothing was overwritten and its submitted text is still available.'
                : 'Nothing needs action right now. Waiting cases and saved changes remain visible for reference.')) +
                (items.length > visibleItems.length ? ` Showing 25 of ${items.length}; use **Full queue** for the rest.` : '')
        : 'You have no assigned moderation cases.';
    const embed = new EmbedBuilder()
        .setColor(summary.actionable.length || pendingMutations.some(record => record.state !== 'pending') ? COLORS.review : (items.length || pendingMutations.length ? COLORS.neutral : COLORS.success))
        .setTitle('My moderation cases')
        .setDescription([
            setupIncomplete ? '**Choose clans to finish your setup.** Select at least one clan to become eligible for automatic assignments.' : '',
            caseDescription
        ].filter(Boolean).join('\n\n'))
        .addFields(
            ...(pendingMutations.length ? [{
                name: `Saved changes (${pendingMutations.length})`,
                value: truncate(pendingMutations.map(record => {
                    const label = record.state === 'pending' ? 'Saving' : (record.state === 'conflict' ? 'Needs review' : 'Could not apply');
                    const icon = record.state === 'pending' ? 'â³' : 'âš ï¸';
                    return `${icon} **${mutationActionLabel(record.action)}** Â· ${label} Â· \`${record.tag}\``;
                }).join('\n'), 1024)
            }] : []),
            {
                name: `Needs action (${summary.actionable.length})`,
                value: personalCaseGroupValue(visible(summary.actionable), 'Nothing needs action right now.')
            },
            {
                name: `Awaiting player replies (${summary.awaitingPlayer.length})`,
                value: personalCaseGroupValue(visible(summary.awaitingPlayer), 'None')
            },
            ...(summary.scheduledWaiting.length ? [{
                name: `Scheduled follow-ups (${summary.scheduledWaiting.length})`,
                value: personalCaseGroupValue(visible(summary.scheduledWaiting), 'Open the full queue to view these cases.')
            }] : []),
            {
                name: `Active recovery/removal (${activeRecoveryOrRemoval.length})`,
                value: personalCaseGroupValue(visible(activeRecoveryOrRemoval), 'None')
            }
        );
    const components = [];
    if (pendingMutations.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pendingpick'))
                .setPlaceholder('Open a saved change')
                .addOptions(pendingMutations.map(record => new StringSelectMenuOptionBuilder()
                    .setLabel(truncate(`${mutationActionLabel(record.action)} Â· ${record.tag}`, 100))
                    .setDescription(truncate(record.state === 'pending' ? 'Saving; no action needed' : 'Open the preserved draft', 100))
                    .setValue(record.id)))
        ));
    }
    if (items.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pick'))
                .setPlaceholder('Open an assigned case')
                .addOptions(visibleItems.map(caseOption))
        ));
    }
    const settingsButton = actionButton(
        'modsettings',
        setupIncomplete ? 'Choose clans' : 'My settings',
        setupIncomplete ? ButtonStyle.Primary : ButtonStyle.Secondary
    );
    if (setupIncomplete) settingsButton.setEmoji('⚙️');
    components.push(new ActionRowBuilder().addComponents(
        settingsButton,
        actionButton('recent', 'Recent activity', ButtonStyle.Secondary, '0'),
        actionButton('home', 'Full queue', setupIncomplete ? ButtonStyle.Secondary : ButtonStyle.Primary)
    ));
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function buildSetupSummary(config, channelMention) {
    const labels = {
        caseAlerts: 'Case alerts',
        attackReminders: 'Attack reminders',
        regularWarSummaries: 'Regular-war summaries',
        cwlDailyUpdates: 'CWL all-clear updates',
        cwlEndSummaries: 'CWL end summaries',
        missingDiscordDigest: 'Daily Discord-link report',
        directMessages: 'Contact-player DMs with private reply capture'
    };
    const featureLines = Object.entries(labels).map(([key, label]) =>
        `${config.features?.[key] ? '✅' : '⬜'} ${label}`
    );
    const embed = new EmbedBuilder()
        .setColor(config.enabled ? COLORS.success : COLORS.closed)
        .setTitle('War Follow Up integration')
        .setDescription(config.enabled
            ? `Enabled in ${channelMention || `<#${config.channelId}>`}.`
            : 'Disabled. Existing cases and the web admin panel are unchanged.')
        .addFields(
            { name: 'Notification opt-ins', value: featureLines.join('\n') },
            { name: 'Staff ping', value: config.staffRoleId ? `<@&${config.staffRoleId}>` : 'None (alerts are posted without a role ping).' }
        )
        .setFooter({ text: 'No category is enabled implicitly. Run /war-follow-up setup again to change any option.' });
    return { embeds: [embed], flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function mutationActionLabel(actionRaw) {
    const labels = {
        contact: 'Player message',
        wait: 'Follow-up',
        watch: 'Monitoring decision',
        remove: 'Removal decision',
        resolve: 'Resolution',
        hero_down: 'Hero-down decision',
        extend: 'Recovery extension',
        add_note: 'Private note',
        mark_dm_sent: 'Delivered DM record',
        set_handler: 'Case handler'
    };
    return labels[toText(actionRaw).trim()] || 'Moderation change';
}

function buildMutationOutboxPayload(recordRaw) {
    const record = recordRaw && typeof recordRaw === 'object' ? recordRaw : {};
    const state = toText(record.state).trim();
    const pending = state === 'pending';
    const committed = state === 'committed';
    const conflict = state === 'conflict';
    const deliveredDmUpdate = record.action === 'mark_dm_sent' && record.request?.dmDeliveryMode === 'bot';
    const title = deliveredDmUpdate && !committed
        ? 'DM delivered; case update pending'
        : committed
        ? 'Change saved'
        : (conflict ? 'Saved draft needs review' : (state === 'failed' ? 'Saved draft could not be applied' : 'Change is being saved'));
    const summary = deliveredDmUpdate && !committed
        ? (conflict || state === 'failed'
            ? 'The DM was delivered, but the case changed before the delivery could be recorded. Do not resend it; compare the saved details with the current case.'
            : 'The DM was delivered. Its case record is still being saved. Do not send the message again.')
        : committed
        ? 'This change is now part of the case history.'
        : (conflict
            ? 'The case changed before this update could be saved. Nothing was overwritten. Reopen the current case and use the preserved draft below if it is still appropriate.'
            : (state === 'failed'
                ? 'This change could not be saved. Nothing was applied, and the submitted text remains available below.'
                : 'This change is still being saved. Nothing will be sent to the player until it succeeds.'));
    const draft = truncate(safeMultiline(record.draftPreview || 'No text fields were submitted.'), 3000);
    const timing = pending && record.nextAttemptAt
        ? `The next save attempt is ${workflow.discordRelativeTimestamp(record.nextAttemptAt)}.`
        : '';
    const description = [
        summary,
        timing,
        `**Preserved ${mutationActionLabel(record.action).toLowerCase()}**`,
        draft.split('\n').map(line => `> ${line || '\u200b'}`).join('\n')
    ].filter(Boolean).join('\n\n');
    const embed = new EmbedBuilder()
        .setColor(committed ? COLORS.success : (pending ? COLORS.neutral : COLORS.review))
        .setTitle(title)
        .setDescription(truncate(description, 4096))
        .setFooter({ text: pending ? 'Safe to close; check My cases for the latest status.' : 'The submitted text remains available until you discard this record.' });
    const buttons = [];
    if (pending) buttons.push(actionButton('pendingcheck', 'Check now', ButtonStyle.Primary, record.id));
    buttons.push(actionButton('casecurrent', 'Open current case', ButtonStyle.Secondary, record.tag));
    if (conflict || state === 'failed' || committed) {
        buttons.push(actionButton('pendingdiscard', committed ? 'Dismiss confirmation' : 'Discard saved draft', ButtonStyle.Secondary, record.id));
    }
    return {
        embeds: [embed],
        components: buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] }
    };
}

module.exports = {
    COLORS,
    EPHEMERAL,
    PAGE_SIZE,
    rosterToken,
    caseToken,
    statusCounts,
    pendingAttackCounts,
    discordGapCount,
    buildDashboardPayload,
    buildModerationHubPayload,
    buildRecentActivityPayload,
    buildAttentionPayload,
    buildHomePayload,
    buildCasePayload,
    buildEvidencePayload,
    buildActivityPayload,
    buildConversationPayload,
    buildConfirmationPayload,
    buildIgnoredCasePayload,
    buildHeroRosterPicker,
    buildGapsPayload,
    buildIgnoredPayload,
    buildRulesPayload,
    buildWatchModal,
    buildRemovalModal,
    buildResolveModal,
    buildHeroModal,
    buildExtendModal,
    buildNoteModal,
    buildMarkDmModal,
    buildContactModal,
    buildWaitModal,
    buildAssignmentModal,
    buildReassignmentPayload,
    buildRegularRulesModal,
    buildCwlRulesModal,
    buildWorkflowRulesModal,
    buildModeratorSettingsPayload,
    buildCoveragePayload,
    buildMyCasesPayload,
    moderationCaseSummary,
    moderationAttentionItems,
    buildSetupSummary,
    buildMutationOutboxPayload,
    navigationRow,
    asEditPayload,
    evidenceForDisplay
};
