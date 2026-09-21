import { AutocompleteInteraction, Attachment, ChannelType, Collection, TextChannel, ThreadChannel, PermissionFlagsBits } from "discord.js";
import { InGuildChatInputInteraction } from "../../types/discord.js";
import { database } from "../../core/database.js";
import { ErrorHandler } from "../../structures/error-handler.js";
import { replyToModmailThread, editModmailReply, reopenModmailThread, buildTranscriptFile, closeModmailThread, getOrCreateLogToken, ReplyResult } from "./modmail-relay.js";
import { buildStickerRelay, modmailNoticeEmbed } from "./modmail-relay-content.js";
import { findMatchingCategory } from "./modmail-config.js";
import { createModmailThread } from "./modmail-intake.js";
import { IRawModmailThread } from "../../types/database.js";
import { nanoid } from "nanoid";
import { dashboardEnv } from "../../config.js";

const DEFAULT_ROLE_CHOICE = 'default';

/** On success, no confirmation is shown at all — the relayed reply is already visible in the thread as
 * its own embed, so a separate "Reply sent." just duplicated that. A failure is still shown, since
 * that's actually actionable (e.g. couldn't DM the user). */
async function acknowledgeReplyResult(interaction: InGuildChatInputInteraction, result: ReplyResult): Promise<void> {
    if (result.success) await interaction.deleteReply().catch(() => null);
    else await interaction.editReply({ content: result.message }).catch(() => null);
}

/** Staff left `text` blank on reply/anonreply — the signal to just send a normal follow-up message (any text, any number of attachments, a sticker), same as posting in any channel, instead of juggling fixed attachment options. Whatever they send next gets relayed as the actual reply. */
async function promptForAttachmentReply(interaction: InGuildChatInputInteraction, thread: IRawModmailThread, channel: ThreadChannel, staffDisplayName: string, anonymous: boolean): Promise<void> {
    await interaction.editReply({ content: `${interaction.user}, send your reply now as a normal message (text, attachments, and/or a sticker) — you have 60 seconds.` });

    const collected = await channel.awaitMessages({
        filter: m => m.author.id === interaction.user.id,
        max: 1,
        time: 60_000,
        errors: ['time']
    }).catch(() => null);

    const staffMessage = collected?.first();
    if (!staffMessage) {
        await interaction.followUp({ content: 'Timed out waiting for your message — reply cancelled.' }).catch(() => null);
        return;
    }

    // Same limitation as incoming DM stickers — the bot can't necessarily re-send a sticker from
    // whatever server the staff member picked it from, so it's relayed as an image either way.
    const { mediaUrls: stickerMediaUrls, note: stickerNote } = buildStickerRelay(staffMessage.stickers);
    const text = [staffMessage.content, stickerNote].filter(Boolean).join('\n');

    const result = await replyToModmailThread(
        thread, interaction.client, channel, interaction.user.id, staffDisplayName,
        text, anonymous,
        staffMessage.attachments, stickerMediaUrls
    );

    // Deleted only now, after its attachments have actually been read/relayed — deleting it first (as
    // this used to) invalidates its attachment CDN links before buildRelayPayload ever references
    // them, which is exactly what caused a relayed image/video to show "Image failed to load".
    await staffMessage.delete().catch(() => null);

    // No separate follow-up on success — the relayed reply itself is already visible in the thread.
    if (!result.success) await interaction.followUp({ content: result.message }).catch(() => null);
}

/**
 * Log Link is meant to show the *entire* channel history, not just chat captured by the live
 * message-create listener going forward (that listener didn't exist for the life of an older thread, or
 * simply wasn't running at the time some message was sent — a bot restart, a deploy, etc.). This walks
 * the thread channel's full Discord message history once, backwards from now, and persists anything not
 * already in modmail_messages as 'staff-chat' — skipping the relay webhook's own visual copies (already
 * recorded separately as 'to-user'/'from-user') and other bot/system messages. Safe to re-run any time a
 * link is requested — already-recorded messages are skipped by their Discord message id.
 */
