const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ChannelType,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const { createHash } = require('node:crypto');
const rosterBackend = require('../rosterBackend/rosterBackendClient');
const rosterPublicData = require('../rosterPublicData/rosterPublicDataReadClient');
const { isSeasonEventAdmin } = require('../seasonEvents/permissions');

const CUSTOM_ID_PREFIX = 'cwl:v1';
const DISCORD_CUSTOM_ID_MAX_LENGTH = 100;
const DISCORD_BUTTON_LABEL_MAX_LENGTH = 80;
const DISCORD_SELECT_LABEL_MAX_LENGTH = 100;
const DISCORD_SELECT_DESCRIPTION_MAX_LENGTH = 100;
const DISCORD_MESSAGE_SAFE_LENGTH = 1900;
const DISCORD_LEAGUE_BUTTONS_PER_MESSAGE = 20;
const DISCORD_BUTTONS_PER_ROW = 5;
const DISCORD_SELECT_OPTIONS_MAX = 25;
const DISCORD_ACTION_ROWS_MAX = 5;
const DISCORD_UTILITY_ACTION_ROWS = 1;

const CWL_LEAGUE_EMOJIS_BY_KEY = {
    'bronze-iii': { id: '1516059392552861848', name: 'WarBronzeIII', animated: false },
    'bronze-ii': { id: '1516059367349162006', name: 'WarBronzeII', animated: false },
    'bronze-i': { id: '1516059331735589019', name: 'WarBronzeI', animated: false },
    'silver-iii': { id: '1516059277557502074', name: 'WarSilverIII', animated: false },
    'silver-ii': { id: '1516059227561656410', name: 'WarSilverII', animated: false },
    'silver-i': { id: '1516059206531158117', name: 'WarSilverI', animated: false },
    'gold-iii': { id: '1516059179024912438', name: 'WarGoldIII', animated: false },
    'gold-ii': { id: '1516059152286355496', name: 'WarGoldII', animated: false },
    'gold-i': { id: '1516059127544287242', name: 'WarGoldI', animated: false },
    'crystal-iii': { id: '1516059098440011816', name: 'WarCrystalIII', animated: false },
    'crystal-ii': { id: '1516058705752363008', name: 'WarCrystalII', animated: false },
    'crystal-i': { id: '1516058678396977202', name: 'WarCrystalI', animated: false },
    'master-iii': { id: '1516058647937941585', name: 'WarMasterIII', animated: false },
    'master-ii': { id: '1516058624357695558', name: 'WarMasterII', animated: false },
    'master-i': { id: '1516058601616052396', name: 'WarMasterI', animated: false },
    'champion-iii': { id: '1516058550353395722', name: 'WarChampionIII', animated: false },
    'champion-ii': { id: '1516058524273344522', name: 'WarChampionII', animated: false },
    'champion-i': { id: '1516058496632754287', name: 'WarChampionI', animated: false },
    'titan-iii': { id: '1516058468635902122', name: 'WarTitanIII', animated: false },
    'titan-ii': { id: '1516058442660315177', name: 'WarTitanII', animated: false },
    'titan-i': { id: '1516058416546582731', name: 'WarTitanI', animated: false },
    legend: { id: '1516058390626046143', name: 'WarLegendL', animated: false }
};

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

