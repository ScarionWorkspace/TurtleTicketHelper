const handleTicketClose = require('../features/ticketRename/handleTicketClose');
const handleClashPerkLinkMessage = require('../features/clashPerkLinks/handleClashPerkLinkMessage');
const { handleWarFollowupPlayerReply } = require('../features/warFollowup/playerReply');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        await Promise.all([
            handleTicketClose(message),
            handleClashPerkLinkMessage(message),
            handleWarFollowupPlayerReply(message, message.client)
        ]);
    }
};
