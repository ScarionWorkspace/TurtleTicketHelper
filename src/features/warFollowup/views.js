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
        actionButton('modsettings', 'Moderation settings', ButtonStyle.Secondary),
        actionButton('coverage', 'Coverage overview', ButtonStyle.Secondary)
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
            ? `${accepting.length} available${subscribed.length > accepting.length ? ` · ${subscribed.length - accepting.length} paused` : ''}`
            : (subscribed.length ? `${subscribed.length} paused` : 'needs coverage');
        return `${indicator} **${safeInline(roster.title || clanTag)}** · ${detail}`;
    });
    const coveredClanCount = rosters.filter(roster => moderators.some(moderator =>
        moderator.accepting &&
        (moderator.clanTags || []).map(workflow.normalizeTag).includes(workflow.normalizeTag(roster.clanTag))
    )).length;
    const snapshot = workflow.discordRelativeTimestamp(workspace?.rosterData?.lastUpdatedAt);
    const attention = summary.unassigned.length + summary.overdue.length;
    const ownerAttention = summary.unassigned.length === 1
        ? '1 needs an owner'
        : `${summary.unassigned.length} need owners`;
    const leaderAvailability = `${activeModerators.length} available leader${activeModerators.length === 1 ? '' : 's'}`;
    const semantic = JSON.stringify({
        rosters: rosters.map(roster => [roster.id, roster.title, workflow.normalizeTag(roster.clanTag)]),
        moderators: moderators.map(moderator => [
            moderator.discordId,
            moderator.accepting,
            moderator.clanTags
        ]).sort((left, right) => left[0].localeCompare(right[0])),
        cases: {
            assigned: summary.assigned.length,
            unassigned: summary.unassigned.length,
            waiting: summary.waiting.length,
            overdue: summary.overdue.length
        },
        pending,
        notificationChannelId: guildRecord?.config?.channelId || '',
        lastUpdatedAt: workspace?.rosterData?.lastUpdatedAt || ''
    });
    const embed = new EmbedBuilder()
        .setColor(attention || coveredClanCount < rosters.length ? COLORS.review : COLORS.success)
        .setTitle('🛡️ Moderation Hub')
        .setDescription([
            '**Choose the clans you can help with.** Cases are assigned automatically based on current workload.',
            'Start with **Set up my coverage** below. Your settings and all case details open privately.'
        ].join('\n'))
        .addFields(
            {
                name: 'Clan coverage',
                value: truncate(coverageLines.join('\n') || 'No connected clan rosters are currently available.', 1024)
            },
            {
                name: 'At a glance',
                value: [
                    `📁 **${summary.items.length} open** · ${summary.assigned.length} assigned`,
                    `⚠️ **${ownerAttention}** · ${summary.overdue.length} overdue`,
                    `⏳ **${summary.waiting.length} waiting**`,
                    `👥 **${leaderAvailability}** · ${coveredClanCount}/${rosters.length} clans covered`
                ].join('\n')
            },
            {
                name: 'War status',
                value: [
                    `⚔️ Regular: **${pending.regularAttacks} attacks** / ${pending.regularPlayers} players open`,
                    `🏆 CWL: **${pending.cwlPlayers} attacks open**`,
                    [
                        snapshot ? `Updated ${snapshot}` : 'Update time unavailable',
                        guildRecord?.config?.channelId ? `alerts in <#${guildRecord.config.channelId}>` : ''
                    ].filter(Boolean).join(' · ')
                ].join('\n')
            }
        )
        .setFooter({ text: 'Auto-updating · Fair workload assignment · 24h/48h reminders · 72h reassignment' });

    return {
        payload: {
            content: '',
            embeds: [embed],
            components: [
                new ActionRowBuilder().addComponents(
                    actionButton('modsettings', 'Set up my coverage', ButtonStyle.Primary).setEmoji('⚙️'),
                    actionButton('mycases', 'My cases', ButtonStyle.Secondary).setEmoji('📥')
                ),
                new ActionRowBuilder().addComponents(
                    actionButton('coverage', 'Clan coverage', ButtonStyle.Secondary).setEmoji('🗺️'),
                    actionButton('home', 'All cases', ButtonStyle.Secondary).setEmoji('📋')
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
    const actionable = counts.needs_review + counts.needs_dm + counts.ready;
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
    const meta = workflow.STATUS_META[item.status] || workflow.STATUS_META.needs_review;
    const description = item.signals?.length
        ? item.signals.map(signal => signal.title).join(', ')
        : meta.next;
    return new StringSelectMenuOptionBuilder()
        .setLabel(truncate(`${meta.emoji} ${item.player?.name || item.tag}`, 100))
        .setDescription(truncate(`${meta.label} · ${description}`, 100))
        .setValue(item.tag);
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
        const meta = workflow.STATUS_META[item.status] || workflow.STATUS_META.needs_review;
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
            value: `Review ${counts.needs_review} · Waiting ${counts.waiting} · DM ${counts.needs_dm} · Hero-down ${counts.hero_down} · Ready ${counts.ready} · Watching ${counts.watching} · Closed ${counts.closed}`
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
        actionButton('filter', `Hero-down (${counts.hero_down})`, status === 'hero_down' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'hero_down'),
        actionButton('filter', `Ready (${counts.ready})`, status === 'ready' ? ButtonStyle.Success : ButtonStyle.Secondary, 'ready'),
        actionButton('filter', `Watching (${counts.watching})`, status === 'watching' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'watching')
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

function activityValue(item) {
    const activity = Array.isArray(item?.case?.activity) ? item.case.activity.slice(-5).reverse() : [];
    if (!activity.length) return 'No private activity yet.';
    return activity.map(entry => {
        const date = workflow.formatDate(entry.at);
        const actor = entry.actor ? ` · ${safeInline(entry.actor)}` : '';
        return `• ${date || 'Unknown date'}${actor} — ${truncate(safeInline(entry.text || entry.type), 180)}`;
    }).join('\n').slice(0, 1024);
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
            new ActionRowBuilder().addComponents(actionButton('case', 'Back to follow-up', ButtonStyle.Primary, item.tag)),
            navigationRow()
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
                actionButton('activity', 'Next', ButtonStyle.Secondary, item.tag, token, String(page + 1)).setDisabled(page >= pageCount - 1)
            ),
            navigationRow()
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
    const meta = workflow.STATUS_META[item.status] || workflow.STATUS_META.needs_review;
    const player = item.player || {};
    const shownEvidence = evidenceForDisplay(item);
    const embed = new EmbedBuilder()
        .setColor(item.status === 'ready' ? COLORS.success : (item.status === 'closed' ? COLORS.closed : COLORS.review))
        .setTitle(truncate(`${meta.emoji} ${player.name || item.tag}`, 256))
        .setDescription([
            `\`${item.tag}\` · ${safeInline(player.rosterTitle || 'No current roster')} · TH${player.th || '?'}`,
            `Discord: ${player.discordId ? `<@${player.discordId}>` : safeInline(player.discord || 'Not linked')}`,
            `**${meta.label}:** ${meta.next}`
        ].join('\n'))
        .addFields(
            { name: shownEvidence.usesDecisionEvidence ? 'Decision evidence · regular' : 'Regular-war evidence', value: evidenceValue(shownEvidence.evidence?.regular), inline: true },
            { name: shownEvidence.usesDecisionEvidence ? 'Decision evidence · CWL' : 'CWL evidence', value: evidenceValue(shownEvidence.evidence?.cwl), inline: true }
        );

    if (item.signals?.length) {
        embed.addFields({
            name: 'Why this is here',
            value: item.signals.map(signal => `• **${safeInline(signal.title)}:** ${safeInline(signal.text)}`).join('\n').slice(0, 1024)
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
            name: 'Watch progress',
            value: `${item.watching.completedWars}/${item.watching.targetWars} regular wars observed`
        });
    }
    embed.addFields({
        name: 'Assigned moderator',
        value: safeInline(item.case?.assignedModeratorName || item.case?.handledBy || 'Unassigned'),
        inline: true
    });
    if (item.case?.sourceRosterTitle || item.case?.sourceClanTag) {
        embed.addFields({
            name: 'Case source snapshot',
            value: [safeInline(item.case.sourceRosterTitle), workflow.normalizeTag(item.case.sourceClanTag)].filter(Boolean).join(' · '),
            inline: true
        });
    }
    if (item.case?.waitingUntil) embed.addFields({ name: 'Follow-up due', value: workflow.discordRelativeTimestamp(item.case.waitingUntil), inline: true });
    if (item.case?.escalatedAt) embed.addFields({ name: 'Leadership review', value: `Escalated ${workflow.discordRelativeTimestamp(item.case.escalatedAt)}`, inline: true });
    if (item.case?.targetRosterTitle) embed.addFields({ name: 'Hero-down roster', value: safeInline(item.case.targetRosterTitle), inline: true });
    if (item.case?.dmText && item.status === 'needs_dm') {
        embed.addFields({ name: 'Decision message', value: truncate(toText(item.case.dmText).replace(/`/g, "'"), 1000) });
    }
    if (item.case) embed.addFields({ name: 'Recent private activity', value: activityValue(item) });

    const components = [];
    const tag = item.tag;
    const token = caseToken(item);
    if (item.status === 'needs_review') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('dismiss', 'No action', ButtonStyle.Secondary, tag, token),
            actionButton('watch', 'Keep watching', ButtonStyle.Secondary, tag, token),
            actionButton('hero', 'Hero-down period', ButtonStyle.Primary, tag, token)
        ));
        components.push(new ActionRowBuilder().addComponents(
            actionButton('contact', 'Contact player', ButtonStyle.Primary, tag, token),
            actionButton('wait', 'Mark waiting', ButtonStyle.Secondary, tag, token),
            actionButton('resolve', 'Resolve', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
    } else if (item.status === 'needs_dm') {
        const row = new ActionRowBuilder();
        if (config?.features?.directMessages === true && player.discordId) {
            row.addComponents(actionButton('senddm', 'Send DM now', ButtonStyle.Success, tag, token));
        }
        row.addComponents(
            actionButton('markdm', 'Mark DM sent', ButtonStyle.Primary, tag, token),
            actionButton('reopen', 'Change decision', ButtonStyle.Secondary, tag, token)
        );
        components.push(row);
        components.push(new ActionRowBuilder().addComponents(
            actionButton('wait', 'Mark waiting', ButtonStyle.Secondary, tag, token),
            actionButton('resolve', 'Resolve', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token),
            actionButton('dismiss', 'Dismiss', ButtonStyle.Secondary, tag, token)
        ));
    } else if (item.status === 'hero_down' || item.status === 'ready') {
        const row = new ActionRowBuilder();
        if (item.recovery?.ready) row.addComponents(actionButton('approve', 'Approve return', ButtonStyle.Success, tag, token));
        row.addComponents(
            actionButton('extend', 'Extend period', ButtonStyle.Secondary, tag, token),
            actionButton('closeask', 'Close without return', ButtonStyle.Danger, tag, token),
            actionButton('wait', 'Mark waiting', ButtonStyle.Secondary, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        );
        components.push(row);
        components.push(new ActionRowBuilder().addComponents(
            actionButton('dismiss', 'Dismiss case', ButtonStyle.Secondary, tag, token)
        ));
    } else if (item.status === 'waiting') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('reopen', 'Review now', ButtonStyle.Primary, tag, token),
            actionButton('wait', 'Change follow-up', ButtonStyle.Secondary, tag, token),
            actionButton('resolve', 'Resolve', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token),
            actionButton('dismiss', 'Dismiss', ButtonStyle.Secondary, tag, token)
        ));
    } else if (item.status === 'watching') {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('reopen', 'Review now', ButtonStyle.Primary, tag, token),
            actionButton('dismiss', 'No action', ButtonStyle.Secondary, tag, token),
            actionButton('wait', 'Mark waiting', ButtonStyle.Secondary, tag, token),
            actionButton('resolve', 'Resolve', ButtonStyle.Success, tag, token),
            actionButton('escalate', 'Escalate', ButtonStyle.Danger, tag, token)
        ));
    } else {
        components.push(new ActionRowBuilder().addComponents(
            actionButton('reopen', 'Reopen', ButtonStyle.Secondary, tag, token)
        ));
    }

    components.push(new ActionRowBuilder().addComponents(
        actionButton('assignment', item.case?.assignedModeratorId || item.case?.handledBy ? 'Reassign' : 'Assign', ButtonStyle.Secondary, tag, token),
        actionButton('note', 'Add private note', ButtonStyle.Secondary, tag, token),
        actionButton('evidence', 'War details', ButtonStyle.Secondary, tag, token),
        actionButton('activity', 'Activity', ButtonStyle.Secondary, tag, token, '0'),
        actionButton('ignoreask', 'Always ignore', ButtonStyle.Danger, tag, token)
    ));
    components.push(moderationNavigationRow(), navigationRow());
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

function buildHeroRosterPicker(item, workspace, options = {}) {
    const extending = options.extending === true;
    const rosters = (Array.isArray(workspace?.work?.directory?.rosters) ? workspace.work.directory.rosters : [])
        .filter(roster => workflow.normalizeTag(roster.clanTag));
    if (!rosters.length) {
        return { content: 'No connected roster is available for a hero-down period.', components: [navigationRow()], flags: EPHEMERAL };
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
        components: [new ActionRowBuilder().addComponents(select), navigationRow()],
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
    return modal('Keep watching', buildCustomId('watchform', item.tag, caseToken(item)), [
        textInput('wars', 'Regular wars to observe (1-8)', item.case?.watchWarTarget || 2, { maxLength: 1 })
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
    return modal('Prepare player contact', buildCustomId('contactform', item.tag, caseToken(item)), [
        textInput('message', 'Message to the player', `Hi ${playerName}. A leader is reviewing your recent war activity and would like to follow up with you.`, {
            style: TextInputStyle.Paragraph,
            maxLength: 2000
        })
    ]);
}

function buildWaitModal(item) {
    return modal('Mark case as waiting', buildCustomId('waitform', item.tag, caseToken(item)), [
        textInput('hours', 'Follow-up hours (0, 24, 48, or 72)', '24', { maxLength: 2 }),
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

function buildReassignmentPayload(item, moderatorsRaw) {
    const moderators = Array.isArray(moderatorsRaw) ? moderatorsRaw : [];
    const options = [
        new StringSelectMenuOptionBuilder()
            .setLabel('Assign automatically')
            .setDescription('Use current clan coverage and workload balancing.')
            .setValue('__auto__')
    ];
    for (const moderator of moderators.slice(0, 24)) {
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
            .setDescription(`Eligible moderators for **${safeInline(item.case?.sourceRosterTitle || item.player?.rosterTitle || 'this clan')}** are shown below.`)],
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

function buildModeratorSettingsPayload(workspace, guildRecord, userIdRaw, displayNameRaw) {
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
    const embed = new EmbedBuilder()
        .setColor(preference.accepting ? COLORS.success : COLORS.closed)
        .setTitle('My moderation coverage')
        .setDescription([
            '**1.** Select the clans you can help with.',
            '**2.** Choose where assignment notifications should arrive.',
            '**3.** Turn on accepting assignments when you are ready.',
            'Changes save immediately. All case details stay private.'
        ].join('\n'))
        .addFields(
            {
                name: 'My clans',
                value: selectedClanTags.size
                    ? truncate(rosters.filter(roster => selectedClanTags.has(workflow.normalizeTag(roster.clanTag)))
                        .map(roster => safeInline(roster.title || roster.clanTag)).join(', ') || 'Saved clans are no longer connected.', 1024)
                    : 'No clans selected'
            },
            { name: 'Notifications', value: preference.notificationMode === 'both' ? 'DM and moderation-channel ping' : (preference.notificationMode === 'dm' ? 'DM' : 'Moderation-channel ping'), inline: true },
            { name: 'Status', value: preference.accepting ? 'Accepting new cases' : 'Paused', inline: true }
        );
    const components = [];
    if (rosters.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('modclans'))
                .setPlaceholder('Step 1 · Select my clans')
                .setMinValues(0)
                .setMaxValues(rosters.length)
                .addOptions(rosters.map(roster =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(truncate(roster.title || roster.id, 100))
                        .setDescription(truncate(roster.clanTag, 100))
                        .setValue(workflow.normalizeTag(roster.clanTag))
                        .setDefault(selectedClanTags.has(workflow.normalizeTag(roster.clanTag)))
                ))
        ));
    }
    components.push(
        new ActionRowBuilder().addComponents(
            actionButton('modnotify', 'Notify by DM', preference.notificationMode === 'dm' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'dm'),
            actionButton('modnotify', 'Notify in channel', preference.notificationMode === 'channel' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'channel'),
            actionButton('modnotify', 'DM + channel', preference.notificationMode === 'both' ? ButtonStyle.Primary : ButtonStyle.Secondary, 'both')
        ),
        new ActionRowBuilder().addComponents(
            actionButton('modtoggle', preference.accepting ? 'Pause assignments' : 'Accept assignments', preference.accepting ? ButtonStyle.Danger : ButtonStyle.Success)
        ),
        new ActionRowBuilder().addComponents(
            actionButton('mycases', 'My cases', ButtonStyle.Secondary),
            actionButton('coverage', 'Coverage overview', ButtonStyle.Secondary),
            actionButton('home', 'Open queue', ButtonStyle.Primary)
        )
    );
    return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}

function moderationCaseSummary(workspace, guildRecord, nowRaw = new Date()) {
    const items = (workspace?.work?.items || []).filter(item => item.status !== 'closed');
    const nowMs = nowRaw instanceof Date ? nowRaw.getTime() : new Date(nowRaw).getTime();
    const assigned = items.filter(item => item.case?.assignedModeratorId || item.case?.handledBy);
    const unassigned = items.filter(item => !item.case?.assignedModeratorId && !item.case?.handledBy);
    const waiting = items.filter(item => item.status === 'waiting');
    const overdue = items.filter(item => {
        const dueMs = workflow.parseMs(item.case?.waitingUntil);
        const anchorMs = workflow.parseMs(item.case?.lastMeaningfulActionAt || item.case?.assignedAt || item.case?.updatedAt);
        if (item.status === 'waiting' && dueMs > 0) return dueMs <= nowMs;
        return Boolean(item.case?.assignedModeratorId && anchorMs > 0 && nowMs - anchorMs >= 24 * 60 * 60 * 1000);
    });
    return { items, assigned, unassigned, waiting, overdue };
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
            { name: 'Open cases', value: `Assigned **${summary.assigned.length}** · Unassigned **${summary.unassigned.length}**`, inline: true },
            { name: 'Attention', value: `Waiting **${summary.waiting.length}** · Overdue **${summary.overdue.length}**`, inline: true }
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

function buildMyCasesPayload(workspace, userIdRaw) {
    const userId = toText(userIdRaw).trim();
    const items = (workspace?.work?.items || []).filter(item =>
        item.status !== 'closed' && item.case?.assignedModeratorId === userId
    );
    const visibleItems = items.slice(0, 25);
    const lines = visibleItems.map(item => {
        const meta = workflow.STATUS_META[item.status] || workflow.STATUS_META.needs_review;
        return `${meta.emoji} **${safeInline(item.player?.name || item.tag)}** · ${meta.label} · \`${item.tag}\``;
    });
    if (items.length > visibleItems.length) lines.push(`…and ${items.length - visibleItems.length} more in the full queue.`);
    const embed = new EmbedBuilder()
        .setColor(items.length ? COLORS.neutral : COLORS.success)
        .setTitle('My assigned moderation cases')
        .setDescription(truncate(lines.join('\n') || 'You have no open assigned cases.', 4096));
    const components = [];
    if (items.length) {
        components.push(new ActionRowBuilder().addComponents(
            new StringSelectMenuBuilder()
                .setCustomId(buildCustomId('pick'))
                .setPlaceholder('Open one of my cases')
                .addOptions(visibleItems.map(caseOption))
        ));
    }
    components.push(new ActionRowBuilder().addComponents(
        actionButton('modsettings', 'My settings', ButtonStyle.Secondary),
        actionButton('coverage', 'Coverage overview', ButtonStyle.Secondary),
        actionButton('home', 'Full queue', ButtonStyle.Primary)
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
        missingDiscordDigest: 'Daily Discord-gap digest',
        directMessages: 'Staff-triggered direct DMs'
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
    buildHomePayload,
    buildCasePayload,
    buildEvidencePayload,
    buildActivityPayload,
    buildConfirmationPayload,
    buildHeroRosterPicker,
    buildGapsPayload,
    buildIgnoredPayload,
    buildRulesPayload,
    buildWatchModal,
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
    buildSetupSummary,
    navigationRow,
    asEditPayload,
    evidenceForDisplay
};