function normalizeCwlLeagueEmojiKey(leagueName) {
    const text = String(leagueName || '')
        .toLowerCase()
        .replace(/\b(clan|war|league)\b/g, ' ')
        .replace(/[^a-z0-9ivx]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    if (!text) {
        return '';
    }

    if (/\blegend\b/.test(text)) {
        return 'legend';
    }

    const family = ['bronze', 'silver', 'gold', 'crystal', 'master', 'champion', 'titan']
        .find(value => new RegExp(`\\b${value}\\b`).test(text));
    if (!family) {
        return '';
    }

    const tierMatch = text.match(/\b(iii|ii|i|3|2|1)\b/);
    if (!tierMatch) {
        return '';
    }

    const rawTier = tierMatch[1];
    const tier = rawTier === '3' ? 'iii' : (rawTier === '2' ? 'ii' : (rawTier === '1' ? 'i' : rawTier));
    return `${family}-${tier}`;
}

function resolveCwlLeagueEmoji(leagueName) {
    const emoji = CWL_LEAGUE_EMOJIS_BY_KEY[normalizeCwlLeagueEmojiKey(leagueName)];
    return emoji ? { ...emoji } : null;
}

function formatCwlLeagueEmojiMention(leagueName) {
    const emoji = resolveCwlLeagueEmoji(leagueName);
    return emoji ? `<:${emoji.name}:${emoji.id}>` : '';
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

function normalizeSignupOption(option, fallbackKey = '') {
    const source = option && typeof option === 'object' ? option : {};
    const rosterIds = Array.isArray(source.rosterIds)
        ? source.rosterIds.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const clanTags = Array.isArray(source.clanTags)
        ? source.clanTags.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const clanNames = Array.isArray(source.clanNames)
        ? source.clanNames.map(value => String(value || '').trim()).filter(Boolean)
        : [];
    const leagueName = String(source.leagueName || source.leagueLabel || source.leagueKey || fallbackKey || '').trim();
    const leagueKey = String(source.leagueKey || leagueName || fallbackKey || '').trim();
    const optionKey = String(source.optionKey || source.optionId || source.choiceKey || fallbackKey || leagueKey || '').trim();
    const targetRosterId = String(source.targetRosterId || source.rosterId || rosterIds[0] || '').trim();
    const targetClanTag = String(source.targetClanTag || source.clanTag || clanTags[0] || '').trim();
    const targetClanName = String(source.targetClanName || source.clanName || clanNames[0] || '').trim();
    const targetRosterTitle = String(source.targetRosterTitle || source.rosterTitle || '').trim();

    return {
        ...source,
        optionKey,
        leagueKey,
        leagueName,
        targetRosterId,
        targetRosterTitle,
        targetClanTag,
        targetClanName,
        rosterIds,
        clanTags,
        clanNames
    };
}

function formatLeagueOptionClanLabel(option) {
    const normalized = normalizeSignupOption(option);
    if (normalized.targetClanName) {
        return truncate(normalized.targetClanName, 120);
    }

    if (normalized.targetClanTag) {
        return truncate(normalized.targetClanTag, 120);
    }

    if (normalized.targetRosterTitle) {
        return truncate(normalized.targetRosterTitle, 120);
    }

    if (normalized.targetRosterId) {
        return truncate(normalized.targetRosterId, 120);
    }

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

function formatLeagueOptionLine(option) {
    const normalized = normalizeSignupOption(option);
    const emojiMention = formatCwlLeagueEmojiMention(normalized.leagueName);
    const leagueName = truncate(normalized.leagueName, 80) || 'Unknown league';
    const clanLabel = formatLeagueOptionClanLabel(normalized);
    return [emojiMention, `${leagueName} - ${clanLabel}`].filter(Boolean).join(' ');
}

function formatSkippedRosterReason(reason) {
    switch (String(reason || '')) {
        case 'missingLeague':
            return 'league could not be fetched from Clash';
        case 'missingConnectedClanTag':
            return 'connected clan tag is missing or invalid';
        case 'missingRosterId':
            return 'roster id is missing';
        default:
            return 'could not build a signup option';
    }
}

function buildSkippedRosterLines(skippedRosters) {
    return (Array.isArray(skippedRosters) ? skippedRosters : []).map(roster => {
        const label = roster?.rosterTitle || roster?.rosterId || roster?.clanTag || 'Unnamed roster';
        const clanTag = roster?.clanTag ? ` (${roster.clanTag})` : '';
        return `- ${truncate(label, 80)}${clanTag}: ${formatSkippedRosterReason(roster?.reason)}`;
    });
}

function staleSignupMessage() {
    return 'This CWL signup message is no longer active. Please use the latest signup message.';
}

function isStaleSignupError(error) {
    const message = String(error?.message || '').toLowerCase();
    const code = String(error?.code || '').toLowerCase();

    return code.includes('stale') ||
        code.includes('not_active') ||
        message.includes('no longer active') ||
        message.includes('not active') ||
        message.includes('stale signup');
}

function buildUtilityButtonRow(signupId) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(buildCustomId('my_votes', signupId))
            .setLabel('My votes')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(buildCustomId('clear_vote', signupId))
            .setLabel('Clear vote')
            .setStyle(ButtonStyle.Danger)
    );
}

function normalizeCwlLeaguePreferenceList(result, discordId = '') {
    const source = Array.isArray(result)
        ? result
        : Array.isArray(result?.preferences)
            ? result.preferences
            : Array.isArray(result?.items)
                ? result.items
                : result?.preferencesByTag && typeof result.preferencesByTag === 'object'
                    ? Object.values(result.preferencesByTag)
                    : result?.preference
                        ? [result.preference]
                        : [];
    const expectedDiscordId = String(discordId || '').trim();
    const seen = new Set();

    return source
        .filter(preference => preference && typeof preference === 'object')
        .filter(preference => {
            const preferenceDiscordId = String(
                preference.discordId ||
                preference.discordUserId ||
                preference.userId ||
                ''
            ).trim();

            return !expectedDiscordId || !preferenceDiscordId || preferenceDiscordId === expectedDiscordId;
        })
        .map(preference => ({
            ...preference,
            playerTag: normalizePlayerTag(preference.playerTag || preference.tag),
            playerName: String(preference.playerName || preference.name || '').trim(),
            optionKey: String(preference.optionKey || preference.optionId || preference.choiceKey || '').trim(),
            leagueKey: String(preference.leagueKey || '').trim(),
            leagueName: String(preference.leagueName || preference.leagueLabel || preference.leagueKey || '').trim(),
            targetRosterId: String(preference.targetRosterId || preference.rosterId || '').trim(),
            targetClanTag: String(preference.targetClanTag || preference.clanTag || '').trim(),
            targetClanName: String(preference.targetClanName || preference.clanName || '').trim()
        }))
        .filter(preference => {
            const key = preference.playerTag || `${preference.playerName}|${preference.leagueName}`;
            if (!key || seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
}

function preferenceAccountLabel(preference) {
    const playerTag = normalizePlayerTag(preference?.playerTag || preference?.tag);
    const playerName = String(preference?.playerName || preference?.name || '').trim();
    const townHall = preference?.townHallLevel || preference?.townHall;
    const label = playerName || playerTag || 'Unknown account';
    const suffix = [
        townHall ? `TH${townHall}` : '',
        playerName && playerTag ? playerTag : ''
    ].filter(Boolean).join(' ');

    return truncate(suffix ? `${label} (${suffix})` : label, 120);
}

function preferenceLeagueLabel(preference) {
    const league = truncate(
        preference?.leagueName ||
        preference?.leagueLabel ||
        preference?.leagueKey ||
        'Unknown league',
        80
    );
    const target = truncate(
        preference?.targetClanName ||
        preference?.clanName ||
        preference?.targetClanTag ||
        preference?.clanTag ||
        '',
        80
    );

    return target ? `${league} - ${target}` : league;
}

function formatPreferenceLine(preference) {
    return `- ${preferenceAccountLabel(preference)}: ${preferenceLeagueLabel(preference)}`;
}

function getPreferenceDiscordId(preference) {
    return String(
        preference?.discordId ||
        preference?.discordUserId ||
        preference?.userId ||
        ''
    ).trim();
}

function userOwnsPreference(preference, discordId) {
    const ownerId = getPreferenceDiscordId(preference);

    return Boolean(ownerId && ownerId === String(discordId || '').trim());
}

function getPreferenceByTag(signups, playerTag) {
    const tag = normalizePlayerTag(playerTag);
    const preferencesByTag = getPreferenceMap(signups);
    const preference = preferencesByTag[tag];

    return preference && typeof preference === 'object' ? {
        ...preference,
        playerTag: normalizePlayerTag(preference.playerTag || preference.tag || tag),
        optionKey: String(preference.optionKey || preference.optionId || preference.choiceKey || '').trim(),
        leagueKey: String(preference.leagueKey || '').trim(),
        leagueName: String(preference.leagueName || preference.leagueLabel || preference.leagueKey || '').trim(),
        targetRosterId: String(preference.targetRosterId || preference.rosterId || '').trim(),
        targetClanTag: String(preference.targetClanTag || preference.clanTag || '').trim(),
        targetClanName: String(preference.targetClanName || preference.clanName || '').trim()
    } : null;
}

function getSignupOption(signups, optionKey) {
    const key = String(optionKey || '').trim();
    const optionsByKey = signups?.optionsByKey && typeof signups.optionsByKey === 'object'
        ? signups.optionsByKey
        : {};
    const optionsByLeagueKey = signups?.optionsByLeagueKey && typeof signups.optionsByLeagueKey === 'object'
        ? signups.optionsByLeagueKey
        : {};
    const option = optionsByKey[key] || optionsByLeagueKey[key];

    return option && typeof option === 'object'
        ? normalizeSignupOption(option, key)
        : null;
}

function preferenceChangeToken(preference) {
    return createHash('sha256')
        .update(String(
            preference?.optionKey ||
            preference?.targetRosterId ||
            preference?.targetClanTag ||
            preference?.leagueKey ||
            preference?.leagueName ||
            ''
        ))
        .digest('hex')
        .slice(0, 8);
}

function formatUserPreferencesResponse(preferences) {
    const lines = normalizeCwlLeaguePreferenceList(preferences);

    if (!lines.length) {
        return 'You do not have any saved CWL league preferences yet.';
    }

    return [
        'Your saved CWL league preferences:',
        ...lines.map(formatPreferenceLine)
    ].join('\n');
}

function buildUserPreferencePayload(interaction, signupId, extra = {}) {
    const discordUser = buildDiscordUser(interaction);

    return {
        signupId,
        discordId: discordUser.id,
        discordUsername: discordUser.username,
        discordDisplayName: discordUser.displayName || discordUser.globalName,
        ...extra
    };
}

async function getUserCwlLeaguePreferences(interaction, signupId) {
    const payload = buildUserPreferencePayload(interaction, signupId);
    const result = await rosterBackend.getCwlLeaguePreferencesForDiscordUser(payload);

    return normalizeCwlLeaguePreferenceList(result, payload.discordId);
}

async function clearUserCwlLeaguePreference(interaction, signupId, preference) {
    const playerTag = normalizePlayerTag(preference?.playerTag || preference?.tag);

    return rosterBackend.clearCwlLeaguePreference(buildUserPreferencePayload(interaction, signupId, {
        playerTag,
        source: 'discord-user-clear',
        messageId: interaction.message?.id || '',
        channelId: interaction.channelId || '',
        guildId: interaction.guildId || ''
    }));
}

function classifyClearPreferenceResult(result) {
    const status = String(result?.status || result?.reason || result?.code || '')
        .trim()
        .toLowerCase()
        .replace(/_/g, '-');

    if (result?.cleared === true || status === 'cleared') {
        return 'cleared';
    }

    if ([
        'not-found',
        'already-cleared',
        'already-clear',
        'missing',
        'no-vote',
        'noop'
    ].includes(status)) {
        return 'not-found';
    }

    if ([
        'not-owner',
        'owner-mismatch',
        'forbidden',
        'unauthorized',
        'not-authorized',
        'permission-denied'
    ].includes(status)) {
        return 'not-owner';
    }

    return 'unknown';
}

function buildClearPreferenceResultMessage(preference, result) {
    const account = preferenceAccountLabel(preference);

    switch (classifyClearPreferenceResult(result)) {
        case 'cleared':
            return {
                ok: true,
                content: `${account} no longer has a saved CWL league preference.`
            };
        case 'not-found':
            return {
                ok: true,
                content: `${account} did not have a saved CWL league preference to clear.`
            };
        case 'not-owner':
            return {
                ok: false,
                content: 'That CWL league preference belongs to another Discord user, so I did not clear it.'
            };
        default:
            return {
                ok: false,
                content: 'Unable to clear that CWL league preference because the backend did not confirm the clear.'
            };
    }
}

function buildClearPreferenceSelectRows(preferences, signupId, userId) {
    const clearablePreferences = normalizeCwlLeaguePreferenceList(preferences)
        .filter(preference => normalizePlayerTag(preference.playerTag || preference.tag));
    const selectRowLimit = DISCORD_ACTION_ROWS_MAX;
    const preferenceChunks = chunkArray(clearablePreferences, DISCORD_SELECT_OPTIONS_MAX).slice(0, selectRowLimit);

    return preferenceChunks.map((chunk, chunkIndex) => {
        const select = new StringSelectMenuBuilder()
            .setCustomId(buildCustomId('clear_vote_select', signupId, userId, chunkIndex))
            .setPlaceholder(preferenceChunks.length > 1 ? `Clear vote ${chunkIndex + 1}` : 'Choose vote to clear')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                chunk.map(preference =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(safeComponentLabel(
                            `${preferenceAccountLabel(preference)} - ${preferenceLeagueLabel(preference)}`,
                            DISCORD_SELECT_LABEL_MAX_LENGTH,
                            'CWL vote'
                        ))
                        .setDescription(
                            truncate(
                                normalizePlayerTag(preference.playerTag || preference.tag),
                                DISCORD_SELECT_DESCRIPTION_MAX_LENGTH
                            ) || 'Player tag'
                        )
                        .setValue(normalizePlayerTag(preference.playerTag || preference.tag))
                )
            );

        return new ActionRowBuilder().addComponents(select);
    });
}

function buildChangePreferenceConfirmationRows(signupId, optionKey, preference) {
    const playerTag = normalizePlayerTag(preference?.playerTag || preference?.tag);

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buildCustomId('chg', signupId, optionKey, playerTag, preferenceChangeToken(preference)))
                .setLabel('Confirm change')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(buildCustomId('chg_cancel'))
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

function buildSignupMessagePayload(options, signupId, pageIndex = 0, pageCount = 1) {
    const available = Array.isArray(options) ? options.slice(0, DISCORD_LEAGUE_BUTTONS_PER_MESSAGE) : [];
    const embed = new EmbedBuilder()
        .setTitle('CWL League Preferences')
        .setDescription('Tell us where you would love to play this CWL. Your choice helps us shape the rosters, but final placement still depends on balance, availability, and lineup fit.')
        .setColor(0x2f855a);

    if (pageCount > 1) {
        embed.setFooter({ text: `Part ${pageIndex + 1} of ${pageCount}` });
    }

    if (available.length) {
        const optionLines = available.map(option => formatLeagueOptionLine(option));
        const optionChunks = splitLinesForDiscord(optionLines, 1024);

        optionChunks.forEach((chunk, index) => {
            embed.addFields({
                name: index === 0 ? 'Choose your preferred league' : 'More choices',
                value: chunk
            });
        });
    } else {
        embed.addFields({
            name: 'Choose your preferred league',
            value: 'No CWL roster leagues are available right now.'
        });
    }

    const rows = [];
    const leagueRowLimit = DISCORD_ACTION_ROWS_MAX - DISCORD_UTILITY_ACTION_ROWS;
    const leagueRowOptions = available.slice(0, leagueRowLimit * DISCORD_BUTTONS_PER_ROW);

    for (let index = 0; index < leagueRowOptions.length; index += DISCORD_BUTTONS_PER_ROW) {
        const row = new ActionRowBuilder();
        for (const rawOption of leagueRowOptions.slice(index, index + DISCORD_BUTTONS_PER_ROW)) {
            const option = normalizeSignupOption(rawOption);
            const button = new ButtonBuilder()
                .setCustomId(buildCustomId('choose', signupId, option.optionKey || option.leagueKey))
                .setLabel(safeComponentLabel(formatLeagueOptionClanLabel(option), DISCORD_BUTTON_LABEL_MAX_LENGTH, 'Clan'))
                .setStyle(ButtonStyle.Primary);
            const emoji = resolveCwlLeagueEmoji(option.leagueName);
            if (emoji) {
                button.setEmoji(emoji);
            }
            row.addComponents(button);
        }
        rows.push(row);
    }
    rows.push(buildUtilityButtonRow(signupId));

    return {
        embeds: [embed],
        components: rows
    };
}

async function sendCwlLeagueSignupMessage(interaction) {
    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This command is staff only.',
            flags: 64
        });
        return;
    }

    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || typeof channel.send !== 'function') {
        await interaction.reply({
            content: 'Use this command in the text channel where the CWL signup message should be posted.',
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });
    const result = await rosterBackend.getCwlLeagueSignupOptions({ fetchMissing: true });
    const signupId = String(result?.signupId || '').trim();
    if (!signupId) {
        throw new Error('Roster backend did not return a CWL signup id.');
    }
    const options = Array.isArray(result?.options) ? result.options : [];
    const skippedRosterLines = buildSkippedRosterLines(result?.diagnostics?.skippedRosters);

    if (!options.length) {
        await interaction.editReply({
            content: 'I did not send a CWL signup message because no roster league options were available. Check the connected clan tags and Clash API access, then try again.'
        });
        return;
    }

    if (skippedRosterLines.length) {
        const chunks = splitLinesForDiscord([
            'I did not send a CWL signup message because the league list would be incomplete.',
            ...skippedRosterLines
        ]);

        await interaction.editReply({
            content: chunks[0]
        });

        for (const chunk of chunks.slice(1)) {
            await interaction.followUp({
                content: chunk,
                flags: 64
            });
        }
        return;
    }

    const optionChunks = chunkArray(options, DISCORD_LEAGUE_BUTTONS_PER_MESSAGE);
    const chunks = optionChunks.length ? optionChunks : [[]];
    const messages = [];

    for (let index = 0; index < chunks.length; index++) {
        messages.push(await channel.send(buildSignupMessagePayload(chunks[index], signupId, index, chunks.length)));
    }

    const responseLines = chunks.length === 1
        ? [`CWL league signup message sent: ${messages[0].url}`]
        : [
            `${chunks.length} CWL league signup messages sent because each message shows up to ${DISCORD_LEAGUE_BUTTONS_PER_MESSAGE} league choices while reserving utility buttons.`,
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

function buildChangePreferenceMessage(account, previousPreference, nextPreference) {
    const oldLeague = preferenceLeagueLabel(previousPreference);
    const newLeague = preferenceLeagueLabel(nextPreference);

    return `${accountLabel(account)} changed CWL league preference: ${oldLeague} -> ${newLeague}.`;
}

async function savePreference(interaction, signupId, leagueKey, account, sourceMessageId = '', options = {}) {
    const discordUser = buildDiscordUser(interaction);
    const playerTag = normalizePlayerTag(account?.playerTag || account?.tag);

    let result;
    try {
        result = await rosterBackend.setCwlLeaguePreference({
            playerTag,
            playerName: account?.name || '',
            signupId,
            optionKey: options.optionKey || leagueKey,
            leagueKey,
            discordId: discordUser.id,
            discordUsername: discordUser.username,
            discordDisplayName: discordUser.displayName || discordUser.globalName,
            messageId: sourceMessageId || interaction.message?.id || '',
            channelId: interaction.channelId || '',
            guildId: interaction.guildId || '',
            allowChange: options.allowChange === true
        });
    } catch (error) {
        const errorMessage = String(error?.message || '').toLowerCase();
        const errorCode = String(error?.code || '').toLowerCase();
        const alreadySet = errorMessage.includes('already has');
        const staleSignup = isStaleSignupError(error);
        const notOwner = errorCode.includes('not_owner') ||
            errorCode.includes('not-owner') ||
            errorMessage.includes('belongs to another') ||
            errorMessage.includes('not owner');
        let content = 'Unable to save that CWL league preference right now.';

        if (staleSignup) {
            content = staleSignupMessage();
        } else if (notOwner) {
            content = 'That CWL league preference belongs to another Discord user, so I did not change it.';
        } else if (alreadySet) {
            content = `${accountLabel(account)} already has a CWL league preference.`;
        }

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
    let content = `${accountLabel(account)} is signed up for ${preferenceLeagueLabel(preference) || 'that CWL league'}.`;

    if (options.allowChange === true) {
        const status = String(result?.status || '').toLowerCase();
        if (status === 'changed' || result?.changed === true) {
            content = buildChangePreferenceMessage(account, result?.previousPreference || options.previousPreference, preference);
        } else if (status === 'unchanged') {
            content = `${accountLabel(account)} is already signed up for ${preferenceLeagueLabel(preference) || 'that CWL league'}.`;
        } else if (!result || result.ok === false || (!result.preference && !preference.leagueName)) {
            content = 'Unable to change that CWL league preference because the backend did not confirm the change.';
        }
    }

    const response = {
        content,
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

function buildChangePreferenceConfirmationContent(account, currentPreference, nextOption) {
    return [
        `Confirm CWL league preference change for ${accountLabel(account)}:`,
        `${preferenceLeagueLabel(currentPreference)} -> ${preferenceLeagueLabel(nextOption) || 'that CWL league'}`
    ].join('\n');
}

function preferenceMatchesOption(preference, option) {
    const current = preference && typeof preference === 'object' ? preference : {};
    const next = normalizeSignupOption(option);
    const currentOptionKey = String(current.optionKey || current.optionId || current.choiceKey || '').trim();
    const nextOptionKey = String(next.optionKey || '').trim();
    if (currentOptionKey || nextOptionKey) {
        return Boolean(currentOptionKey && nextOptionKey && currentOptionKey === nextOptionKey);
    }

    const currentRosterId = String(current.targetRosterId || current.rosterId || '').trim();
    const nextRosterId = String(next.targetRosterId || '').trim();
    if (currentRosterId || nextRosterId) {
        return Boolean(currentRosterId && nextRosterId && currentRosterId === nextRosterId);
    }

    return String(current.leagueKey || '').trim() === String(next.leagueKey || '').trim();
}

async function showChangePreferenceConfirmation(interaction, signupId, optionKey, account, currentPreference, signups) {
    const nextOption = getSignupOption(signups, optionKey);

    if (!nextOption) {
        await interaction.editReply({
            content: 'That CWL league choice is no longer available. Please use the latest signup message.',
            components: []
        });
        return;
    }

    if (preferenceMatchesOption(currentPreference, nextOption)) {
        await interaction.editReply({
            content: `${accountLabel(account)} is already signed up for ${preferenceLeagueLabel(nextOption) || 'that CWL league'}.`,
            components: []
        });
        return;
    }

    await interaction.editReply({
        content: buildChangePreferenceConfirmationContent(account, currentPreference, nextOption),
        components: buildChangePreferenceConfirmationRows(signupId, optionKey, currentPreference)
    });
}

function buildSelectableCwlAccounts(linkedAccounts, signups, discordId) {
    return linkedAccounts
        .map(account => ({
            account,
            playerTag: normalizePlayerTag(account?.playerTag || account?.tag),
            preference: getPreferenceByTag(signups, account?.playerTag || account?.tag)
        }))
        .filter(item => item.playerTag)
        .filter(item => !item.preference || userOwnsPreference(item.preference, discordId));
}

async function handleChooseButton(interaction, parsed) {
    const signupId = parsed.parts[0] || '';
    const optionKey = parsed.parts[1] || '';

    if (!signupId || !optionKey) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });

    const discordUser = buildDiscordUser(interaction);
    const [linkedAccounts, signups] = await Promise.all([
        rosterPublicData.readLinkedAccountsForDiscordUser(discordUser),
        rosterPublicData.readCwlLeagueSignups()
    ]);
    const selectableAccounts = buildSelectableCwlAccounts(linkedAccounts, signups, discordUser.id);

    if (!selectableAccounts.length) {
        await interaction.editReply({
            content: linkedAccounts.length
                ? 'No linked accounts are available for that CWL league preference. If a vote looks tied to the wrong Discord user, ask staff to check the account link.'
                : 'No linked accounts were found for your Discord user.'
        });
        return;
    }

    const selectedOption = getSignupOption(signups, optionKey);
    if (!selectedOption) {
        await interaction.editReply({
            content: 'That CWL league choice is no longer available. Please use the latest signup message.',
            components: []
        });
        return;
    }

    if (selectableAccounts.length === 1) {
        const selected = selectableAccounts[0];

        if (selected.preference) {
            await showChangePreferenceConfirmation(interaction, signupId, optionKey, selected.account, selected.preference, signups);
            return;
        }

        await savePreference(interaction, signupId, selectedOption.leagueKey, selected.account, interaction.message?.id || '', {
            optionKey: selectedOption.optionKey
        });
        return;
    }

    const accountChunks = chunkArray(selectableAccounts, DISCORD_SELECT_OPTIONS_MAX).slice(0, DISCORD_ACTION_ROWS_MAX);
    const accountRows = accountChunks.map((items, chunkIndex) => {
        const select = new StringSelectMenuBuilder()
            .setCustomId(buildCustomId('account', signupId, optionKey, chunkIndex))
            .setPlaceholder(accountChunks.length > 1 ? `Choose account ${chunkIndex + 1}` : 'Choose account')
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(
                items.map(item =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(safeComponentLabel(accountLabel(item.account), DISCORD_SELECT_LABEL_MAX_LENGTH, 'Linked account'))
                        .setDescription(truncate(
                            item.preference
                                ? `Current: ${preferenceLeagueLabel(item.preference)}`
                                : normalizePlayerTag(item.account?.playerTag || item.account?.tag),
                            DISCORD_SELECT_DESCRIPTION_MAX_LENGTH
                        ) || 'Player tag')
                        .setValue(buildAccountSelectValue(item.account?.playerTag || item.account?.tag, interaction.message?.id || ''))
                )
            );

        return new ActionRowBuilder().addComponents(select);
    });

    await interaction.editReply({
        content: selectableAccounts.length > DISCORD_SELECT_OPTIONS_MAX * DISCORD_ACTION_ROWS_MAX
            ? `Choose which linked account to use. Showing the first ${DISCORD_SELECT_OPTIONS_MAX * DISCORD_ACTION_ROWS_MAX} accounts because Discord limits one response to ${DISCORD_ACTION_ROWS_MAX} select menus.`
            : 'Choose which linked account to use for this CWL league preference.',
        components: accountRows
    });
}

async function handleAccountSelect(interaction, parsed) {
    const signupId = parsed.parts[0] || '';
    const optionKey = parsed.parts[1] || '';

    if (!signupId || !optionKey) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    const selected = parseAccountSelectValue(interaction.values?.[0]);
    const selectedTag = selected.playerTag;
    const discordUser = buildDiscordUser(interaction);
    let linkedAccounts;
    let signups;
    try {
        [linkedAccounts, signups] = await Promise.all([
            rosterPublicData.readLinkedAccountsForDiscordUser(discordUser),
            rosterPublicData.readCwlLeagueSignups()
        ]);
    } catch {
        await interaction.reply({
            content: 'Unable to load your CWL league preferences right now.',
            flags: 64
        });
        return;
    }
    const account = linkedAccounts.find(item => normalizePlayerTag(item?.playerTag || item?.tag) === selectedTag);

    if (!account) {
        await interaction.reply({
            content: 'That account is no longer linked to your Discord user.',
            flags: 64
        });
        return;
    }

    await interaction.deferUpdate();

    const selectedOption = getSignupOption(signups, optionKey);
    if (!selectedOption) {
        await interaction.editReply({
            content: 'That CWL league choice is no longer available. Please use the latest signup message.',
            components: []
        });
        return;
    }

    const currentPreference = getPreferenceByTag(signups, selectedTag);
    if (currentPreference) {
        if (!userOwnsPreference(currentPreference, discordUser.id)) {
            await interaction.editReply({
                content: 'That CWL league preference belongs to another Discord user, so I did not change it.',
                components: []
            });
            return;
        }

        await showChangePreferenceConfirmation(interaction, signupId, optionKey, account, currentPreference, signups);
        return;
    }

    await savePreference(interaction, signupId, selectedOption.leagueKey, account, selected.sourceMessageId, {
        optionKey: selectedOption.optionKey
    });
}

async function handleMyVotesButton(interaction, parsed) {
    const signupId = parsed.parts[0] || '';

    if (!signupId) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });

    try {
        const preferences = await getUserCwlLeaguePreferences(interaction, signupId);

        await interaction.editReply({
            content: formatUserPreferencesResponse(preferences),
            components: []
        });
    } catch (error) {
        await interaction.editReply({
            content: isStaleSignupError(error)
                ? staleSignupMessage()
                : 'Unable to load your CWL league preferences right now.',
            components: []
        });
    }
}

async function handleClearVoteButton(interaction, parsed) {
    const signupId = parsed.parts[0] || '';

    if (!signupId) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ flags: 64 });

    let preferences;
    try {
        preferences = await getUserCwlLeaguePreferences(interaction, signupId);
    } catch (error) {
        await interaction.editReply({
            content: isStaleSignupError(error)
                ? staleSignupMessage()
                : 'Unable to load your CWL league preferences right now.',
            components: []
        });
        return;
    }

    const clearablePreferences = preferences.filter(preference => normalizePlayerTag(preference.playerTag || preference.tag));

    if (!clearablePreferences.length) {
        await interaction.editReply({
            content: 'You do not have any saved CWL league preferences to clear.',
            components: []
        });
        return;
    }

    if (clearablePreferences.length === 1) {
        const preference = clearablePreferences[0];

        try {
            const result = await clearUserCwlLeaguePreference(interaction, signupId, preference);
            const message = buildClearPreferenceResultMessage(preference, result);
            await interaction.editReply({
                content: message.content,
                components: []
            });
        } catch (error) {
            await interaction.editReply({
                content: isStaleSignupError(error)
                    ? staleSignupMessage()
                    : 'Unable to clear that CWL league preference right now.',
                components: []
            });
        }
        return;
    }

    const rows = buildClearPreferenceSelectRows(clearablePreferences, signupId, interaction.user.id);
    const maxShown = DISCORD_SELECT_OPTIONS_MAX * DISCORD_ACTION_ROWS_MAX;

    await interaction.editReply({
        content: clearablePreferences.length > maxShown
            ? `Choose which CWL league preference to clear. Showing the first ${maxShown} saved preferences because Discord limits one response to ${DISCORD_ACTION_ROWS_MAX} select menus.`
            : 'Choose which CWL league preference to clear.',
        components: rows
    });
}

