const handleTicketCreate = require('../features/ticketRename/handleTicketCreate');

module.exports = {
    name: 'channelCreate',
    async execute(channel) {
        await handleTicketCreate(channel);
    }
};