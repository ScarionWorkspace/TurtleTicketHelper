'use strict';

const {
    ChannelType,
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const { isStaffMember } = require('../../features/permissions/staffPermissions');
const rosterPublicData = require('../../features/rosterPublicData/rosterPublicDataReadClient');
const workflow = require('../../features/warFollowup/workflow');
const service = require('../../features/warFollowup/service');
const views = require('../../features/warFollowup/views');
const moderation = require('../../features/warFollowup/moderation');
const { warFollowupStateStore } = require('../../features/warFollowup/stateStore');
const {
    ensureDashboard,
    ensureModerationHub,
    retireDashboard,
    retireModerationHub
} = require('../../features/warFollowup/dashboard');
const { initializeSummaryBaselines, runWarFollowupTick } = require('../../features/warFollowup/scheduler');

const FEATURE_OPTIONS = Object.freeze({
    'case-alerts': 'caseAlerts',
    'attack-reminders': 'attackReminders',
    'regular-summaries': 'regularWarSummaries',
    'cwl-daily-updates': 'cwlDailyUpdates',
    'cwl-end-summaries': 'cwlEndSummaries',
    'discord-gap-report': 'missingDiscordDigest',
    'direct-dms': 'directMessages'
});
const VALID_PLAYER_TAG_PATTERN = /^#[PYLQGRJCUV0289]{3,15}$/;

function addSetupOptions(subcommand) {
    subcommand
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('Dedicated staff channel for the dashboard and opted-in notifications.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addRoleOption(option => option
            .setName('staff-role')
            .setDescription('Optional role to tag when staff action is needed.'))
        .addBooleanOption(option => option
            .setName('clear-staff-role')
            .setDescription('Remove the configured staff-role ping.'))
        .addBooleanOption(option => option
            .setName('enabled')
            .setDescription('Enable or disable the Discord integration without changing its data.'));

    const descriptions = {
        'case-alerts': 'Tag staff when a case newly needs review, a DM, or a return decision.',
        'attack-reminders': 'Tag linked players with attacks left at 6h, 2h, and 30m.',
        'regular-summaries': 'Post one deduplicated summary after each regular war.',
        'cwl-daily-updates': 'Post when every tracked CWL attack for the active day is complete.',
        'cwl-end-summaries': 'Post the final CWL report, including everyone who missed attacks.',
        'discord-gap-report': 'Post one daily staff report for roster accounts without Discord links.',
        'direct-dms': 'Allow Contact player DMs and capture replies privately in the case.'
    };

    for (const optionName of Object.keys(FEATURE_OPTIONS)) {
        subcommand.addBooleanOption(option => option
            .setName(optionName)
            .setDescription(descriptions[optionName]));
    }
    return subcommand;
}

const data = new SlashCommandBuilder()
    .setName('war-follow-up')
    .setDescription('Private, opt-in war follow-up workflow for staff.')
    .addSubcommand(subcommand => subcommand
        .setName('panel')
        .setDescription('Open the private staff queue.'))
    .addSubcommand(subcommand => subcommand
        .setName('moderation')
        .setDescription('Choose clans, notifications, and assignment availability.'))
    .addSubcommand(subcommand => subcommand
        .setName('overview')
        .setDescription('Show clan coverage, ownership, and overdue cases.'))
    .addSubcommand(subcommand => subcommand
        .setName('mine')
        .setDescription('Show your currently assigned moderation cases.'))
    .addSubcommand(subcommand => subcommand
        .setName('publish-panel')
        .setDescription('Publish the self-updating Moderation Hub in a staff-only channel.')
        .addChannelOption(option => option
            .setName('channel')
            .setDescription('The staff-only channel where the panel should appear.')
            .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
            .setRequired(true)))
    .addSubcommand(subcommand => addSetupOptions(subcommand
        .setName('setup')
        .setDescription('Configure the dedicated channel and each notification opt-in.')))
    .addSubcommand(subcommand => subcommand
        .setName('case')
        .setDescription('Open or manually add one player follow-up.')
        .addStringOption(option => option
            .setName('player')
            .setDescription('Player name or tag.')
            .setRequired(true)
            .setAutocomplete(true)))
    .addSubcommand(subcommand => subcommand
        .setName('ignored')
        .setDescription('View and restore permanently ignored accounts.'))
    .addSubcommand(subcommand => subcommand
        .setName('rules')
        .setDescription('View or edit the shared War Follow Up rules.'))
    .addSubcommand(subcommand => subcommand
        .setName('status')
        .setDescription('Show the current Discord opt-ins and destination.'))
    .addSubcommand(subcommand => subcommand
        .setName('sync-now')
        .setDescription('Refresh the dashboard and process currently due opted-in notifications.'));

if (typeof data.setContexts === 'function') data.setContexts(InteractionContextType.Guild);
else data.setDMPermission(false);

function canWriteChannel(channel, interaction) {
    if (!channel || typeof channel.send !== 'function' || channel.isTextBased?.() === false) return false;
    const permissions = channel?.permissionsFor?.(interaction.guild?.members?.me);
    if (!permissions || typeof permissions.has !== 'function') return false;
    return permissions.has([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.EmbedLinks,
        PermissionFlagsBits.ReadMessageHistory
    ]);
}

function canMentionRole(role, channel, interaction) {
    if (role?.id && role.id === interaction?.guildId) return false;
    if (!role || role.mentionable === true) return true;
    const permissions = channel?.permissionsFor?.(interaction.guild?.members?.me);
    return Boolean(permissions?.has?.(PermissionFlagsBits.MentionEveryone));
}

function everyoneCanViewChannel(channel, interaction) {
    const everyoneRole = interaction?.guild?.roles?.everyone || interaction?.guild?.roles?.cache?.get?.(interaction.guildId);
    const permissions = everyoneRole ? channel?.permissionsFor?.(everyoneRole) : null;
    return Boolean(permissions?.has?.(PermissionFlagsBits.ViewChannel));
}

async function autocomplete(interaction) {
    if (!interaction.inGuild?.() || !isStaffMember(interaction.member)) {
        await interaction.respond([]);
        return;
    }
    const focused = toSearchText(interaction.options.getFocused?.());
    const payload = await rosterPublicData.readActiveRosterPayload({
        cacheTtlMs: 30_000,
        timeoutMs: 1_800
    });
    const directory = workflow.buildPlayerDirectory(payload, null);
    const choices = directory.players
        .filter(player => !focused || `${player.name} ${player.tag} ${player.rosterTitle}`.toLowerCase().includes(focused))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 25)
        .map(player => ({
            name: `${player.name} · ${player.tag} · ${player.rosterTitle || 'No roster'}`.slice(0, 100),
            value: player.tag
        }));
    await interaction.respond(choices);
}

