import { Events } from "discord.js";
import { ClientEvent } from "../structures/event.js";
import client from "../core/client.js";
import { modmailConfig } from "../services/modmail/modmail-config.js";
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

        if (commandName === 'modmail') return await modmailConfig(interaction);
        if (commandName === 'mail') return await mailAction(interaction);
        if (commandName === 'mail-role') return await mailRoleCommand(interaction);

        const interactionCommand = client.commands.getCommand(interaction.commandName);
        if (interactionCommand) return interactionCommand.execute(interaction);
    }

    if (interaction.isButton()) {
        const [commandName] = interaction.customId.split('_');

        if (commandName === 'modmail-panel') return await handlePanelButtonClick(interaction);
    }
})
