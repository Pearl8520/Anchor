import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { InteractionCommand } from "../../structures/command.js";

export default new InteractionCommand({
    data: new SlashCommandBuilder()
        .setName('mail-role')
        .setDescription('Choose what shows as your identity on non-anonymous Modmail replies.')
        .addStringOption(o => o.setName('role').setDescription('A role you hold, or "Default".').setRequired(true).setAutocomplete(true))
        .setContexts(InteractionContextType.Guild),
    async execute() {}
});
