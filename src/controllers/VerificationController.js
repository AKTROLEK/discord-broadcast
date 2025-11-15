const { MessageActionRow, MessageButton, MessageEmbed } = require('discord.js');
const config = require('../../config');
const languageManager = require('../models/LanguageManager');
const { createLogger } = require('../utils/helpers');

const logger = createLogger('VerificationController');
const notifiedMembers = new Set();

const buildButtons = (memberId) => {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`verification:pass:${memberId}`)
            .setStyle('SUCCESS')
            .setLabel(languageManager.translate('verification.passButton')),
        new MessageButton()
            .setCustomId(`verification:fail:${memberId}`)
            .setStyle('DANGER')
            .setLabel(languageManager.translate('verification.failButton'))
    );
};

const resolveLogChannelId = () => {
    const verifyChannel = config.verification?.logChannelId;
    if (verifyChannel && verifyChannel !== 'ID') return verifyChannel;

    if (config.server.reportChannelId && config.server.reportChannelId !== 'ID') {
        return config.server.reportChannelId;
    }

    return null;
};

const sendLogMessage = async (client, user, actionKey) => {
    const channelId = resolveLogChannelId();
    if (!channelId) return;

    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel) return;

        const embed = new MessageEmbed()
            .setColor(actionKey === 'pass' ? config.colors.success : config.colors.error)
            .setTitle(languageManager.translate('verification.logTitle'))
            .setDescription(languageManager.translate(
                'verification.logDescription',
                user.tag,
                languageManager.translate(actionKey === 'pass' ? 'verification.passButton' : 'verification.failButton')
            ))
            .setTimestamp();

        await channel.send({ embeds: [embed] });
    } catch (error) {
        logger.warn(`Failed to send verification log message: ${error.message}`);
    }
};

const handleGuildMemberUpdate = async (oldMember, newMember) => {
    if (!config.verification?.enabled) return;
    if (!newMember || !newMember.guild) return;
    if (newMember.guild.id !== config.server.guildId) return;

    if (oldMember?.pending && !newMember.pending) {
        if (notifiedMembers.has(newMember.id)) return;

        const embed = new MessageEmbed()
            .setColor(config.colors.primary)
            .setTitle(languageManager.translate('verification.dmTitle', newMember.guild.name))
            .setDescription(languageManager.translate('verification.dmDescription'))
            .setFooter({ text: languageManager.translate('verification.dmFooter') });

        try {
            await newMember.send({ embeds: [embed], components: [buildButtons(newMember.id)] });
            notifiedMembers.add(newMember.id);
            logger.info(`Sent verification DM to ${newMember.user.tag}`);
        } catch (error) {
            logger.warn(`Failed to send verification DM to ${newMember.user.tag}: ${error.message}`);
        }
    }
};

const handleButtonInteraction = async (interaction) => {
    if (!config.verification?.enabled) return false;
    if (!interaction.customId?.startsWith('verification:')) return false;

    const [, action, memberId] = interaction.customId.split(':');

    if (interaction.user.id !== memberId) {
        await interaction.reply({
            content: languageManager.translate('verification.notAllowed'),
            ephemeral: true
        });
        return true;
    }

    const responseKey = action === 'pass' ? 'verification.passResponse' : 'verification.failResponse';

    await interaction.reply({
        content: languageManager.translate(responseKey),
        ephemeral: true
    });

    await sendLogMessage(interaction.client, interaction.user, action);

    return true;
};

module.exports = {
    handleGuildMemberUpdate,
    handleButtonInteraction
};
