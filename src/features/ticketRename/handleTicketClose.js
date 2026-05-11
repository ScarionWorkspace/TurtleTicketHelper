const cleanName = require('../../utils/cleanName');
const appConfig = require('../../config/appConfig');
const { getMessageText, findTicketOpener } = require('./ticketHelpers');

module.exports = async function handleTicketClose(message) {
    try {
        if (!message.guild) return;
        if (appConfig.ticket.ticketToolBotId && message.author.id !== appConfig.ticket.ticketToolBotId) return;
        if (!message.channel) return;

        let channel = await message.channel.fetch();

        if (
            channel.parentId !== appConfig.ticket.openCategoryId &&
            channel.parentId !== appConfig.ticket.closedCategoryId
        ) {
            return;
        }

        const fullText = getMessageText(message);
        if (!fullText.includes(appConfig.ticketRename.closeTriggerText)) return;

        const opener = await findTicketOpener(channel);
        if (!opener) {
            console.log(`Could not find opener for ${channel.name}`);
            return;
        }

        if (
            appConfig.ticket.closedCategoryId &&
            channel.parentId !== appConfig.ticket.closedCategoryId
        ) {
            channel = await channel.setParent(appConfig.ticket.closedCategoryId);
        }

        const newName = `${appConfig.ticketRename.closedNamePrefix}${cleanName(opener.username)}`;
        if (channel.name !== newName) {
            await channel.setName(newName);
            console.log(`Closed ticket renamed to ${newName}`);
        }

        await channel.send(appConfig.ticketRename.deleteWarningMessage);

        setTimeout(async () => {
            try {
                const freshChannel = await message.guild.channels.fetch(channel.id).catch(() => null);

                if (!freshChannel) return;
                if (!freshChannel.name.startsWith(appConfig.ticketRename.closedNamePrefix)) return;

                await freshChannel.delete(appConfig.ticketRename.deleteReason);
                console.log(`Deleted closed ticket channel ${newName}`);
            } catch (error) {
                console.error('Failed to auto-delete closed channel:', error);
            }
        }, appConfig.ticket.autoDeleteClosedChannelMs);
    } catch (error) {
        console.error('Close rename failed:', error);
    }
};