const handleTicketClose = require('../features/ticketRename/handleTicketClose');

module.exports = {
    name: 'messageCreate',
    async execute(message) {
        await handleTicketClose(message);
    }
};