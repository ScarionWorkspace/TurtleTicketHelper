const appConfig = require('../../config/appConfig');

function getMessageText(message) {
    let text = message.content || '';

    for (const embed of message.embeds ?? []) {
        if (embed.title) text += ` ${embed.title}`;
        if (embed.description) text += ` ${embed.description}`;

        if (embed.fields?.length) {
            for (const field of embed.fields) {
                if (field.name) text += ` ${field.name}`;
                if (field.value) text += ` ${field.value}`;
            }
        }

        if (embed.footer?.text) text += ` ${embed.footer.text}`;
        if (embed.author?.name) text += ` ${embed.author.name}`;
    }

    return text.trim();
}

function detectTicketType(text) {
    const lower = text.toLowerCase();

    if (lower.includes('topic: new member')) return 'join-clan';
    if (lower.includes('topic: general support')) return 'general-support';
    if (lower.includes('topic: partnership')) return 'partnership';
    if (lower.includes('topic: claim reward')) return 'claim-reward';

    return appConfig.ticketCreate.defaultTicketType;
}

async function findTicketOpener(channel) {
    let before;
    let pagesChecked = 0;

    while (pagesChecked < 10) {
        const options = { limit: 100 };
        if (before) options.before = before;

        const messages = await channel.messages.fetch(options);
        if (!messages.size) break;

        const sorted = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        for (const msg of sorted) {
            if (
                appConfig.ticket.ticketToolBotId &&
                msg.author.id !== appConfig.ticket.ticketToolBotId
            ) {
                continue;
            }

            const text = getMessageText(msg).toLowerCase();
            const mentionedUser = msg.mentions.users.first();

            if (mentionedUser) {
                return mentionedUser;
            }
        }

        before = sorted[0].id;
        pagesChecked++;
    }

    return null;
}

module.exports = {
    getMessageText,
    findTicketOpener,
    detectTicketType
};