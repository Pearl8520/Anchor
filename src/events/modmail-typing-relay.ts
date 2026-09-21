import { Events } from "discord.js";
import { ClientEvent } from "../structures/event.js";
import { ErrorHandler } from "../structures/error-handler.js";
import { database } from "../core/database.js";

// One-directional only: shows staff a "typing..." indicator in the thread when the user is typing in
// their DM to the bot. The user never needs to see staff typing back, so there's no relay the other
// way. Discord's TypingStart naturally refires every ~8-10s while someone keeps typing, and
// sendTyping()'s own ~10s display window means the relayed indicator just stays alive for as long as
// the user keeps typing, with no extra interval/refresh logic needed here.
export default new ClientEvent(Events.TypingStart, async (typing) => {
    try {
        if (typing.user.bot) return;
        if (typing.inGuild()) return; // only DMs relay — staff typing in the thread does nothing

        const openThreads = await database.modmailThreads.fetchOpenForUser(typing.user.id);
        const thread = openThreads[0];
        if (!thread) return;

        const guild = typing.client.guilds.cache.get(thread.guildId);
        const threadChannel = guild ? await guild.channels.fetch(thread.channelId).catch(() => null) : null;
        if (threadChannel?.isTextBased()) await threadChannel.sendTyping().catch(() => {});
    } catch (err) {
        ErrorHandler.handle(err, { context: Events.TypingStart, emitAlert: false });
    }
});
