const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder
} = require('discord.js');
const {
    ROSTER_EMBED_COLOR,
    buildClanProfileUrl
} = require('../rosterPlayers/rosterPlayersMessage');
const {
    buildLinkListModel,
    getRosterTitle
} = require('./linkListData');
const { normalizeClashTag } = require('../clashApi/fetchClanMembers');
const {
    MODE_NAMES,
    MODE_TAGS,
    normalizeMode,
    buildLinkListClanValue,
    buildLinkListRefreshCustomId,
    buildLinkListSwitchCustomId,
    buildLinkListViewCustomId
} = require('./linkListCustomIds');

const EMBED_DESCRIPTION_MAX_CHARS = 3900;
const DISPLAY_VALUE_LIMITS = [32, 28, 24, 20, 16, 12];
const LINKED_TAG_MODE_NAME_LIMITS = [32, 28, 24, 20, 16, 12, 8, 0];
const MAX_CLAN_SWITCH_OPTIONS = 25;
const REFRESH_BUTTON_EMOJI = '\uD83D\uDD04';

function getNextMode(mode) {
    return normalizeMode(mode) === MODE_NAMES ? MODE_TAGS : MODE_NAMES;
}

function normalizeDisplayValue(value, fallback = 'Unknown') {
    const normalized = String(value || fallback || 'Unknown')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/`/g, "'")
        .trim();

    return normalized || fallback || 'Unknown';
}

function truncateDisplayValue(value, maxLength) {
    const text = normalizeDisplayValue(value);

    if (text.length <= maxLength) {
        return text;
    }

    if (maxLength <= 3) {
        return text.slice(0, maxLength);
    }

    return `${text.slice(0, maxLength - 3)}...`;
}

function codeValue(value, maxLength) {
    return `\`${truncateDisplayValue(value, maxLength)}\``;
}

function fullCodeValue(value) {
    return `\`${normalizeDisplayValue(value)}\``;
}