function toSearchText(value) {
    return String(value || '').trim().toLowerCase();
}

function resolvePlayerInput(inputRaw, directoryRaw) {
    const raw = String(inputRaw || '').trim();
    if (!raw) throw new Error('Enter a player name or Clash player tag.');
    const directory = directoryRaw && typeof directoryRaw === 'object' ? directoryRaw : {};
    const players = Array.isArray(directory.players) ? directory.players : [];
    const normalizedTag = workflow.normalizeTag(raw);
    if (directory.byTag?.[normalizedTag]) return normalizedTag;
    if (directory.missingTags?.has?.(normalizedTag)) {
        throw new Error('That account is archived or missing from the active roster, so War Follow Up intentionally excludes it.');
    }

    const query = raw.toLocaleLowerCase('en');
    const exactMatches = players.filter(player =>
        String(player.name || '').trim().toLocaleLowerCase('en') === query
    );
    if (exactMatches.length === 1) return exactMatches[0].tag;
    if (exactMatches.length > 1) {
        throw new Error(`That name matches multiple accounts (${exactMatches.map(player => player.tag).join(', ')}). Choose one from autocomplete or enter its tag.`);
    }

    const partialMatches = query.length >= 2
        ? players.filter(player => String(player.name || '').toLocaleLowerCase('en').includes(query))
        : [];
    if (partialMatches.length === 1) return partialMatches[0].tag;
    if (partialMatches.length > 1) {
        throw new Error(`That search matches multiple accounts (${partialMatches.slice(0, 6).map(player => player.tag).join(', ')}${partialMatches.length > 6 ? ', …' : ''}). Choose one from autocomplete or enter its tag.`);
    }
    if (VALID_PLAYER_TAG_PATTERN.test(normalizedTag)) return normalizedTag;
    throw new Error('No roster account matches that name. Choose one from autocomplete or enter a valid Clash player tag.');
}

async function requireStaff(interaction) {
    if (!interaction.inGuild?.()) {
        await interaction.reply({ content: 'War Follow Up is available only inside the server.', flags: views.EPHEMERAL });
        return false;
    }
    if (!isStaffMember(interaction.member)) {
        await interaction.reply({ content: 'This command is staff only.', flags: views.EPHEMERAL });
        return false;
    }
    return true;
}

