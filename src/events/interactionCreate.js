const handleJoinClanButton = require('../features/joinClanApplication/handleJoinClanButton');
const handleJoinClanModal = require('../features/joinClanApplication/handleJoinClanModal');
const handleRecommendClanButton = require('../features/joinClanApplication/handleRecommendClanButton');
const handleRecommendClanSelect = require('../features/joinClanApplication/handleRecommendClanSelect');
const handleSeasonEventInteraction = require('../features/seasonEvents/handleSeasonEventInteraction');
const {
    handleCwlLeagueSignupInteraction
} = require('../features/cwlLeagueSignups/cwlLeagueSignupFlow');
const {
    handleRosterPlayersInteraction
} = require('../features/rosterPlayers/rosterPlayersInteraction');

async function replyToFailedInteraction(interaction) {
    try {
        const payload = {
            content: 'There was an error while handling this interaction.',
            flags: 64
        };

        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(payload);
            return;
        }

        await interaction.reply(payload);
    } catch (error) {
        console.error('Failed to send interaction error response:', {
            interactionId: interaction?.id || null,
            interactionType: interaction?.type || null,
            errorName: error?.name || null,
            errorMessage: error?.message || null,
            errorCode: error?.code || null,
            status: error?.status || null
        });
    }
}

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        try {
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
                    await replyToFailedInteraction(interaction);
                }

                return;
            }

            if (interaction.isButton()) {
                if (await handleCwlLeagueSignupInteraction(interaction)) {
                    return;
                }

                if (await handleSeasonEventInteraction(interaction)) {
                    return;
                }

                if (await handleRosterPlayersInteraction(interaction)) {
                    return;
                }

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
                if (await handleCwlLeagueSignupInteraction(interaction)) {
                    return;
                }

                if (await handleSeasonEventInteraction(interaction)) {
                    return;
                }

                if (await handleRosterPlayersInteraction(interaction)) {
                    return;
                }

                await handleRecommendClanSelect(interaction);
                return;
            }

            if (interaction.isModalSubmit()) {
                if (await handleSeasonEventInteraction(interaction)) {
                    return;
                }

                await handleJoinClanModal(interaction);
            }
        } catch (error) {
            console.error('Interaction handling failed:', {
                interactionId: interaction?.id || null,
                customId: interaction?.customId || null,
                commandName: interaction?.commandName || null,
                errorName: error?.name || null,
                errorMessage: error?.message || null,
                errorCode: error?.code || null,
                status: error?.status || null
            });
            await replyToFailedInteraction(interaction);
        }
    }
};
