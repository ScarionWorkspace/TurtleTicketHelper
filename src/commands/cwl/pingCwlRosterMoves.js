const {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const {
    autocompleteCwlRosterClan,
    pingCwlRosterMoves
} = require('../../features/cwlRosterMoves/cwlRosterMoves');

function restrictToGuild(builder) {
    if (typeof builder.setContexts === 'function') {
        return builder.setContexts(InteractionContextType.Guild);
    }

    return builder.setDMPermission(false);
}

module.exports = {
    data: restrictToGuild(
        new SlashCommandBuilder()
            .setName('ping-cwl-roster-moves')
            .setDescription('Ping planned CWL players who are not yet in their assigned clan.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addStringOption(option => option
                .setName('clan')
                .setDescription('Only check this destination clan; leave blank to check all clans.')
                .setRequired(false)
                .setAutocomplete(true))
            .addBooleanOption(option => option
                .setName('test')
                .setDescription('Show a private preview without posting or pinging anyone.')
                .setRequired(false))
    ),

    async autocomplete(interaction) {
        await autocompleteCwlRosterClan(interaction);
    },

    async execute(interaction) {
        await pingCwlRosterMoves(interaction);
    }
};