async function handleClearVoteSelect(interaction, parsed) {
    const signupId = parsed.parts[0] || '';
    const userId = parsed.parts[1] || '';

    if (!signupId) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    if (userId && userId !== interaction.user.id) {
        await interaction.reply({
            content: 'This CWL clear vote menu is not for you.',
            flags: 64
        });
        return;
    }

    const selectedTag = normalizePlayerTag(interaction.values?.[0]);

    if (!selectedTag) {
        await interaction.reply({
            content: 'That CWL league preference selection is no longer valid.',
            flags: 64
        });
        return;
    }

    await interaction.deferUpdate();

    let preferences;
    try {
        preferences = await getUserCwlLeaguePreferences(interaction, signupId);
    } catch (error) {
        await interaction.editReply({
            content: isStaleSignupError(error)
                ? staleSignupMessage()
                : 'Unable to load your CWL league preferences right now.',
            components: []
        });
        return;
    }

    const preference = preferences.find(item => normalizePlayerTag(item.playerTag || item.tag) === selectedTag);

    if (!preference) {
        await interaction.editReply({
            content: 'That CWL league preference is no longer saved.',
            components: []
        });
        return;
    }

    try {
        const result = await clearUserCwlLeaguePreference(interaction, signupId, preference);
        const message = buildClearPreferenceResultMessage(preference, result);
        await interaction.editReply({
            content: message.content,
            components: []
        });
    } catch (error) {
        await interaction.editReply({
            content: isStaleSignupError(error)
                ? staleSignupMessage()
                : 'Unable to clear that CWL league preference right now.',
            components: []
        });
    }
}