async function executeSetup(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const existing = warFollowupStateStore.getGuild(interaction.guildId);
    const selectedChannel = interaction.options.getChannel('channel');
    const selectedRole = interaction.options.getRole('staff-role');
    const clearStaffRole = interaction.options.getBoolean('clear-staff-role') === true;
    const enabledOption = interaction.options.getBoolean('enabled');
    const channelId = selectedChannel?.id || existing.config.channelId;
    const enabled = enabledOption == null
        ? (existing.config.configuredAt ? existing.config.enabled : true)
        : enabledOption;

    if (enabled && !channelId) {
        await interaction.editReply({ content: 'Choose a dedicated channel the first time you enable War Follow Up.' });
        return;
    }

    const features = {};
    for (const [optionName, featureKey] of Object.entries(FEATURE_OPTIONS)) {
        const selected = interaction.options.getBoolean(optionName);
        if (selected != null) features[featureKey] = selected;
    }
    const effectiveChannel = selectedChannel || (
        enabled && channelId
            ? interaction.guild?.channels?.cache?.get?.(channelId) ||
                await interaction.guild?.channels?.fetch?.(channelId).catch(() => null)
            : null
    );
    if (enabled && (!effectiveChannel || !canWriteChannel(effectiveChannel, interaction))) {
        await interaction.editReply({
            content: 'I need a valid channel with View Channel, Send Messages, Embed Links, and Read Message History before this integration can be enabled.'
        });
        return;
    }
    if (enabled && channelId === existing.moderationHub.channelId) {
        await interaction.editReply({
            content: 'The notification channel must stay separate from the Moderation Hub channel. Choose another channel for notifications.'
        });
        return;
    }
    const effectiveRoleId = selectedRole?.id || (clearStaffRole ? '' : existing.config.staffRoleId);
    const effectiveRole = selectedRole || (
        enabled && effectiveRoleId
            ? interaction.guild?.roles?.cache?.get?.(effectiveRoleId) ||
                await interaction.guild?.roles?.fetch?.(effectiveRoleId).catch(() => null)
            : null
    );
    if (enabled && effectiveRoleId === interaction.guildId) {
        await interaction.editReply({ content: 'Choose a dedicated staff role, not the @everyone role.' });
        return;
    }
    if (enabled && effectiveRoleId && !effectiveRole) {
        await interaction.editReply({
            content: 'The configured staff role no longer exists. Choose a replacement or set `clear-staff-role:true`.'
        });
        return;
    }
    if (enabled && effectiveRole && !canMentionRole(effectiveRole, effectiveChannel, interaction)) {
        await interaction.editReply({
            content: 'I cannot notify that role in the War Follow Up channel. Make the role mentionable, or grant the bot permission to mention roles, then retry.'
        });
        return;
    }
    const patch = { enabled, channelId, features };
    if (selectedRole) patch.staffRoleId = selectedRole.id;
    else if (clearStaffRole) patch.staffRoleId = '';
    const config = warFollowupStateStore.patchConfig(interaction.guildId, patch);

    if (config.enabled) {
        const workspace = await service.loadWorkspace({ forcePrivate: true });
        await ensureDashboard(interaction.client, interaction.guildId, workspace, config, {
            channel: effectiveChannel || undefined,
            force: true
        });
        initializeSummaryBaselines(warFollowupStateStore, interaction.guildId, workspace, config);
    }
    const dashboardMoved = Boolean(
        existing.dashboard.messageId &&
        (existing.dashboard.channelId || existing.config.channelId) &&
        (existing.dashboard.channelId || existing.config.channelId) !== config.channelId
    );
    const dashboardDisabled = Boolean(existing.dashboard.messageId && existing.config.enabled && !config.enabled);
    let retirementWarning = '';
    if (dashboardMoved || dashboardDisabled) {
        try {
            await retireDashboard(
                interaction.client,
                interaction.guildId,
                existing.dashboard.channelId || existing.config.channelId,
                existing.dashboard.messageId,
                {
                    reason: dashboardDisabled
                        ? 'The Discord integration was disabled.'
                        : 'This dashboard was moved.',
                    newChannelId: dashboardMoved && config.enabled ? config.channelId : ''
                }
            );
        } catch {
            retirementWarning = 'The new setup is saved, but I could not mark the old dashboard inactive. Remove that old message manually if it is still visible.';
        }
    }
    const summary = views.buildSetupSummary(config, selectedChannel?.toString());
    if (retirementWarning) summary.content = retirementWarning;
    await interaction.editReply(views.asEditPayload(summary));
}

