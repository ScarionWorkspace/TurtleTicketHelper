const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterFirebase = require('../rosterFirebase/rosterFirebaseReadClient');
const { isSeasonEventAdmin } = require('../seasonEvents/permissions');

const CUSTOM_ID_PREFIX = 'cwl:v1';
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
const DISCORD_BUTTON_LABEL_MAX_LENGTH = 80;
const DISCORD_SELECT_LABEL_MAX_LENGTH = 100;
const DISCORD_SELECT_DESCRIPTION_MAX_LENGTH = 100;
const DISCORD_MESSAGE_SAFE_LENGTH = 1900;
const DISCORD_BUTTONS_PER_MESSAGE = 25;
const DISCORD_SELECT_OPTIONS_MAX = 25;
const DISCORD_ACTION_ROWS_MAX = 5;

function normalizePlayerTag(tag) {
    let cleaned = String(tag || '').trim().toUpperCase().replace(/\s+/g, '');

    if (!cleaned) {
        return '';
    }

    if (!cleaned.startsWith('#')) {
        cleaned = `#${cleaned}`;
    }

    return cleaned.replace(/O/g, '0');
}

function buildCustomId(action, ...parts) {
    const suffix = parts
        .filter(part => part !== null && part !== undefined && part !== '')
        .map(part => encodeURIComponent(String(part)))
        .join(':');
    const customId = `${CUSTOM_ID_PREFIX}:${action}${suffix ? `:${suffix}` : ''}`;

    if (customId.length > DISCORD_CUSTOM_ID_MAX_LENGTH) {
        throw new Error(`CWL signup component id exceeds Discord's ${DISCORD_CUSTOM_ID_MAX_LENGTH} character limit.`);
    }

    return customId;
}

function parseCustomId(customId) {
    const parts = String(customId || '').split(':');

    if (parts[0] !== 'cwl' || parts[1] !== 'v1') {
        return null;
    }

    return {
        action: parts[2] || '',
        parts: parts.slice(3).map(part => {
            try {
                return decodeURIComponent(part);
            } catch {
                return part;
            }
        })
    };
}

function isCwlSignupCustomId(customId) {
    return String(customId || '').startsWith(`${CUSTOM_ID_PREFIX}:`);
}

function buildDiscordUser(interaction) {
    const memberDisplayName = interaction.member?.displayName || '';
    const user = interaction.user || {};

    return {
        id: String(user.id || '').trim(),
        username: String(user.username || '').trim(),
        globalName: String(user.globalName || '').trim(),
        displayName: memberDisplayName || String(user.globalName || user.username || '').trim()
    };
}

function getPreferenceMap(signups) {
    return signups?.preferencesByTag && typeof signups.preferencesByTag === 'object'
        ? signups.preferencesByTag
        : {};
}