async function handleChangePreferenceConfirm(interaction, parsed) {
    const signupId = parsed.parts[0] || '';
    const optionKey = parsed.parts[1] || '';
    const selectedTag = normalizePlayerTag(parsed.parts[2]);
    const expectedToken = parsed.parts[3] || '';

    if (!signupId || !optionKey || !selectedTag || !expectedToken) {
        await interaction.reply({
            content: staleSignupMessage(),
            flags: 64
        });
        return;
    }

    await interaction.deferUpdate();

    const discordUser = buildDiscordUser(interaction);
    let linkedAccounts;
    let signups;
    try {
        [linkedAccounts, signups] = await Promise.all([
            rosterPublicData.readLinkedAccountsForDiscordUser(discordUser),
            rosterPublicData.readCwlLeagueSignups()
        ]);
    } catch {
        await interaction.editReply({
            content: 'Unable to load your CWL league preferences right now.',
            components: []
        });
        return;
    }

    const account = linkedAccounts.find(item => normalizePlayerTag(item?.playerTag || item?.tag) === selectedTag);
    if (!account) {
        await interaction.editReply({
            content: 'That account is no longer linked to your Discord user.',
            components: []
        });
        return;
    }

    const currentPreference = getPreferenceByTag(signups, selectedTag);
    if (!currentPreference) {
        await interaction.editReply({
            content: 'That CWL league preference is no longer saved. Choose a league again to save a new preference.',
            components: []
        });
        return;
    }

    if (!userOwnsPreference(currentPreference, discordUser.id)) {
        await interaction.editReply({
            content: 'That CWL league preference belongs to another Discord user, so I did not change it.',
            components: []
        });
        return;
    }

    if (preferenceChangeToken(currentPreference) !== expectedToken) {
        await interaction.editReply({
            content: 'Your CWL league preference changed since this confirmation was shown. Choose a league again to confirm the current change.',
            components: []
        });
        return;
    }

    const nextOption = getSignupOption(signups, optionKey);
    if (!nextOption) {
        await interaction.editReply({
            content: 'That CWL league choice is no longer available. Please use the latest signup message.',
            components: []
        });
        return;
    }

    if (preferenceMatchesOption(currentPreference, nextOption)) {
        await interaction.editReply({
            content: `${accountLabel(account)} is already signed up for ${preferenceLeagueLabel(nextOption) || 'that CWL league'}.`,
            components: []
        });
        return;
    }

    await savePreference(interaction, signupId, nextOption.leagueKey, account, '', {
        optionKey: nextOption.optionKey,
        allowChange: true,
        previousPreference: currentPreference
    });
}

