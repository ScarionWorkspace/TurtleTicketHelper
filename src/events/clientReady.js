module.exports = {
    name: 'clientReady',
    once: true,
    async execute(client) {
        try {
            const commands = client.commands.map(command => command.data.toJSON());
            await client.application.commands.set(commands);
            console.log('Registered slash commands.');
        } catch (error) {
            console.error('Failed to register slash commands:', error);
        }

        console.log(`Logged in as ${client.user.tag}`);
    }
};