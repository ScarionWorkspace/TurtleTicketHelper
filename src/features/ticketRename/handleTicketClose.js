const appConfig = require('../../config/appConfig');
const { getMessageText } = require('./ticketHelpers');

const activeCloseProcesses = new Set();

module.exports = async function handleTicketClose(message) {
    try {
        if (!message.guild || !message.channel) return;

        if (
            appConfig.ticket.ticketToolBotId &&
            message.author.id !== appConfig.ticket.ticketToolBotId
        ) {
            return;
        }

        const channel = await message.channel.fetch().catch(() => null);
        if (!channel) return;

        if (
            channel.parentId !== appConfig.ticket.openCategoryId &&
            channel.parentId !== appConfig.ticket.closedCategoryId
        ) {
            return;
        }

        const fullText = getMessageText(message);
        if (!fullText.includes(appConfig.ticketRename.closeTriggerText)) return;

        if (activeCloseProcesses.has(channel.id)) return;
        activeCloseProcesses.add(channel.id);

        try {
            await channel.send(appConfig.ticketRename.deleteWarningMessage);
        } catch (error) {
            console.error('[handleTicketClose] warning send failed:', error);
        }

        const deleteDelay = appConfig.ticket.autoDeleteClosedChannelMs || 10000;
        const channelId = channel.id;
        const guildId = message.guild.id;

        setTimeout(async () => {
            try {
                const guild = await message.client.guilds.fetch(guildId).catch(() => null);
                if (!guild) return;

                const freshChannel = await guild.channels.fetch(channelId).catch(() => null);
                if (!freshChannel) return;

                if (
                    freshChannel.parentId !== appConfig.ticket.closedCategoryId &&
                    !freshChannel.name.startsWith(appConfig.ticketRename.closedNamePrefix)
                ) {
                    return;
                }

                await freshChannel.delete(appConfig.ticketRename.deleteReason);
            } catch (error) {
                console.error('[handleTicketClose] delete failed:', error);
            } finally {
                activeCloseProcesses.delete(channelId);
            }
        }, deleteDelay);
    } catch (error) {
        console.error('[handleTicketClose] failed:', error);
    }
};