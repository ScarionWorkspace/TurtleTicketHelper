const { ChannelType } = require('discord.js');
const cleanName = require('../../utils/cleanName');
const appConfig = require('../../config/appConfig');
const handleJoinClanPrompt = require('../joinClanApplication/handleJoinClanPrompt');
const { detectTicketType, getMessageText } = require('./ticketHelpers');

module.exports = async function handleTicketCreate(channel) {
    try {
        if (!channel.guild) return;
        if (channel.type !== ChannelType.GuildText) return;

        await new Promise((resolve) =>
            setTimeout(resolve, appConfig.ticketCreate.initialFetchDelayMs)
        );

        channel = await channel.fetch();

        if (channel.parentId !== appConfig.ticket.openCategoryId) return;

        const messages = await channel.messages.fetch({ limit: 10 });
        const sorted = [...messages.values()].sort(
            (a, b) => a.createdTimestamp - b.createdTimestamp
        );

        let opener = null;
        let ticketType = appConfig.ticketCreate.defaultTicketType;

        for (const msg of sorted) {
            if (
                appConfig.ticket.ticketToolBotId &&
                msg.author.id !== appConfig.ticket.ticketToolBotId
            ) {
                continue;
            }

            const mentionedUser = msg.mentions.users.first();
            if (mentionedUser) {
                opener = mentionedUser;
                ticketType = detectTicketType(getMessageText(msg));
                break;
            }
        }

        if (!opener) return;

        const newName = `${ticketType}-${cleanName(opener.username)}`;

        if (channel.name !== newName) {
            await channel.setName(newName);
            console.log(`Renamed channel to ${newName}`);
        }

        if (ticketType === appConfig.ticketCreate.joinClanTicketType) {
            await handleJoinClanPrompt(channel);
        }
    } catch (error) {
        console.error('Open rename failed:', error);
    }
};