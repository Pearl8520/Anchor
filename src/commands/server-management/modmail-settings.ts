import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { InteractionCommand } from "../../structures/command.js";

export default new InteractionCommand({
    data: new SlashCommandBuilder()
        .setName('modmail-settings')
        .setDescription('Configure this server\'s Modmail inbox via menu.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setContexts(InteractionContextType.Guild),
    async execute() {}
});
