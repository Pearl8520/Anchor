import { Events } from "discord.js";
import { ClientEvent } from "../structures/event.js";
import client from "../core/client.js";
import { modmailSettingsCommand, handleModmailSettingsInteraction } from "../services/modmail/modmail-settings.js";
import { mailAction, mailRoleCommand, mailRoleAutocomplete, mailThreadAutocomplete, mailCategoryAutocomplete } from "../services/modmail/modmail-actions.js";
import { handlePanelButtonClick } from "../services/modmail/modmail-panel.js";

export default new ClientEvent(Events.InteractionCreate, async interaction => {
    if (!interaction.inCachedGuild()) return;

    if (interaction.isAutocomplete()) {
        const commandName = interaction.commandName;
        if (commandName === 'mail-role') {
            return await mailRoleAutocomplete(interaction);
        }
        if (commandName === 'mail') {
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'category') return await mailCategoryAutocomplete(interaction);
            return await mailThreadAutocomplete(interaction);
        }
        return;
    }

    if (interaction.isChatInputCommand()) {
        const commandName = interaction.commandName;

        if (commandName === 'modmail-settings') return await modmailSettingsCommand(interaction);
        if (commandName === 'mail') return await mailAction(interaction);
        if (commandName === 'mail-role') return await mailRoleCommand(interaction);

        const interactionCommand = client.commands.getCommand(interaction.commandName);
        if (interactionCommand) return interactionCommand.execute(interaction);
    }

    if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isChannelSelectMenu() || interaction.isRoleSelectMenu() || interaction.isUserSelectMenu() || interaction.isModalSubmit()) {
        const [commandName] = interaction.customId.split('_');

        if (commandName === 'modmail-panel' && interaction.isButton()) return await handlePanelButtonClick(interaction);
        if (commandName === 'modmail-settings') return await handleModmailSettingsInteraction(interaction);
    }
})