function truncate(value, maxLength) {
    const text = String(value || '').trim();
    const limit = Math.max(0, Number(maxLength) || 0);

    if (!limit || text.length <= limit) {
        return text;
    }

    if (limit <= 3) {
        return text.slice(0, limit);
    }

    return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function safeComponentLabel(value, maxLength, fallback) {
    return truncate(value, maxLength) || fallback;
}

function buildAccountSelectValue(playerTag, sourceMessageId) {
    return `${normalizePlayerTag(playerTag)}|${String(sourceMessageId || '').trim()}`;
}

function parseAccountSelectValue(value) {
    const parts = String(value || '').split('|');

    return {
        playerTag: normalizePlayerTag(parts[0]),
        sourceMessageId: String(parts[1] || '').trim()
    };
}

function chunkArray(items, size) {
    const input = Array.isArray(items) ? items : [];
    const chunkSize = Math.max(1, Number(size) || 1);
    const chunks = [];

    for (let index = 0; index < input.length; index += chunkSize) {
        chunks.push(input.slice(index, index + chunkSize));
    }

    return chunks;
}

function splitLinesForDiscord(lines, maxLength = DISCORD_MESSAGE_SAFE_LENGTH) {
    const chunks = [];
    let current = '';

    for (const rawLine of Array.isArray(lines) ? lines : []) {
        const line = truncate(rawLine, maxLength);
        const next = current ? `${current}\n${line}` : line;

        if (next.length > maxLength && current) {
            chunks.push(current);
            current = line;
            continue;
        }

        current = next;
    }

    if (current) {
        chunks.push(current);
    }

    return chunks.length ? chunks : ['No data available.'];
}

function formatLeagueOptionClanLabel(option) {
    const clanNames = Array.isArray(option?.clanNames) ? option.clanNames : [];
    const clanTags = Array.isArray(option?.clanTags) ? option.clanTags : [];
    const rosterIds = Array.isArray(option?.rosterIds) ? option.rosterIds : [];
    const labels = clanNames.length ? clanNames : (clanTags.length ? clanTags : rosterIds);
    const unique = [];
    const seen = new Set();

    for (const label of labels) {
        const text = String(label || '').trim();
        const key = text.toLowerCase();
        if (!text || seen.has(key)) {
            continue;
        }
        seen.add(key);
        unique.push(text);
    }

    return truncate(unique.join(', '), 120) || 'Clan';
}

function buildSignupMessagePayload(options, pageIndex = 0, pageCount = 1) {
    const available = Array.isArray(options) ? options.slice(0, DISCORD_BUTTONS_PER_MESSAGE) : [];
    const embed = new EmbedBuilder()
        .setTitle('CWL League Preferences')
        .setDescription('Tell us where you would love to play this CWL. Your choice helps us shape the rosters, but final placement still depends on balance, availability, and lineup fit.')
        .setColor(0x2f855a);

    if (pageCount > 1) {
        embed.setFooter({ text: `Part ${pageIndex + 1} of ${pageCount}` });
    }

    if (available.length) {
        const optionLines = available.map(option => `${truncate(option.leagueName, 80)} (${formatLeagueOptionClanLabel(option)})`);
        embed.addFields({
            name: 'Choose your preferred league',
            value: splitLinesForDiscord(optionLines, 1024)[0]
        });
    } else {
        embed.addFields({
            name: 'Choose your preferred league',
            value: 'No CWL roster leagues are available right now.'
        });
    }

    const rows = [];
    for (let index = 0; index < available.length; index += 5) {
        const row = new ActionRowBuilder();
        for (const option of available.slice(index, index + 5)) {
            row.addComponents(
                new ButtonBuilder()
                    .setCustomId(buildCustomId('choose', option.leagueKey))
                    .setLabel(safeComponentLabel(option.leagueName, DISCORD_BUTTON_LABEL_MAX_LENGTH, 'CWL League'))
                    .setStyle(ButtonStyle.Primary)
            );
        }
        rows.push(row);
    }

    return {
        embeds: [embed],
        components: rows
    };
}

async function sendCwlLeagueSignupMessage(interaction) {
    await interaction.deferReply({ flags: 64 });
    const result = await rosterBackend.getCwlLeagueSignupOptions({ fetchMissing: true });
    const optionChunks = chunkArray(result?.options || [], DISCORD_BUTTONS_PER_MESSAGE);
    const chunks = optionChunks.length ? optionChunks : [[]];
    const messages = [];

    for (let index = 0; index < chunks.length; index++) {
        messages.push(await interaction.channel.send(buildSignupMessagePayload(chunks[index], index, chunks.length)));
    }

    const responseLines = chunks.length === 1
        ? [`CWL league signup message sent: ${messages[0].url}`]
        : [
            `${chunks.length} CWL league signup messages sent because Discord allows ${DISCORD_BUTTONS_PER_MESSAGE} buttons per message.`,
            ...messages.map((message, index) => `Part ${index + 1}: ${message.url}`)
        ];

    const responseChunks = splitLinesForDiscord(responseLines);

    await interaction.editReply({
        content: responseChunks[0]
    });

    for (const chunk of responseChunks.slice(1)) {
        await interaction.followUp({
            content: chunk,
            flags: 64
        });
    }
}

function accountLabel(account) {
    const name = String(account?.name || '').trim();
    const tag = normalizePlayerTag(account?.playerTag || account?.tag);
    const th = account?.townHallLevel || account?.townHall;
    const prefix = name || tag;

    return truncate(th ? `${prefix} TH${th}` : prefix, DISCORD_SELECT_LABEL_MAX_LENGTH);
}

async function savePreference(interaction, leagueKey, account, sourceMessageId = '') {
    const discordUser = buildDiscordUser(interaction);
    const playerTag = normalizePlayerTag(account?.playerTag || account?.tag);

    let result;
    try {
        result = await rosterBackend.setCwlLeaguePreference({
            playerTag,
            playerName: account?.name || '',
            leagueKey,
            discordId: discordUser.id,
            discordUsername: discordUser.username,
            discordDisplayName: discordUser.displayName || discordUser.globalName,
            messageId: sourceMessageId || interaction.message?.id || '',
            channelId: interaction.channelId || '',
            guildId: interaction.guildId || ''
        });
    } catch (error) {
        const alreadySet = String(error?.message || '').toLowerCase().includes('already has');
        const content = alreadySet
            ? `${accountLabel(account)} already has a CWL league preference.`
            : 'Unable to save that CWL league preference right now.';

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({
                content,
                components: []
            });
            return;
        }

        await interaction.reply({
            content,
            flags: 64
        });
        return;
    }

    const preference = result?.preference || {};
    const response = {
        content: `${accountLabel(account)} is signed up for ${truncate(preference.leagueName, 80) || 'that CWL league'}.`,
        flags: 64
    };

    if (interaction.deferred || interaction.replied) {
        await interaction.editReply({
            content: response.content,
            components: []
        });
        return;
    }

    await interaction.reply(response);
}

