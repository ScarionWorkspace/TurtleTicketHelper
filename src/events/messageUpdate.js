const handleClashPerkLinkMessage = require('../features/clashPerkLinks/handleClashPerkLinkMessage');

module.exports = {
    name: 'messageUpdate',
    async execute(_oldMessage, newMessage) {
        await handleClashPerkLinkMessage(newMessage);
    }
};
