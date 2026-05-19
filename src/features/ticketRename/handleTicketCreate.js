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

        channel = await channel.fetch().catch(() => null);
        if (!channel) return;

        if (channel.parentId !== appConfig.ticket.openCategoryId) return;

        const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
        if (!messages || messages.size === 0) return;

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

            const fullText = getMessageText(msg);
            const detectedType = detectTicketType(fullText);
            const mentionedUser = msg.mentions.users.first();

            if (mentionedUser) {
                opener = mentionedUser;
                ticketType = detectedType;
                break;
            }
        }

        if (!opener) return;

        const safeUsername = cleanName(opener.username) || 'user';
        const newName = `${ticketType}-${safeUsername}`;

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