export async function backfillThreadChatHistory(thread: IRawModmailThread, channel: ThreadChannel): Promise<void> {
    const existing = await database.modmailMessages.fetchByThread(thread.id);
    const existingMessageIds = new Set(existing.map(m => m.relayMessageId).filter((id): id is string => !!id));

    let before: string | undefined;
    while (true) {
        const batch = await channel.messages.fetch({ limit: 100, before });
        if (batch.size === 0) break;

        for (const message of batch.values()) {
            if (message.webhookId) continue; // the relay webhook's own visual copy of a reply/DM — already persisted separately
            if (message.author.bot || message.system) continue;
            if (existingMessageIds.has(message.id)) continue;

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
            existingMessageIds.add(message.id);
        }

        before = batch.last()?.id;
        if (batch.size < 100) break;
    }
}

// Actions that only make sense while sitting inside the thread channel itself — snippet management is
// intentionally excluded, since staff shouldn't need to be mid-conversation just to add a canned reply.
const THREAD_SCOPED_ACTIONS = new Set([
    'reply', 'anonreply', 'edit', 'close', 'block', 'move', 'claim', 'unclaim', 'suspend', 'unsuspend', 'transcript', 'log-link', 'logs', 'add-staff', 'remove-staff', 'snippet-send'
]);

// Same reasoning as transcript below — these are read-only history lookups, so they must keep working
// on an already-closed (archived) thread too, not just an active one.
const READ_ONLY_ACTIONS = new Set(['transcript', 'log-link', 'logs']);