async function handleChangePreferenceCancel(interaction) {
    await interaction.update({
        content: 'CWL league preference change cancelled.',
        components: []
    });
}

async function getCwlLeaguePreferenceCount() {
    const signups = await rosterPublicData.readCwlLeagueSignups();
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

    if (interaction.isButton() && parsed.action === 'my_votes') {
        await handleMyVotesButton(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'clear_vote') {
        await handleClearVoteButton(interaction, parsed);
        return true;
    }

    if (interaction.isStringSelectMenu() && parsed.action === 'clear_vote_select') {
        await handleClearVoteSelect(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'chg') {
        await handleChangePreferenceConfirm(interaction, parsed);
        return true;
    }

    if (interaction.isButton() && parsed.action === 'chg_cancel') {
        await handleChangePreferenceCancel(interaction);
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
        rosterPublicData.readCwlLeagueSignups(),
        rosterPublicData.readActiveRosterPayload()
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
        const leagueName = preferenceLeagueLabel(pref);
        const user = truncate(pref.discordId ? `<@${pref.discordId}>` : (pref.discordDisplayName || pref.discordUsername || 'unknown Discord'), 120);

        return `${leagueName}: ${name} (${tag}) - ${user}`;
    });

    return splitLinesForDiscord(lines);
}

async function buildCwlLeagueSignupSummary() {
    return (await buildCwlLeagueSignupSummaryChunks()).join('\n\n');
}

async function showCwlLeagueSignupSummary(interaction) {
    if (!isSeasonEventAdmin(interaction.member)) {
        await interaction.reply({
            content: 'This command is staff only.',
            flags: 64
        });
        return;
    }

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
    buildCwlLeagueSignupSummaryChunks,
    buildCwlLeagueSignupMessagePayload: buildSignupMessagePayload,
    buildCwlLeagueCustomId: buildCustomId,
    parseCwlLeagueCustomId: parseCustomId,
    resolveCwlLeagueEmoji,
    normalizeCwlLeaguePreferenceList,
    formatUserPreferencesResponse
};