async function handleChooseButton(interaction, parsed) {
    const leagueKey = parsed.parts[0] || '';
    await interaction.deferReply({ flags: 64 });

    const discordUser = buildDiscordUser(interaction);
    const [linkedAccounts, signups] = await Promise.all([
        rosterFirebase.readLinkedAccountsForDiscordUser(discordUser),
        rosterFirebase.readCwlLeagueSignups()
    ]);
    const preferencesByTag = getPreferenceMap(signups);
    const availableAccounts = linkedAccounts.filter(account => {
        const tag = normalizePlayerTag(account?.playerTag || account?.tag);
        return tag && !preferencesByTag[tag];
    });

    if (!availableAccounts.length) {
        await interaction.editReply({
            content: linkedAccounts.length
                ? 'All of your linked accounts already have a CWL league preference.'
                : 'No linked accounts were found for your Discord user.'
        });
        return;
    }

    if (availableAccounts.length === 1) {
        await savePreference(interaction, leagueKey, availableAccounts[0], interaction.message?.id || '');
        return;
    }

    const accountChunks = chunkArray(availableAccounts, DISCORD_SELECT_OPTIONS_MAX).slice(0, DISCORD_ACTION_ROWS_MAX);
    const accountRows = accountChunks.map((accounts, chunkIndex) => {
        const select = new StringSelectMenuBuilder()
            .setCustomId(buildCustomId('account', leagueKey, chunkIndex))
            .setPlaceholder(accountChunks.length > 1 ? `Choose account ${chunkIndex + 1}` : 'Choose account')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                accounts.map(account =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(safeComponentLabel(accountLabel(account), DISCORD_SELECT_LABEL_MAX_LENGTH, 'Linked account'))
                        .setDescription(truncate(normalizePlayerTag(account?.playerTag || account?.tag), DISCORD_SELECT_DESCRIPTION_MAX_LENGTH) || 'Player tag')
                        .setValue(buildAccountSelectValue(account?.playerTag || account?.tag, interaction.message?.id || ''))
                )
            );

        return new ActionRowBuilder().addComponents(select);
    });

    await interaction.editReply({
        content: availableAccounts.length > DISCORD_SELECT_OPTIONS_MAX * DISCORD_ACTION_ROWS_MAX
            ? `Choose which linked account to use. Showing the first ${DISCORD_SELECT_OPTIONS_MAX * DISCORD_ACTION_ROWS_MAX} accounts because Discord limits one response to ${DISCORD_ACTION_ROWS_MAX} select menus.`
            : 'Choose which linked account to use for this CWL league preference.',
        components: accountRows
    });
}

async function handleAccountSelect(interaction, parsed) {
    const leagueKey = parsed.parts[0] || '';
    const selected = parseAccountSelectValue(interaction.values?.[0]);
    const selectedTag = selected.playerTag;
    const discordUser = buildDiscordUser(interaction);
    const linkedAccounts = await rosterFirebase.readLinkedAccountsForDiscordUser(discordUser);
    const account = linkedAccounts.find(item => normalizePlayerTag(item?.playerTag || item?.tag) === selectedTag);

    if (!account) {
        await interaction.reply({
            content: 'That account is no longer linked to your Discord user.',
            flags: 64
        });
        return;
    }

    await interaction.deferUpdate();
    await savePreference(interaction, leagueKey, account, selected.sourceMessageId);
}

async function getCwlLeaguePreferenceCount() {
    const signups = await rosterFirebase.readCwlLeagueSignups();
    return Object.keys(getPreferenceMap(signups)).length;
}

async function showResetCwlLeaguePreferencesConfirmation(interaction) {
    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This command is staff only.',
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });

    let preferenceCount = null;
    try {
        preferenceCount = await getCwlLeaguePreferenceCount();
    } catch {
        preferenceCount = null;
    }

    const preferenceCountText = preferenceCount === null
        ? 'Unknown. The reset will still clear any active preferences found by the backend.'
        : `${preferenceCount} saved preference${preferenceCount === 1 ? '' : 's'}`;

    const warning = new EmbedBuilder()
        .setTitle('DANGER: Reset all CWL league preferences?')
        .setDescription('This will immediately clear every saved CWL league preference for the active signup period. The current list will be archived first, but the live admin panel and signup summary will become empty.')
        .setColor(0xdc2626)
        .addFields(
            {
                name: 'This affects',
                value: preferenceCountText
            },
            {
                name: 'Only continue if',
                value: 'CWL signup choices are final, invalid, or must be collected again from scratch.'
            }
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildCustomId('reset_confirm', interaction.user.id))
            .setLabel('Reset saved preferences')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setCustomId(buildCustomId('reset_cancel', interaction.user.id))
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({
        embeds: [warning],
        components: [row]
    });
}