export async function mailAction(interaction: InGuildChatInputInteraction): Promise<void> {
    const action = interaction.options.getString('action', true);

    return ErrorHandler.wrap(interaction, 'mail-action', async () => {
        const guildId = interaction.guildId;

        const settings = await database.modmailSettings.fetch(guildId);
        if (!settings?.enabled) return void interaction.editReply({ content: 'Modmail is not enabled on this server.' });

        const member = interaction.member;
        // Broad "is this person staff of some kind, anywhere" gate — global staff roles or any
        // category's own team both pass here; which specific thread/category they can actually act on
        // isn't re-checked per action, matching how category-specific teams are meant to work (added to
        // their own category's threads, not locked out of the command entirely).
        const allStaffRoleIds = [...settings.staffRoleIds, ...settings.categories.flatMap(c => c.staffRoleIds)];
        if (!allStaffRoleIds.some(roleId => member.roles.cache.has(roleId))) {
            return void interaction.editReply({ content: "You don't have permission to use Modmail actions here." });
        }

        // ─── Snippet management — works anywhere in the guild, not thread-scoped ───
        if (action === 'snippet-add' || action === 'snippet-edit' || action === 'snippet-delete' || action === 'snippets-list' || action === 'snippet-view') {
            return void (await handleSnippetAction(interaction, guildId, action));
        }

        // ─── Open — run from the category's own parent channel, staff proactively opening a thread
        // with a user instead of waiting for them to reach out first ───
        if (action === 'open') {
            const categoryName = interaction.options.getString('category');
            const category = categoryName
                ? findMatchingCategory(settings.categories, categoryName)
                : settings.categories.find(c => c.parentChannelId === interaction.channelId);
            if (!category) {
                return void interaction.editReply({
                    content: categoryName
                        ? 'No matching category found.'
                        : "Provide `category`, or run this inside the category's own channel."
                });
            }

            const user = interaction.options.getUser('user');
            if (!user) return void interaction.editReply({ content: 'Provide `user`.' });

            const result = await createModmailThread(interaction.guild, user.id, category.key, null);
            if (!result.success) return void interaction.editReply({ content: `Couldn't open a thread with ${user}: ${result.message}` });

            const created = result.threadId ? await database.modmailThreads.fetch(result.threadId) : null;

            // `text` was being silently discarded here — Open has no interaction Message to hand
            // createModmailThread as a first message, so an opening message is sent as a normal staff
            // reply instead, same as running Open then Reply as two separate steps.
            const openingText = interaction.options.getString('text');
            if (created && openingText) {
                const threadChannel = await interaction.guild.channels.fetch(created.channelId).catch(() => null);
                if (threadChannel instanceof ThreadChannel) {
                    const staffDisplayName = member.displayName ?? interaction.user.username;
                    await replyToModmailThread(created, interaction.client, threadChannel, interaction.user.id, staffDisplayName, openingText, false);
                }
            }

            return void interaction.editReply({
                content: created
                    ? `✅ Opened a thread with ${user} in **${category.label}**${openingText ? ' and sent your message' : ''} — <#${created.channelId}>.`
                    : `✅ Opened a thread with ${user} in **${category.label}**.`
            });
        }

        // ─── Reopen — run from the category's own parent channel, not from inside a (closed, likely
        // archived) thread, since staff generally won't be sitting inside a thread they're reopening ───
        if (action === 'reopen') {
            const category = settings.categories.find(c => c.parentChannelId === interaction.channelId);
            if (!category) return void interaction.editReply({ content: "Run this inside the category's own channel (not inside a thread)." });

            const threadId = interaction.options.getString('thread');
            if (!threadId) return void interaction.editReply({ content: 'Provide `thread`.' });

            const closedThread = await database.modmailThreads.fetch(threadId);
            if (!closedThread || closedThread.categoryKey !== category.key) {
                return void interaction.editReply({ content: 'No matching closed thread found in this category.' });
            }

            const result = await reopenModmailThread(interaction.guild, closedThread, interaction.user.toString(), interaction.user.id);
            return void interaction.editReply({ content: result.message });
        }

        if (!THREAD_SCOPED_ACTIONS.has(action)) return void interaction.editReply({ content: 'Unknown action.' });

        const thread = await database.modmailThreads.fetchByChannelId(interaction.channelId);
        if (!thread) return void interaction.editReply({ content: 'This only works inside a Modmail thread channel.' });
        // Viewing a transcript or log link is a read-only history lookup, not an active-conversation
        // action — it should still work on an already-closed (archived) thread, unlike everything else here.
        if (thread.status !== 'open' && !READ_ONLY_ACTIONS.has(action)) return void interaction.editReply({ content: 'This is not an active Modmail thread.' });

        const channel = interaction.channel;
        if (!channel || !(channel instanceof ThreadChannel)) return void interaction.editReply({ content: 'This only works inside a Modmail thread channel.' });

        const staffDisplayName = member.displayName ?? interaction.user.username;

        if (action === 'snippet-send') {
            const trigger = interaction.options.getString('trigger');
            if (!trigger) return void interaction.editReply({ content: 'Provide `trigger`.' });
            const snippet = await database.modmailSnippets.fetch(guildId, trigger);
            if (!snippet) return void interaction.editReply({ content: 'No snippet with that trigger.' });

            const result = await replyToModmailThread(thread, interaction.client, channel, interaction.user.id, staffDisplayName, snippet.body, false);
            return void (await acknowledgeReplyResult(interaction, result));
        }

        if (action === 'reply' || action === 'anonreply') {
            const text = interaction.options.getString('text');

            // Leaving `text` blank is the signal to attach something — rather than juggling a fixed
            // number of attachment options, staff just sends a normal follow-up message (any text, any
            // number of attachments, a sticker) the same way they'd post in any channel.
            if (!text) {
                return void (await promptForAttachmentReply(interaction, thread, channel, staffDisplayName, action === 'anonreply'));
            }

            const result = await replyToModmailThread(thread, interaction.client, channel, interaction.user.id, staffDisplayName, text, action === 'anonreply');
            return void (await acknowledgeReplyResult(interaction, result));
        }

        if (action === 'edit') {
            const messageNumber = interaction.options.getInteger('message_number');
            const text = interaction.options.getString('text');
            if (messageNumber === null || !text) return void interaction.editReply({ content: 'Provide both `message_number` and `text`.' });

            const result = await editModmailReply(thread, interaction.client, channel, interaction.user.id, messageNumber, text);
            return void interaction.editReply({ content: result.message });
        }

        if (action === 'close') {
            const reason = interaction.options.getString('text') ?? 'No reason given.';
            // Replied before closing, not after — closeModmailThread deletes this same channel, and
            // this interaction's reply lives in it; editReply-ing afterward 404s (Unknown Message) every
            // single time since the channel (and its messages) is already gone by then.
            await interaction.editReply({ content: '✅ Thread closed.' });
            await closeModmailThread(interaction.guild, thread, channel, reason, interaction.user.toString());
            return;
        }

        if (action === 'block') {
            const reason = interaction.options.getString('text');
            await database.modmailBlocks.block(guildId, thread.userId, interaction.user.id, reason);
            // Same ordering fix as 'close' above — reply before the channel-deleting closeModmailThread call.
            await interaction.editReply({ content: `✅ Blocked <@${thread.userId}> from opening new Modmail threads here and closed this thread.` });
            await closeModmailThread(interaction.guild, thread, channel, 'Blocked from Modmail.', interaction.user.toString());
            return;
        }

        if (action === 'move') {
            const categoryName = interaction.options.getString('category');
            if (!categoryName) return void interaction.editReply({ content: 'Provide `category`.' });

            const target = findMatchingCategory(settings.categories, categoryName);
            if (!target) return void interaction.editReply({ content: 'No matching category found.' });
            if (target.key === thread.categoryKey) return void interaction.editReply({ content: 'Already in that category.' });

            const targetChannel = interaction.guild.channels.cache.get(target.parentChannelId);
            if (!targetChannel || !(targetChannel instanceof TextChannel)) return void interaction.editReply({ content: "That category's channel is no longer available." });

            const botPermissions = interaction.guild.members.me!.permissionsIn(targetChannel);
            if (!botPermissions.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.CreatePrivateThreads)) {
                return void interaction.editReply({ content: `${interaction.client.user?.username ?? 'This bot'} does not have permission to create threads in ${targetChannel}.` });
            }

            const newThread = await targetChannel.threads.create({ name: channel.name, type: ChannelType.PrivateThread });
            await newThread.send({ embeds: [modmailNoticeEmbed(`Moved to **${target.label}**.`)] });

            await database.modmailThreads.update(thread.id, { categoryKey: target.key, channelId: newThread.id });
            await channel.send({ embeds: [modmailNoticeEmbed(`Moved to **${target.label}** — see ${newThread}.`)] });
            await channel.setArchived(true).catch(() => null);

            return void interaction.editReply({ content: `✅ Moved to **${target.label}**.` });
        }

        if (action === 'claim') {
            if (thread.claimedBy) return void interaction.editReply({ content: `Already claimed by <@${thread.claimedBy}>.` });
            await database.modmailThreads.update(thread.id, { claimedBy: interaction.user.id });
            await channel.send({ embeds: [modmailNoticeEmbed(`📌 Claimed by ${interaction.user}.`)] });
            return void interaction.editReply({ content: '✅ Claimed.' });
        }

        if (action === 'unclaim') {
            await database.modmailThreads.update(thread.id, { claimedBy: null });
            await channel.send({ embeds: [modmailNoticeEmbed(`Unclaimed by ${interaction.user}.`)] });
            return void interaction.editReply({ content: '✅ Unclaimed.' });
        }

        if (action === 'suspend') {
            if (thread.suspended) return void interaction.editReply({ content: 'This thread is already suspended.' });
            await database.modmailThreads.update(thread.id, { suspended: true });
            // The user's next DM is now handled exactly like a closed thread's — offered a Reopen (which
            // clears suspended) or a chance to start fresh instead of silently going nowhere.
            await channel.send({ embeds: [modmailNoticeEmbed(`⏸️ Thread suspended by ${interaction.user} — the user will be offered to reopen or start a new thread if they message again, same as a closed thread.`)] });
            return void interaction.editReply({ content: '✅ Suspended.' });
        }

        if (action === 'unsuspend') {
            if (!thread.suspended) return void interaction.editReply({ content: 'This thread isn\'t suspended.' });
            await database.modmailThreads.update(thread.id, { suspended: false });
            await channel.send({ embeds: [modmailNoticeEmbed(`▶️ Thread unsuspended by ${interaction.user} — messages will relay normally again.`)] });
            return void interaction.editReply({ content: '✅ Unsuspended.' });
        }

        if (action === 'transcript') {
            const file = await buildTranscriptFile(thread);
            return void interaction.editReply({ content: 'Transcript:', files: [file] });
        }

        if (action === 'log-link') {
            await backfillThreadChatHistory(thread, channel);
            const logToken = await getOrCreateLogToken(thread);
            return void interaction.editReply({ content: `${dashboardEnv.DASHBOARD_URL}/logs/${logToken}` });
        }

        if (action === 'logs') {
            const allThreads = await database.modmailThreads.fetchAllForUserInGuild(thread.guildId, thread.userId);
            const lines = await Promise.all(allThreads.map(async t => {
                const category = settings.categories.find(c => c.key === t.categoryKey);
                const token = await getOrCreateLogToken(t);
                const current = t.id === thread.id ? ' — this thread' : '';
                return `#${t.threadNumber} — **${category?.label ?? t.categoryKey}** (${t.status}${current}) — ${dashboardEnv.DASHBOARD_URL}/logs/${token}`;
            }));
            return void interaction.editReply({ content: `<@${thread.userId}>'s Modmail history (${allThreads.length} thread${allThreads.length !== 1 ? 's' : ''}):\n${lines.join('\n')}` });
        }

        if (action === 'add-staff' || action === 'remove-staff') {
            const user = interaction.options.getUser('user');
            if (!user) return void interaction.editReply({ content: 'Provide `user`.' });
            if (action === 'add-staff') await channel.members.add(user.id);
            else await channel.members.remove(user.id);
            return void interaction.editReply({ content: `✅ ${action === 'add-staff' ? 'Added' : 'Removed'} ${user}.` });
        }
    });
}