async function executePanel(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    const config = warFollowupStateStore.getGuild(interaction.guildId).config;
    await interaction.editReply(views.asEditPayload(views.buildHomePayload(workspace, config)));
}

function interactionModeratorIdentity(interaction) {
    return {
        discordId: String(interaction.user?.id || interaction.member?.id || '').trim(),
        displayName: service.getActorName(interaction)
    };
}

async function eligibleModeratorIds(interaction, workspace, record) {
    const resolveMember = moderation.createMemberResolver(interaction.guild);
    const eligibleIds = new Set();
    for (const roster of workspace.work.directory.rosters || []) {
        const eligible = await moderation.getEligibleModerators(interaction.guild, record, roster.clanTag, { resolveMember });
        for (const moderator of eligible) eligibleIds.add(moderator.discordId);
    }
    return eligibleIds;
}

async function executeModeration(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    const identity = interactionModeratorIdentity(interaction);
    const record = warFollowupStateStore.getGuild(interaction.guildId);
    const eligibleIdsForGuild = await eligibleModeratorIds(interaction, workspace, record);
    await interaction.editReply(views.asEditPayload(views.buildModeratorSettingsPayload(
        workspace,
        record,
        identity.discordId,
        identity.displayName,
        { eligibleIds: eligibleIdsForGuild }
    )));
}

async function executeOverview(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    const record = warFollowupStateStore.getGuild(interaction.guildId);
    const eligibleIdsForGuild = await eligibleModeratorIds(interaction, workspace, record);
    await interaction.editReply(views.asEditPayload(views.buildCoveragePayload(workspace, record, {
        eligibleIds: eligibleIdsForGuild
    })));
}

async function executeMine(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    await interaction.editReply(views.asEditPayload(views.buildMyCasesPayload(
        workspace,
        interactionModeratorIdentity(interaction).discordId
    )));
}

async function executePublishPanel(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const selectedChannel = interaction.options.getChannel('channel', true);
    const existing = warFollowupStateStore.getGuild(interaction.guildId);
    if (!existing.config.enabled || !existing.config.channelId) {
        await interaction.editReply({ content: 'Enable War Follow Up with `/war-follow-up setup` before publishing the Moderation Hub.' });
        return;
    }
    if (selectedChannel.id === existing.config.channelId) {
        await interaction.editReply({
            content: 'Choose a separate staff-only panel channel. Assignment pings and summaries must remain in the existing notification channel.'
        });
        return;
    }
    if (!canWriteChannel(selectedChannel, interaction)) {
        await interaction.editReply({
            content: 'I need View Channel, Send Messages, Embed Links, and Read Message History in the panel channel.'
        });
        return;
    }
    if (everyoneCanViewChannel(selectedChannel, interaction)) {
        await interaction.editReply({
            content: 'The Moderation Hub must be staff-only. Disable View Channel for `@everyone`, grant access to the appropriate leader roles, then publish it again.'
        });
        return;
    }
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    const published = await ensureModerationHub(
        interaction.client,
        interaction.guildId,
        workspace,
        { channel: selectedChannel, force: true }
    );
    let retirementWarning = '';
    if (
        existing.moderationHub.messageId &&
        existing.moderationHub.channelId &&
        existing.moderationHub.channelId !== selectedChannel.id
    ) {
        try {
            await retireModerationHub(
                interaction.client,
                interaction.guildId,
                existing.moderationHub.channelId,
                existing.moderationHub.messageId,
                { reason: 'This Moderation Hub was moved.', newChannelId: selectedChannel.id }
            );
        } catch {
            retirementWarning = ' The previous panel could not be marked inactive; remove that old bot message manually if it remains visible.';
        }
    }
    await interaction.editReply({
        content: `Moderation Hub published in ${selectedChannel}. It will update in place and will not post notifications in that channel.${retirementWarning}`,
        allowedMentions: { parse: [] },
        components: [],
        embeds: []
    });
    return published;
}