async function handleResetCancel(interaction, parsed) {
    const userId = parsed.parts[0] || '';

    if (userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This reset confirmation is not for you.',
            flags: 64
        });
        return;
    }

    await interaction.update({
        content: 'CWL league preference reset cancelled.',
        embeds: [],
        components: []
    });
}

async function handleResetConfirm(interaction, parsed) {
    const userId = parsed.parts[0] || '';

    if (userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This reset confirmation is not for you.',
            flags: 64
        });
        return;
    }

    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This command is staff only.',
            flags: 64
        });
        return;
    }

    await interaction.deferUpdate();

    try {
        const result = await rosterBackend.resetCwlLeaguePreferences({
            source: 'discord-manual-reset',
            reason: 'manual-reset'
        });
        const count = Number(result?.count) || 0;
        const archivedText = result?.archived
            ? `Archived and cleared ${count} saved preference${count === 1 ? '' : 's'}.`
            : 'There were no saved CWL league preferences to reset.';

        await interaction.editReply({
            content: archivedText,
            embeds: [],
            components: []
        });
    } catch {
        await interaction.editReply({
            content: 'Reset failed. No confirmation action was completed.',
            embeds: [],
            components: []
        });
    }
}

async function handleCwlLeagueSignupInteraction(interaction) {
    if (!isCwlSignupCustomId(interaction.customId)) {
        return false;
    }

    const parsed = parseCustomId(interaction.customId);

    if (!parsed) {
        return false;
    }

    if (interaction.isButton() && parsed.action === 'choose') {
        await handleChooseButton(interaction, parsed);
        return true;
    }

    if (interaction.isStringSelectMenu() && parsed.action === 'account') {
        await handleAccountSelect(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'reset_confirm') {
        await handleResetConfirm(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'reset_cancel') {
        await handleResetCancel(interaction, parsed);
        return true;
    }

    return false;
}

async function buildCwlLeagueSignupSummaryChunks() {
    const [signups, activeRoster] = await Promise.all([
        rosterFirebase.readCwlLeagueSignups(),
        rosterFirebase.readActiveRosterPayload()
    ]);
    const preferences = Object.values(getPreferenceMap(signups));
    const metricsByTag = activeRoster?.playerMetrics?.byTag || {};

    preferences.sort((a, b) => {
        const leagueCompare = String(a.leagueName || '').localeCompare(String(b.leagueName || ''));
        if (leagueCompare) return leagueCompare;
        return String(a.playerName || a.playerTag || '').localeCompare(String(b.playerName || b.playerTag || ''));
    });

    if (!preferences.length) {
        return ['No CWL league preferences have been submitted yet.'];
    }

    const lines = preferences.map(pref => {
        const tag = normalizePlayerTag(pref.playerTag);
        const metric = metricsByTag[tag] || {};
        const latest = metric.latestSnapshot || {};
        const name = truncate(pref.playerName || metric.identity?.name || latest.name || tag, 80);
        const leagueName = truncate(pref.leagueName, 80);
        const user = truncate(pref.discordId ? `<@${pref.discordId}>` : (pref.discordDisplayName || pref.discordUsername || 'unknown Discord'), 120);

        return `${leagueName}: ${name} (${tag}) - ${user}`;
    });

    return splitLinesForDiscord(lines);
}

async function buildCwlLeagueSignupSummary() {
    return (await buildCwlLeagueSignupSummaryChunks()).join('\n\n');
}

async function showCwlLeagueSignupSummary(interaction) {
    await interaction.deferReply({ flags: 64 });
    const chunks = await buildCwlLeagueSignupSummaryChunks();

    await interaction.editReply({
        content: chunks[0]
    });

    for (const chunk of chunks.slice(1)) {
        await interaction.followUp({
            content: chunk,
            flags: 64
        });
    }
}

module.exports = {
    sendCwlLeagueSignupMessage,
    showResetCwlLeaguePreferencesConfirmation,
    handleCwlLeagueSignupInteraction,
    showCwlLeagueSignupSummary,
    buildCwlLeagueSignupSummary,
    buildCwlLeagueSignupSummaryChunks
};