export async function mailRoleCommand(interaction: InGuildChatInputInteraction): Promise<void> {
    return ErrorHandler.wrap(interaction, 'mail-role', async () => {
        const guildId = interaction.guildId;
        const settings = await database.modmailSettings.fetch(guildId);
        if (!settings?.enabled) return void interaction.editReply({ content: 'Modmail is not enabled on this server.' });

        const member = interaction.member;
        const allStaffRoleIds = [...settings.staffRoleIds, ...settings.categories.flatMap(c => c.staffRoleIds)];
        if (!allStaffRoleIds.some(roleId => member.roles.cache.has(roleId))) {
            return void interaction.editReply({ content: "You don't have permission to use Modmail actions here." });
        }

        const picked = interaction.options.getString('role', true);

        if (picked === DEFAULT_ROLE_CHOICE) {
            await database.modmailStaffDisplay.setRole(guildId, interaction.user.id, null);
            return void interaction.editReply({ content: '✅ Reset to default — your replies will show whichever configured staff role you hold (highest one, if you hold more than one).' });
        }

        if (!member.roles.cache.has(picked)) {
            return void interaction.editReply({ content: "You don't have that role." });
        }

        const role = interaction.guild.roles.cache.get(picked);
        await database.modmailStaffDisplay.setRole(guildId, interaction.user.id, picked);
        return void interaction.editReply({ content: `✅ Your replies will now show as **${role?.name ?? 'that role'}**.` });
    });
}

