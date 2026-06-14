const {
    InteractionContextType,
    PermissionFlagsBits,
    SlashCommandBuilder
} = require('discord.js');
const { handleLinkCommand } = require('../../features/rosterLinks/manualRosterLinks');

function restrictToGuild(builder) {
    if (typeof builder.setContexts === 'function') {
        return builder.setContexts(InteractionContextType.Guild);
    }

    return builder.setDMPermission(false);
}

module.exports = {
    data: restrictToGuild(
        new SlashCommandBuilder()
            .setName('link')
            .setDescription('Staff only: link a Discord user to a Clash player tag.')
            .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
            .addUserOption(option =>
                option
                    .setName('user')
                    .setDescription('Discord user to link')
                    .setRequired(true)
            )
            .addStringOption(option =>
                option
                    .setName('player_tag')
                    .setDescription('Clash player tag, with or without #')
                    .setRequired(true)
            )
            .addBooleanOption(option =>
                option
                    .setName('force')
                    .setDescription('Overwrite existing conflicting links')
                    .setRequired(false)
            )
    ),

    async execute(interaction) {
        await handleLinkCommand(interaction);
    }
};
