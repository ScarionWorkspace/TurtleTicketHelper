const { SlashCommandBuilder } = require('discord.js');
const { sendSeasonEventSignupMessage } = require('../../features/seasonEvents/sendSignupMessage');
const rosterPublicData = require('../../features/rosterPublicData/rosterPublicDataReadClient');
const { getOrderedRosters } = require('../../features/rosterPlayers/rosterPlayersData');

function isCwlRoster(roster) {
    const trackingMode = String(roster?.trackingMode || '').trim().toLowerCase();
    return trackingMode === 'cwl' && !!String(roster?.connectedClanTag || '').trim();
}

function formatRosterChoice(roster) {
    const title = String(roster?.title || roster?.name || roster?.id || 'Roster').trim();
    const clanTag = String(roster?.connectedClanTag || '').trim();
    return `${title}${clanTag ? ` (${clanTag})` : ''}`.slice(0, 100);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('send-cwl-event-signup')
        .setDescription('Send a roster-specific CWL event signup message in this channel.')
        .addStringOption(option => option
            .setName('roster')
            .setDescription('Roster whose signed-up accounts count for this CWL event.')
            .setRequired(true)
            .setAutocomplete(true)),
    async autocomplete(interaction) {
        const focused = String(interaction.options.getFocused() || '').trim().toLowerCase();
        const payload = await rosterPublicData.readActiveRosterPayload({
            cacheTtlMs: 15_000,
            timeoutMs: 2_500
        });
        const choices = getOrderedRosters(payload)
            .filter(isCwlRoster)
            .filter(roster => !focused || `${roster.id} ${roster.title || ''} ${roster.connectedClanTag || ''}`.toLowerCase().includes(focused))
            .slice(0, 25)
            .map(roster => ({ name: formatRosterChoice(roster), value: String(roster.id).slice(0, 100) }));
        await interaction.respond(choices);
    },
    async execute(interaction) {
        await sendSeasonEventSignupMessage(interaction, 'cwl', {
            rosterId: interaction.options.getString('roster', true)
        });
    }
};
