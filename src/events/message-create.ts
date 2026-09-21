import { Events, ThreadChannel } from "discord.js";
import { nanoid } from "nanoid";
import { ClientEvent } from "../structures/event.js";
import { ErrorHandler } from "../structures/error-handler.js";
import { database } from "../core/database.js";
import { handleIncomingDm, replyToModmailThread } from "../services/modmail/modmail-relay.js";
import { buildStickerRelay } from "../services/modmail/modmail-relay-content.js";

// A staff reply typed as "/mail reply <text>" (see message content check below) briefly exists as a
// real channel message before being relayed and deleted — waiting this long before persisting a plain
// thread message as internal "chat" lets that delete happen first, so a reply never gets double-logged
// as both the relayed message AND a separate staff-chat entry.
const STAFF_CHAT_LOG_DELAY_MS = 2000;

// Staff reply to Modmail isn't a slash command at all — it's the start of a normal Discord message:
// type "/mail reply" (or "/mail real reply" to show full identity), attach a file/GIF/sticker the
// normal way, add text, hit send. No fields, no options, no follow-up prompt.
const REPLY_PREFIX = /^\/mail\s+(real\s+reply|reply)\b\s*/i;

function parseReplyPrefix(content: string): { anonymous: boolean; text: string } | null {
    const match = content.match(REPLY_PREFIX);
    if (!match) return null;
    return { anonymous: match[1].toLowerCase().startsWith('real'), text: content.slice(match[0].length) };
}

export default new ClientEvent(Events.MessageCreate, async (message) => {
    if (!message.inGuild()) {
        try {
            if (message.author.bot || message.system) return;
            await handleIncomingDm(message);
        } catch (err) {
            ErrorHandler.handle(err, { context: Events.MessageCreate, emitAlert: true });
        }
        return;
    }

    // Log Link / Transcript should show the full picture of a thread, including staff just talking
    // amongst themselves in it (not every message is a reply sent to the user) — persisted as its own
    // 'staff-chat' direction, distinct from relayed 'to-user' replies.
    try {
        if (message.author.bot || message.system) return;

        const thread = await database.modmailThreads.fetchByChannelId(message.channelId);
        if (!thread || thread.status !== 'open') return;

        const parsedReply = parseReplyPrefix(message.content);
        if (parsedReply && message.channel instanceof ThreadChannel) {
            const settings = await database.modmailSettings.fetch(message.guild.id);
            const allStaffRoleIds = settings ? [...settings.staffRoleIds, ...settings.categories.flatMap(c => c.staffRoleIds)] : [];
            const isStaff = message.member ? allStaffRoleIds.some(roleId => message.member!.roles.cache.has(roleId)) : false;

            if (isStaff) {
                const { mediaUrls: stickerMediaUrls, note: stickerNote } = buildStickerRelay(message.stickers);
                const text = [parsedReply.text, stickerNote].filter(Boolean).join('\n');
                const staffDisplayName = message.member?.displayName ?? message.author.username;

                const result = await replyToModmailThread(
                    thread, message.client, message.channel, message.author.id, staffDisplayName,
                    text, parsedReply.anonymous, message.attachments, stickerMediaUrls
                );

                // Deleted only after attachments have actually been read/relayed — deleting first
                // invalidates its attachment CDN links before the relay ever references them.
                await message.delete().catch(() => null);
                if (!result.success) await message.channel.send({ content: result.message }).catch(() => null);
                return;
            }
        }

        setTimeout(async () => {
            try {
                const stillExists = await message.channel.messages.fetch(message.id).catch(() => null);
                if (!stillExists) return; // deleted already — this was a reply-in-progress, not plain chat

                await database.modmailMessages.create({
                    id: nanoid(12),
                    modmailThreadId: thread.id,
                    direction: 'staff-chat',
                    authorId: message.author.id,
                    body: message.content,
                    dmMessageId: null,
                    relayMessageId: message.id,
                    attachmentUrls: [...message.attachments.values()].map(a => a.url),
                    createdAt: message.createdTimestamp,
                    displayName: message.member?.displayName ?? message.author.username
                });
            } catch (err) {
                ErrorHandler.handle(err, { context: Events.MessageCreate, emitAlert: false });
            }
        }, STAFF_CHAT_LOG_DELAY_MS);
    } catch (err) {
        ErrorHandler.handle(err, { context: Events.MessageCreate, emitAlert: true });
    }
});