export async function mailRoleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        const choices: { name: string; value: string }[] = [{ name: 'Default', value: DEFAULT_ROLE_CHOICE }];

        const member = interaction.guild?.members.cache.get(interaction.user.id) ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
        if (member) {
            for (const role of member.roles.cache.values()) {
                if (role.id === interaction.guildId) continue; // skip @everyone
                choices.push({ name: role.name, value: role.id });
            }
        }

        const filtered = choices.filter(c => c.name.toLowerCase().includes(focusedValue)).slice(0, 25);
        await interaction.respond(filtered);
    } catch {
        await interaction.respond([]);
    }
}

/** Used by /mail's `category` option (move/open) — suggests this guild's configured category names. */
export async function mailCategoryAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        if (!interaction.guildId) return void (await interaction.respond([]));

        const settings = await database.modmailSettings.fetch(interaction.guildId);
        if (!settings) return void (await interaction.respond([]));

        const choices = settings.categories
            .filter(c => c.label.toLowerCase().includes(focusedValue))
            .slice(0, 25)
            .map(c => ({ name: c.label, value: c.label }));

        await interaction.respond(choices);
    } catch {
        await interaction.respond([]);
    }
}

/** Lists closed threads for the category matching the channel this command is run in — reopening only makes sense scoped to one category's own parent channel. */
export async function mailThreadAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
    try {
        const focusedValue = interaction.options.getFocused().toLowerCase();
        if (!interaction.guildId) return void (await interaction.respond([]));

        const settings = await database.modmailSettings.fetch(interaction.guildId);
        const category = settings?.categories.find(c => c.parentChannelId === interaction.channelId);
        if (!category) return void (await interaction.respond([]));

        const closedThreads = await database.modmailThreads.fetchClosedForCategory(interaction.guildId, category.key);

        const choices: { name: string; value: string }[] = [];
        for (const t of closedThreads.slice(0, 25)) {
            const user = await interaction.client.users.fetch(t.userId).catch(() => null);
            choices.push({ name: `#${t.threadNumber} — ${user?.username ?? t.userId}`, value: t.id });
        }

        const filtered = choices.filter(c => c.name.toLowerCase().includes(focusedValue)).slice(0, 25);
        await interaction.respond(filtered);
    } catch {
        await interaction.respond([]);
    }
}