async function executeCase(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const input = interaction.options.getString('player', true);
    let workspace = await service.loadWorkspace({ forcePrivate: true });
    const tag = resolvePlayerInput(input, workspace.work.directory);
    let item = workspace.work.items.find(candidate => candidate.tag === tag);
    if (!item) {
        item = await service.ensureManualCase(
            tag,
            workspace,
            service.getActorName(interaction),
            `${interaction.id}:manual:${tag}`
        );
        workspace = await service.loadWorkspace({ forcePrivate: true });
        item = workspace.work.items.find(candidate => candidate.tag === tag) || item;
    }
    if (item && moderation.isOpenItem(item) && !item.case?.assignedModeratorId && !item.case?.handledBy) {
        const eligible = await moderation.getEligibleModerators(
            interaction.guild,
            warFollowupStateStore.getGuild(interaction.guildId),
            moderation.caseClanTag(item)
        );
        const chosen = moderation.chooseModerator(eligible, workspace.work.items, { nowMs: Date.now() });
        if (chosen) {
            const assigned = await service.mutateCase(item, 'assign_owner', moderation.assignmentPatch(chosen), {
                actor: 'War Follow Up',
                seed: `${interaction.id}:manual-assign:${tag}:${chosen.discordId}`
            });
            warFollowupStateStore.recordModeratorAssignment(interaction.guildId, chosen.discordId, assigned?.assignedAt || new Date());
            workspace = await service.loadWorkspace({ forcePrivate: true });
            item = workspace.work.items.find(candidate => candidate.tag === tag) || item;
        }
    }
    const config = warFollowupStateStore.getGuild(interaction.guildId).config;
    await interaction.editReply(views.asEditPayload(views.buildCasePayload(item, workspace, config)));
}

async function executeSimpleView(interaction, viewName) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const workspace = await service.loadWorkspace({ forcePrivate: true });
    const payload = viewName === 'ignored'
        ? views.buildIgnoredPayload(workspace)
        : views.buildRulesPayload(workspace);
    await interaction.editReply(views.asEditPayload(payload));
}

async function executeStatus(interaction) {
    const config = warFollowupStateStore.getGuild(interaction.guildId).config;
    await interaction.reply(views.buildSetupSummary(config));
}

async function executeSyncNow(interaction) {
    await interaction.deferReply({ flags: views.EPHEMERAL });
    const config = warFollowupStateStore.getGuild(interaction.guildId).config;
    if (!config.enabled || !config.channelId) {
        await interaction.editReply({
            content: 'War Follow Up is not enabled yet. Run `/war-follow-up setup` first.',
            components: [],
            embeds: [],
            allowedMentions: { parse: [] }
        });
        return;
    }
    const result = await runWarFollowupTick(interaction.client);
    if (result.skipped && result.reason === 'already-running') {
        await interaction.editReply({
            content: 'War Follow Up is already refreshing. The dashboard and any due notifications will be ready shortly.',
            components: [],
            embeds: [],
            allowedMentions: { parse: [] }
        });
        return;
    }
    const guildResult = result.results?.find(entry => entry.guildId === interaction.guildId);
    if (!guildResult) {
        await interaction.editReply({
            content: 'War Follow Up could not refresh this server. Run setup again and try once more.',
            components: [],
            embeds: [],
            allowedMentions: { parse: [] }
        });
        return;
    }
    if (guildResult.error) {
        await interaction.editReply({
            content: 'War Follow Up could not refresh right now. No settings were changed; try again shortly.',
            components: [],
            embeds: [],
            allowedMentions: { parse: [] }
        });
        return;
    }
    const sentCount = guildResult?.sent?.length || 0;
    await interaction.editReply({
        content: `War Follow Up is up to date. ${sentCount} due notification${sentCount === 1 ? '' : 's'} sent.`,
        components: [],
        embeds: [],
        allowedMentions: { parse: [] }
    });
}

async function execute(interaction) {
    if (!await requireStaff(interaction)) return;
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'setup') return executeSetup(interaction);
    if (subcommand === 'panel') return executePanel(interaction);
    if (subcommand === 'moderation') return executeModeration(interaction);
    if (subcommand === 'overview') return executeOverview(interaction);
    if (subcommand === 'mine') return executeMine(interaction);
    if (subcommand === 'publish-panel') return executePublishPanel(interaction);
    if (subcommand === 'case') return executeCase(interaction);
    if (subcommand === 'ignored' || subcommand === 'rules') return executeSimpleView(interaction, subcommand);
    if (subcommand === 'status') return executeStatus(interaction);
    if (subcommand === 'sync-now') return executeSyncNow(interaction);
    throw new Error('Unknown War Follow Up command.');
}

module.exports = {
    data,
    autocomplete,
    execute,
    FEATURE_OPTIONS,
    canWriteChannel,
    canMentionRole,
    everyoneCanViewChannel,
    resolvePlayerInput
};
