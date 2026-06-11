const handleTicketClose = require('../features/ticketRename/handleTicketClose');
const handleClashPerkLinkMessage = require('../features/clashPerkLinks/handleClashPerkLinkMessage');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        await Promise.all([
            handleTicketClose(message),
            handleClashPerkLinkMessage(message)
        ]);
    }
};