async function handleSnippetAction(interaction: InGuildChatInputInteraction, guildId: string, action: string): Promise<void> {
    if (action === 'snippet-add' || action === 'snippet-edit') {
        const trigger = interaction.options.getString('trigger');
        const text = interaction.options.getString('text');
        if (!trigger || !text) return void interaction.editReply({ content: 'Provide both `trigger` and `text`.' });

        const existing = await database.modmailSnippets.fetch(guildId, trigger);
        if (action === 'snippet-add') {
            if (existing) return void interaction.editReply({ content: 'A snippet with that trigger already exists — use `Edit Snippet` instead.' });
            await database.modmailSnippets.create({ guildId, trigger, body: text, createdBy: interaction.user.id, createdAt: Date.now() });
            return void interaction.editReply({ content: `✅ Snippet **${trigger}** added.` });
        }
        if (!existing) return void interaction.editReply({ content: 'No snippet with that trigger.' });
        await database.modmailSnippets.update(guildId, trigger, text);
        return void interaction.editReply({ content: `✅ Snippet **${trigger}** updated.` });
    }

    if (action === 'snippet-delete') {
        const trigger = interaction.options.getString('trigger');
        if (!trigger) return void interaction.editReply({ content: 'Provide `trigger`.' });
        await database.modmailSnippets.delete(guildId, trigger);
        return void interaction.editReply({ content: `✅ Snippet **${trigger}** deleted.` });
    }

    if (action === 'snippet-view') {
        const trigger = interaction.options.getString('trigger');
        if (!trigger) return void interaction.editReply({ content: 'Provide `trigger`.' });
        const snippet = await database.modmailSnippets.fetch(guildId, trigger);
        if (!snippet) return void interaction.editReply({ content: 'No snippet with that trigger.' });
        return void interaction.editReply({ content: `**${snippet.trigger}**\n${snippet.body}` });
    }

    // Triggers only — full bodies are one action:snippet-view away, not worth cluttering a list with.
    const snippets = await database.modmailSnippets.fetchAll(guildId);
    if (snippets.length === 0) return void interaction.editReply({ content: 'No snippets configured.' });
    const lines = snippets.map(s => `**${s.trigger}**`);
    return void interaction.editReply({ content: lines.join('\n') });
}
