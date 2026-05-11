const { TICKET_TOOL_BOT_ID } = require('./ticketConfig');

function getMessageText(message) {
    let text = message.content || '';

    for (const embed of message.embeds) {
        if (embed.title) text += ` ${embed.title}`;
        if (embed.description) text += ` ${embed.description}`;

        if (embed.fields?.length) {
            for (const field of embed.fields) {
                if (field.name) text += ` ${field.name}`;
                if (field.value) text += ` ${field.value}`;
            }
        }
    }

    return text.trim();
}

function detectTicketType(text) {
    const lower = text.toLowerCase();

    if (lower.includes('join clan')) return 'join-clan';
    if (lower.includes('other reasons')) return 'other-reasons';

    return 'ticket';
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
            if (TICKET_TOOL_BOT_ID && msg.author.id !== TICKET_TOOL_BOT_ID) continue;

            const text = getMessageText(msg).toLowerCase();
            const mentionedUser = msg.mentions.users.first();

            if (mentionedUser && text.includes('welcome')) {
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