const {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const {
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
    ),

    async execute(interaction) {
        await pingCwlRosterMoves(interaction);
    }
};
