const handleJoinClanButton = require('../features/joinClanApplication/handleJoinClanButton');
const handleJoinClanModal = require('../features/joinClanApplication/handleJoinClanModal');
const handleRecommendClanButton = require('../features/joinClanApplication/handleRecommendClanButton');
const handleRecommendClanSelect = require('../features/joinClanApplication/handleRecommendClanSelect');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);

            if (!command) {
                await interaction.reply({
                    content: 'Unknown command.',
                    flags: 64
                });
                return;
            }

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing /${interaction.commandName}:`, error);

                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp({
                        content: 'There was an error while executing this command.',
                        flags: 64
                    });
                } else {
                    await interaction.reply({
                        content: 'There was an error while executing this command.',
                        flags: 64
                    });
                }
            }

            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId === 'join_clan_apply') {
                await handleJoinClanButton(interaction);
                return;
            }

            if (interaction.customId === 'recommend_clan') {
                await handleRecommendClanButton(interaction);
                return;
            }

            return;
        }

        if (interaction.isStringSelectMenu()) {
            await handleRecommendClanSelect(interaction);
            return;
        }

        if (interaction.isModalSubmit()) {
            await handleJoinClanModal(interaction);
        }
    }
};