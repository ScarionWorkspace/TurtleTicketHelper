const {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder
} = require('discord.js');
const {
    formatRosterPlayerLines,
    chunkLines,
    normalizeClashTag
} = require('./rosterPlayersData');

const ROSTER_EMBED_COLOR = 0xff1f1f;
const EMBED_DESCRIPTION_MAX_CHARS = 3900;

function getRosterTitle(roster) {
    return String(roster?.title || roster?.id || 'Roster').trim() || 'Roster';
}

function buildClanProfileUrl(clanTag) {
    const normalizedClanTag = normalizeClashTag(clanTag);

    if (!normalizedClanTag) {
        return null;
    }

    return `https://link.clashofclans.com/en/?action=OpenClanProfile&tag=${encodeURIComponent(normalizedClanTag)}`;
}

function buildOpenInGameComponents(roster) {
    const clanProfileUrl = buildClanProfileUrl(roster?.connectedClanTag);

    if (!clanProfileUrl) {
        return [];
    }

    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('Open In-game')
                .setStyle(ButtonStyle.Link)
                .setURL(clanProfileUrl)
        )
    ];
}

function buildRosterFooter(roster, playerCount) {
    const normalizedClanTag = normalizeClashTag(roster?.connectedClanTag);
    const countLabel = `${playerCount} player${playerCount === 1 ? '' : 's'}`;

    return normalizedClanTag ? `${countLabel} - ${normalizedClanTag}` : countLabel;
}

function buildRosterEmbed(roster, description, index, total, playerCount) {
    const title = getRosterTitle(roster);
    const pageLabel = total > 1 ? ` (${index + 1}/${total})` : '';

    return new EmbedBuilder()
        .setColor(ROSTER_EMBED_COLOR)
        .setTitle(`${title}${pageLabel}`.slice(0, 256))
        .setDescription(description)
        .setFooter({
            text: buildRosterFooter(roster, playerCount)
        });
}

function buildRosterPlayerMessages(roster, playerMetrics) {
    const lines = formatRosterPlayerLines(roster, playerMetrics);
    const descriptions = lines.length > 0
        ? chunkLines(lines, EMBED_DESCRIPTION_MAX_CHARS)
        : ['No players are listed for this roster.'];
    const components = buildOpenInGameComponents(roster);

    return descriptions.map((description, index) => ({
        embeds: [
            buildRosterEmbed(
                roster,
                description,
                index,
                descriptions.length,
                lines.length
            )
        ],
        components: index === 0 ? components : []
    }));
}

module.exports = {
    ROSTER_EMBED_COLOR,
    EMBED_DESCRIPTION_MAX_CHARS,
    buildClanProfileUrl,
    buildRosterPlayerMessages
};
