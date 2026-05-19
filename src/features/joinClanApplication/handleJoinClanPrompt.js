const { EmbedBuilder, ButtonBuilder, ActionRowBuilder, ButtonStyle } = require('discord.js');
const appConfig = require('../../config/appConfig');

module.exports = async function handleJoinClanPrompt(channel) {
    const embed = new EmbedBuilder()
        .setColor(appConfig.joinClan.colors.promptEmbed)
        .setTitle(appConfig.joinClan.prompt.title)
        .setDescription(appConfig.joinClan.prompt.description);

    const button = new ButtonBuilder()
        .setCustomId('join_clan_apply')
        .setLabel(appConfig.joinClan.prompt.startButtonLabel)
        .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(button);

    await channel.send({
        embeds: [embed],
        components: [row]
    });
};