import { InteractionContextType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import { InteractionCommand } from "../../structures/command.js";

export default new InteractionCommand({
    data: new SlashCommandBuilder()
        .setName('modmail')
        .setDescription('View or configure this server\'s Modmail inbox.')
        .addStringOption(o => o.setName('action').setDescription('Configuration action to perform.')
            .addChoices(
                { name: 'Add Category', value: 'add-category' },
                { name: 'Rename Category', value: 'rename-category' },
                { name: 'Remove Category', value: 'remove-category' },
                { name: 'Set Staff Role', value: 'set-staff-role' },
                { name: 'Remove Staff Role', value: 'remove-staff-role' },
                { name: 'Set Category Staff Role', value: 'set-category-staff-role' },
                { name: 'Remove Category Staff Role', value: 'remove-category-staff-role' },
                { name: 'Set Transcript Channel', value: 'set-transcript-channel' },
                { name: 'Set Attachment Channel', value: 'set-attachment-channel' },
                { name: 'Enable Reply Ping', value: 'enable-reply-ping' },
                { name: 'Disable Reply Ping', value: 'disable-reply-ping' },
                { name: 'Enable Reminders', value: 'enable-reminders' },
                { name: 'Disable Reminders', value: 'disable-reminders' },
                { name: 'Set Reminder Threshold', value: 'set-reminder-threshold' },
                { name: 'Post Panel', value: 'post-panel' },
                { name: 'Block User', value: 'block-user' },
                { name: 'Unblock User', value: 'unblock-user' },
                { name: 'List Blocked', value: 'list-blocked' },
                { name: 'User History', value: 'user-history' },
                { name: 'Link Main Server', value: 'link-main-server' },
                { name: 'Unlink Main Server', value: 'unlink-main-server' },
                { name: 'Enable', value: 'enable' },
                { name: 'Disable', value: 'disable' },
                { name: 'Reset', value: 'reset' }
            )
        )
        .addStringOption(o => o.setName('name').setDescription('The category\'s name, exactly as it appears in /modmail (not a role name).'))
        .addStringOption(o => o.setName('new_name').setDescription('The category\'s new display name (for rename-category) — key/transcripts stay unaffected.'))
        .addChannelOption(o => o.setName('channel').setDescription('Parent channel, panel channel, or transcript channel depending on the chosen action.'))
        .addRoleOption(o => o.setName('role').setDescription('Staff role — guild-wide or, with `name`, specific to one category.'))
        .addUserOption(o => o.setName('user').setDescription('User to block/unblock/view history for.'))
        .addStringOption(o => o.setName('reason').setDescription('Block reason (staff-only, never shown to the user).'))
        .addStringOption(o => o.setName('main_guild_id').setDescription('The main server\'s ID (for link-main-server) — enable Developer Mode to copy it.'))
        .addIntegerOption(o => o.setName('hours').setDescription('Reminder threshold in hours (for set-reminder-threshold).').setMinValue(1))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .setContexts(InteractionContextType.Guild),
    async execute() {}
});