function formatDiscordHandle(value) {
    const username = String(value || '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .replace(/`/g, "'")
        .trim()
        .replace(/^@+/, '');

    return username ? `@\`${username}\`` : '';
}

function getDiscordDisplay(row) {
    if (row.discordUsername) {
        return row.discordUsername;
    }

    if (row.discordId) {
        return `Discord ID ${row.discordId}`;
    }

    return 'Unknown Discord';
}

function formatDiscordDisplay(row) {
    return fullCodeValue(getDiscordDisplay(row));
}

function formatLinkedDiscordDisplay(row) {
    return row.discordUsername
        ? formatDiscordHandle(row.discordUsername)
        : formatDiscordDisplay(row);
}

function getDisplayHeader(mode) {
    return normalizeMode(mode) === MODE_NAMES
        ? 'Displaying: `Discord / In-Game Name`'
        : 'Displaying: `Discord / #PlayerTag / In-Game Name`';
}

function formatLinkedRow(row, mode, maxValueLength) {
    if (normalizeMode(mode) === MODE_TAGS) {
        const base = `✅ ${formatLinkedDiscordDisplay(row)} / ${fullCodeValue(row.tag)}`;
        const extraName = maxValueLength > 0
            ? codeValue(row.inGameName, maxValueLength)
            : '';

        return extraName ? `${base} / ${extraName}` : base;
    }

    return `✅ ${formatLinkedDiscordDisplay(row)} / ${codeValue(row.inGameName, maxValueLength)}`;
}

function formatLinkedNotInServerRow(row, mode, maxValueLength) {
    if (normalizeMode(mode) === MODE_TAGS) {
        const base = `⚠️ ${formatLinkedDiscordDisplay(row)} / ${fullCodeValue(row.tag)}`;
        const extraName = maxValueLength > 0
            ? codeValue(row.inGameName, maxValueLength)
            : '';

        return extraName ? `${base} / ${extraName}` : base;
    }

    return `⚠️ ${formatLinkedDiscordDisplay(row)} / ${codeValue(row.inGameName, maxValueLength)}`;
}

function formatNotLinkedRow(row, maxValueLength) {
    return `❌ ${codeValue(row.inGameName, maxValueLength)} / ${fullCodeValue(row.tag)}`;
}

function formatNotLinkedSection(title, rows, maxValueLength) {
    const lines = rows.map(row =>
        formatNotLinkedRow(row, maxValueLength)
    );

    return [
        `**${title}**`,
        lines.length > 0 ? lines.join('\n') : '_None_'
    ].join('\n');
}

function formatLinkedSection(title, rows, mode, maxValueLength, linkedNameLimit, formatter) {
    const lines = rows.map(row =>
        formatter(
            row,
            mode,
            normalizeMode(mode) === MODE_TAGS ? linkedNameLimit : maxValueLength
        )
    );

    return [
        `**${title}**`,
        lines.length > 0 ? lines.join('\n') : '_None_'
    ].join('\n');
}

function buildDescription(model, mode) {
    for (const maxValueLength of DISPLAY_VALUE_LIMITS) {
        for (const linkedNameLimit of LINKED_TAG_MODE_NAME_LIMITS) {
            const description = [
                getDisplayHeader(mode),
                formatLinkedSection('Linked', model.linked, mode, maxValueLength, linkedNameLimit, formatLinkedRow),
                formatLinkedSection(
                    'Linked but not in Server',
                    model.linkedNotInServer,
                    mode,
                    maxValueLength,
                    linkedNameLimit,
                    formatLinkedNotInServerRow
                ),
                formatNotLinkedSection('Not Linked', model.notLinked, maxValueLength)
            ].join('\n\n');

            if (description.length <= EMBED_DESCRIPTION_MAX_CHARS) {
                return description;
            }
        }
    }

    const smallestLimit = DISPLAY_VALUE_LIMITS[DISPLAY_VALUE_LIMITS.length - 1];

    return [
        getDisplayHeader(mode),
        formatLinkedSection('Linked', model.linked, mode, smallestLimit, 0, formatLinkedRow),
        formatLinkedSection(
            'Linked but not in Server',
            model.linkedNotInServer,
            mode,
            smallestLimit,
            0,
            formatLinkedNotInServerRow
        ),
        formatNotLinkedSection('Not Linked', model.notLinked, smallestLimit)
    ].join('\n\n').slice(0, EMBED_DESCRIPTION_MAX_CHARS);
}

function buildFooterText(model) {
    const linkedCount = model.linked.length;
    const linkedNotInServerCount = model.linkedNotInServer.length;
    const notLinkedCount = model.notLinked.length;
    const totalLabel = `${model.total} current player${model.total === 1 ? '' : 's'}`;
    const linkedLabel = `${linkedCount} linked`;
    const linkedNotInServerLabel = `${linkedNotInServerCount} not in server`;
    const notLinkedLabel = `${notLinkedCount} not linked`;

    return `${totalLabel} - ${linkedLabel} / ${linkedNotInServerLabel} / ${notLinkedLabel} - ${model.clanTag}`;
}

function buildToggleButton(model, mode) {
    const nextMode = getNextMode(mode);

    return new ButtonBuilder()
        .setCustomId(buildLinkListViewCustomId(model.clanTag, nextMode))
        .setLabel(nextMode === MODE_NAMES ? 'Hide Player Tags' : 'Show Player Tags')
        .setStyle(ButtonStyle.Secondary);
}

function buildRefreshButton(model, mode) {
    return new ButtonBuilder()
        .setCustomId(buildLinkListRefreshCustomId(model.clanTag, mode))
        .setEmoji(REFRESH_BUTTON_EMOJI)
        .setStyle(ButtonStyle.Secondary);
}

function truncateOptionText(value, fallback) {
    const text = String(value || fallback || '').replace(/\s+/g, ' ').trim();
    const safeText = text || fallback || 'Clan';

    return safeText.length <= 100 ? safeText : `${safeText.slice(0, 97)}...`;
}

function buildClanSwitchOption(roster, model) {
    const clanTag = normalizeClashTag(roster?.connectedClanTag);
    const title = getRosterTitle(roster);
    const label = `${title} (${clanTag})`;

    return new StringSelectMenuOptionBuilder()
        .setLabel(truncateOptionText(label, clanTag))
        .setValue(buildLinkListClanValue(clanTag))
        .setDefault(clanTag === model.clanTag);
}

function normalizeClanSwitchRosters(model, clanRosters) {
    const rosters = Array.isArray(clanRosters) ? clanRosters : [];
    const seen = new Set();
    const options = [];
    let selectedRoster = null;

    for (const roster of rosters) {
        const clanTag = normalizeClashTag(roster?.connectedClanTag);

        if (!clanTag || seen.has(clanTag)) {
            continue;
        }

        seen.add(clanTag);
        options.push(roster);

        if (clanTag === model.clanTag) {
            selectedRoster = roster;
        }
    }

    if (model.clanTag && !seen.has(model.clanTag)) {
        selectedRoster = {
            title: model.rosterTitle,
            connectedClanTag: model.clanTag
        };
        options.unshift(selectedRoster);
    }

    if (
        selectedRoster &&
        options.findIndex(roster =>
            normalizeClashTag(roster?.connectedClanTag) === model.clanTag
        ) >= MAX_CLAN_SWITCH_OPTIONS
    ) {
        return [
            selectedRoster,
            ...options.filter(roster =>
                normalizeClashTag(roster?.connectedClanTag) !== model.clanTag
            )
        ].slice(0, MAX_CLAN_SWITCH_OPTIONS);
    }

    return options.slice(0, MAX_CLAN_SWITCH_OPTIONS);
}

function buildClanSwitchRow(model, mode, clanRosters) {
    const switchRosters = normalizeClanSwitchRosters(model, clanRosters);

    if (switchRosters.length === 0) {
        return null;
    }

    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId(buildLinkListSwitchCustomId(mode))
            .setPlaceholder(`${model.rosterTitle} (${model.clanTag})`.slice(0, 150))
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(switchRosters.map(roster => buildClanSwitchOption(roster, model)))
    );
}

