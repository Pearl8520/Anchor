import { InteractionContextType, SlashCommandBuilder } from "discord.js";
import { InteractionCommand } from "../../structures/command.js";

export default new InteractionCommand({
    data: new SlashCommandBuilder()
        .setName('mail')
        .setDescription('Modmail thread actions — most run inside a thread; Open/Reopen run from a category channel.')
        .addStringOption(o => o.setName('action').setDescription('The action to perform. To reply, type "/mail reply <text>" as a message instead.').setRequired(true)
            .addChoices(
                { name: 'Reply', value: 'reply' },
                { name: 'Real Reply', value: 'anonreply' },
                { name: 'Edit', value: 'edit' },
                { name: 'Close', value: 'close' },
                { name: 'Open', value: 'open' },
                { name: 'Reopen', value: 'reopen' },
                { name: 'Move Category', value: 'move' },
                { name: 'Claim', value: 'claim' },
                { name: 'Unclaim', value: 'unclaim' },
                { name: 'Suspend', value: 'suspend' },
                { name: 'Unsuspend', value: 'unsuspend' },
                { name: 'Transcript', value: 'transcript' },
                { name: 'Log Link', value: 'log-link' },
                { name: 'Logs', value: 'logs' },
                { name: 'Add Staff Member', value: 'add-staff' },
                { name: 'Remove Staff Member', value: 'remove-staff' },
                { name: 'Send Snippet', value: 'snippet-send' },
                { name: 'Add Snippet', value: 'snippet-add' },
                { name: 'Edit Snippet', value: 'snippet-edit' },
                { name: 'Delete Snippet', value: 'snippet-delete' },
                { name: 'List Snippets', value: 'snippets-list' },
                { name: 'View Snippet', value: 'snippet-view' }
            )
        )
        .addStringOption(o => o.setName('text').setDescription('Reply text / close reason / snippet body / new text (edit).'))
        .addIntegerOption(o => o.setName('message_number').setDescription('The #N shown on your own reply in the thread (for edit).'))
        .addStringOption(o => o.setName('category').setDescription('Target category (for move/open) — omit on open to use the current channel instead.').setAutocomplete(true))
        .addStringOption(o => o.setName('trigger').setDescription('Snippet trigger (for snippet actions).'))
        .addStringOption(o => o.setName('thread').setDescription('Closed thread to reopen (for reopen) — run in that category\'s channel.').setAutocomplete(true))
        .addUserOption(o => o.setName('user').setDescription('Staff member to add/remove (add-staff/remove-staff), or the user to open a thread with (open).'))
        .setContexts(InteractionContextType.Guild),
    async execute() {}
});
