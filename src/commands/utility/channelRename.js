const { SlashCommandBuilder, ChannelType } = require('discord.js');
const appConfig = require('../../config/appConfig');

function isStaff(member) {
    if (!member || !member.roles || !member.roles.cache) return false;
    return (appConfig.staffRoleIds || []).some(roleId => member.roles.cache.has(roleId));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('channelrename')
        .setDescription('Rename the current channel manually.')
        .addStringOption(option =>
            option
                .setName('name')
                .setDescription('The new channel name')
                .setRequired(true)
        ),

    async execute(interaction) {
        if (!isStaff(interaction.member)) {
            await interaction.reply({
                content: 'This command is staff only.',
                flags: 64
            });
            return;
        }

        const channel = interaction.channel;

        if (!channel || channel.type !== ChannelType.GuildText) {
            await interaction.reply({
                content: 'This command can only be used in a text channel.',
                flags: 64
            });
            return;
        }

        const newName = interaction.options.getString('name', true).trim();

        if (!newName) {
            await interaction.reply({
                content: 'Please provide a valid channel name.',
                flags: 64
            });
            return;
        }

        const sanitizedName = newName
            .toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^a-z0-9-_]/g, '')
            .replace(/--+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 100);

        if (!sanitizedName) {
            await interaction.reply({
                content: 'The channel name became invalid after cleaning. Use letters, numbers, spaces, `-` or `_`.',
                flags: 64
            });
            return;
        }

        try {
            const oldName = channel.name;

            await channel.setName(
                sanitizedName,
                `Manual rename by ${interaction.user.tag}`
            );

            await interaction.reply({
                content: `Channel renamed from **${oldName}** to **${sanitizedName}**.`,
                flags: 64
            });
        } catch (error) {
            console.error('Manual channel rename failed:', error);

            await interaction.reply({
                content: 'Failed to rename this channel. Please check bot permissions.',
                flags: 64
            });
        }
    }
};