function buildComponents(model, mode, clanRosters) {
    const buttonRow = new ActionRowBuilder().addComponents(
        buildToggleButton(model, mode),
        buildRefreshButton(model, mode)
    );
    const clanProfileUrl = buildClanProfileUrl(model.clanTag);

    if (clanProfileUrl) {
        buttonRow.addComponents(
            new ButtonBuilder()
                .setLabel('Open In-game')
                .setStyle(ButtonStyle.Link)
                .setURL(clanProfileUrl)
        );
    }

    const components = [buttonRow];
    const clanSwitchRow = buildClanSwitchRow(model, mode, clanRosters);

    if (clanSwitchRow) {
        components.push(clanSwitchRow);
    }

    return components;
}

function buildLinkListEmbed(model, mode) {
    return new EmbedBuilder()
        .setColor(ROSTER_EMBED_COLOR)
        .setTitle(`Link List - ${model.rosterTitle}`.slice(0, 256))
        .setDescription(buildDescription(model, mode))
        .setFooter({
            text: buildFooterText(model).slice(0, 2048)
        });
}

function buildLinkListStatusEmbed(roster, description, footerText) {
    const clanTag = normalizeClashTag(roster?.connectedClanTag);
    const footer = [clanTag, footerText].filter(Boolean).join(' - ');
    const embed = new EmbedBuilder()
        .setColor(ROSTER_EMBED_COLOR)
        .setTitle(`Link List - ${getRosterTitle(roster)}`.slice(0, 256))
        .setDescription(description);

    if (footer) {
        embed.setFooter({
            text: footer.slice(0, 2048)
        });
    }

    return embed;
}

function buildLinkListLoadingMessage(roster) {
    return {
        embeds: [
            buildLinkListStatusEmbed(
                roster,
                [
                    '**Building link list...**',
                    'Fetching live Clash members and checking Discord server links.',
                    'This can take a few seconds for full clans.'
                ].join('\n')
            )
        ],
        components: []
    };
}

function buildLinkListErrorMessage(roster, errorText) {
    return {
        embeds: [
            buildLinkListStatusEmbed(
                roster,
                [
                    '**Could not build the link list.**',
                    normalizeDisplayValue(errorText, 'Please try again shortly.')
                ].join('\n')
            )
        ],
        components: []
    };
}

function buildLinkListMessage(roster, playerMetrics, liveMembers, mode = MODE_TAGS, options = {}) {
    const normalizedMode = normalizeMode(mode);
    const model = buildLinkListModel(roster, playerMetrics, liveMembers, {
        discordPresenceById: options?.discordPresenceById || {}
    });
    const clanRosters = Array.isArray(options?.clanRosters) ? options.clanRosters : [];

    return {
        embeds: [buildLinkListEmbed(model, normalizedMode)],
        components: buildComponents(model, normalizedMode, clanRosters)
    };
}

module.exports = {
    EMBED_DESCRIPTION_MAX_CHARS,
    DISPLAY_VALUE_LIMITS,
    getNextMode,
    normalizeDisplayValue,
    truncateDisplayValue,
    codeValue,
    fullCodeValue,
    formatDiscordHandle,
    formatDiscordDisplay,
    formatLinkedDiscordDisplay,
    getDisplayHeader,
    formatLinkedRow,
    formatLinkedNotInServerRow,
    formatNotLinkedRow,
    buildDescription,
    buildClanSwitchRow,
    buildRefreshButton,
    buildLinkListLoadingMessage,
    buildLinkListErrorMessage,
    buildLinkListMessage
};
