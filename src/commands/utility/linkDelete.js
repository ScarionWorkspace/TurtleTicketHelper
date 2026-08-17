const {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const { handleLinkDeleteCommand } = require('../../features/rosterLinks/manualRosterLinks');

function restrictToGuild(builder) {
    if (typeof builder.setContexts === 'function') {
        return builder.setContexts(InteractionContextType.Guild);
    }

    return builder.setDMPermission(false);
}

module.exports = {
    data: restrictToGuild(
        new SlashCommandBuilder()
            .setName('link-delete')
            .setDescription('Staff only: delete a saved Discord link.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('Discord user whose saved link should be deleted')
                    .setRequired(false)
            )
            .addStringOption(option =>
                option
                    .setName('player_tag')
                    .setDescription('Clash player tag whose saved link should be deleted')
                    .setRequired(false)
            )
    ),

    async execute(interaction) {
        await handleLinkDeleteCommand(interaction);
    }
};
