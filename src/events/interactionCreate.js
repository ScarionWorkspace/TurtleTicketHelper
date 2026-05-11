const handleJoinClanButton = require('../features/joinClanApplication/handleJoinClanButton');
const handleJoinClanModal = require('../features/joinClanApplication/handleJoinClanModal');
const handleRecommendClanButton = require('../features/joinClanApplication/handleRecommendClanButton');
const handleRecommendClanSelect = require('../features/joinClanApplication/handleRecommendClanSelect');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction) {
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