'use strict';

const CONTACT_REPLY_PROMPT = "If you would like to explain, use Discord's Reply action to reply to this message. Your response will be forwarded privately to the moderation team.";
const LEGACY_CONTACT_REPLY_PROMPT = 'If you would like to explain, reply to this message. Your reply will be forwarded privately to the moderation team.';
const CONTACT_REMINDER_TEXT = 'We\u2019re still waiting for your response. Please reply here when you can so leadership can finish reviewing the situation.';
const MAX_DISCORD_MESSAGE_LENGTH = 2000;

function prepareContactMessage(messageRaw, contactPurposeRaw) {
    let message = String(messageRaw || '').trim();
    if (!message) throw new Error('The prepared decision message is empty.');
    if (String(contactPurposeRaw || '').trim() === 'general' && message.includes(LEGACY_CONTACT_REPLY_PROMPT)) {
        message = message.replace(LEGACY_CONTACT_REPLY_PROMPT, CONTACT_REPLY_PROMPT);
    }
    if (String(contactPurposeRaw || '').trim() === 'general' && !message.includes(CONTACT_REPLY_PROMPT)) {
        const suffix = `\n\n${CONTACT_REPLY_PROMPT}`;
        if (message.length + suffix.length > MAX_DISCORD_MESSAGE_LENGTH) {
            throw new Error('The prepared contact message is too long to include the required reply instructions. Shorten it, then send it again.');
        }
        message += suffix;
    }
    if (message.length > MAX_DISCORD_MESSAGE_LENGTH) {
        throw new Error('The prepared decision message is too long. Reopen the decision and shorten it first.');
    }
    return message;
}

module.exports = {
    CONTACT_REPLY_PROMPT,
    LEGACY_CONTACT_REPLY_PROMPT,
    CONTACT_REMINDER_TEXT,
    MAX_DISCORD_MESSAGE_LENGTH,
    prepareContactMessage
};
