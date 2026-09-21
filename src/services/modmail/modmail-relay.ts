import { Message, ThreadChannel, Client, Guild, TextChannel, Webhook, PermissionFlagsBits, ChannelType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, Collection, Attachment, MessageFlags, TextDisplayBuilder, ComponentType, TopLevelComponent, EmbedBuilder } from "discord.js";
import { nanoid } from "nanoid";
import { randomUUID } from "crypto";
import { database } from "../../core/database.js";
import { IRawModmailThread, IRawModmailSettings } from "../../types/database.js";
import { handleRawDmIntake, resolveMutualEnabledGuilds, resolveEffectiveStaffRoleIds, buildThreadHeaderEmbed } from "./modmail-intake.js";
import { ErrorHandler } from "../../structures/error-handler.js";
import { buildStickerRelay, fetchNonMediaFiles, buildRelayPayload, getMediaAttachmentUrls, relayAttachmentsToLogChannel, modmailNoticeEmbed, getOrCreateRelayWebhook, convertHeicAttachments, fetchMediaForReupload } from "./modmail-relay-content.js";
import { dashboardEnv } from "../../config.js";

const disableModmail = (guildId: string) => database.modmailSettings.setEnabled(guildId, false);

export interface ResolvedThreadChannel { channel: ThreadChannel; recreated: boolean; }
export interface ResolveThreadChannelError { error: string; }

/**
 * Resolves a Modmail thread's stored channelId to a real Discord Thread — recreating it if the stored
 * id doesn't resolve to a usable Thread at all. That happens for any thread whose channel got deleted,
 * or (the common real case) one imported from a legacy bot whose per-conversation channels were plain
 * text channels, not Threads, so the id it migrated in with was never a Thread to begin with. Rather
 * than dead-ending, this spins up a genuine new Thread and re-points the thread record at it, so old
 * and new messages both stay under the one continuous transcript instead of the conversation just
 * dying. Shared by the explicit reopen flow and the incoming-DM relay, since a currently-"open" thread
 * can hit this exact same situation the moment a migrated user sends their next message.
 */
export async function resolveOrRecreateThreadChannel(guild: Guild, thread: IRawModmailThread, settings: IRawModmailSettings | null): Promise<ResolvedThreadChannel | ResolveThreadChannelError> {
    const existingChannel = await guild.channels.fetch(thread.channelId).catch(() => null);
    if (existingChannel instanceof ThreadChannel) {
        return { channel: existingChannel, recreated: false };
    }

    const category = settings?.categories.find(c => c.key === thread.categoryKey);
    const parentChannel = category ? guild.channels.cache.get(category.parentChannelId) : null;
    if (!parentChannel || !(parentChannel instanceof TextChannel)) {
        return { error: "That thread's original channel is gone, and its category's channel isn't available either." };
    }

    const botPermissions = guild.members.me?.permissionsIn(parentChannel);
    if (!botPermissions?.has(PermissionFlagsBits.CreatePrivateThreads)) {
        return { error: "Missing permission to create threads in that category's channel." };
    }

    const newChannel = await parentChannel.threads.create({
        name: `${thread.threadNumber}-${thread.username ?? thread.userId}`,
        type: ChannelType.PrivateThread
    });
    await database.modmailThreads.update(thread.id, { channelId: newChannel.id });

    return { channel: newChannel, recreated: true };
}

export interface PermissionGuardOptions {
    guild: Guild;
    module: string;
    moduleLabel: string;
    channelId: string | null;
    permission: string;
    disableModule: (guildId: string) => Promise<void>;
}

/**
 * Optional hooks for host-bot cross-module systems this file otherwise has no compile-time dependency
 * on — a permission-error-alert/auto-disable wrapper (tied to whatever moderation-log system the host
 * bot has, if any) and a "modmail just got (re-)enabled" callback (resets that same alert counter). Both
 * stay unset (safe, simpler fallbacks apply) for a Modmail-only deployment; a larger bot embedding this
 * module can register real implementations once at startup.
 */
export let permissionGuard: (<T>(options: PermissionGuardOptions, action: () => Promise<T>) => Promise<T | null>) | null = null;
export function setPermissionGuard(fn: typeof permissionGuard): void { permissionGuard = fn; }

export let onModmailEnabled: ((guildId: string) => Promise<void>) | null = null;
export function setOnModmailEnabled(fn: typeof onModmailEnabled): void { onModmailEnabled = fn; }

export interface ReopenResult { success: boolean; message: string; }

/** Same non-expiring token every time for a given thread — generates and persists one on first use for any thread that predates this field. Shared by /mail action:Log Link, Logs, and the auto-post-on-close transcript below. */
export async function getOrCreateLogToken(thread: IRawModmailThread): Promise<string> {
    if (thread.logToken) return thread.logToken;
    const logToken = randomUUID();
    await database.modmailThreads.update(thread.id, { logToken });
    return logToken;
}

/** Shared by /mail action:Transcript, the auto-post-on-close behavior, and anywhere else a thread's message history needs to become a downloadable file. */
export async function buildTranscriptFile(thread: IRawModmailThread): Promise<AttachmentBuilder> {
    const messages = await database.modmailMessages.fetchByThread(thread.id);
    const header = `Thread #${thread.threadNumber} — Opened by ${thread.username || 'Unknown'} (User ID: ${thread.userId})\n\n`;
    const lines = messages.map(m => {
        const line = `[${new Date(m.createdAt).toISOString()}] (${m.direction}) ${m.authorId}: ${m.body}`;
        const attachments = m.attachmentUrls.map(url => `    ${url}`).join('\n');
        return attachments ? `${line}\n${attachments}` : line;
    });
    const body = lines.join('\n') || '(no messages)';
    return new AttachmentBuilder(Buffer.from(header + body, 'utf-8'), { name: `modmail-thread-${thread.threadNumber}.txt` });
}

/** Shared by /mail action:Close and the auto-close that happens when staff blocks a user with an open thread. */
export async function closeModmailThread(guild: Guild, thread: IRawModmailThread, channel: ThreadChannel, reason: string, actorMention: string): Promise<void> {
    await database.modmailThreads.update(thread.id, { status: 'closed', closedAt: Date.now() });

    const user = await guild.client.users.fetch(thread.userId).catch(() => null);
    await user?.send({ embeds: [modmailNoticeEmbed(`Your Modmail thread has been closed.\nReason: ${reason}`)] }).catch(() => null);

    await channel.send({ embeds: [modmailNoticeEmbed(`🔒 Thread closed by ${actorMention}.\nReason: ${reason}\nThis channel is being deleted — the full history stays available via \`/mail action:Log Link\` or \`/mail action:Transcript\`.`)] }).catch(() => null);

    const settings = await database.modmailSettings.fetch(guild.id);
    const category = settings?.categories.find(c => c.key === thread.categoryKey);
    if (category?.transcriptChannelId) {
        const transcriptChannel = await guild.channels.fetch(category.transcriptChannelId).catch(() => null);
        if (transcriptChannel instanceof TextChannel) {
            const file = await buildTranscriptFile(thread);
            const logToken = await getOrCreateLogToken(thread);
            const transcriptContent = [
                `Transcript for **${category.label}** thread #${thread.threadNumber}`,
                `opened by: <@${thread.userId}>`,
                `closed by: ${actorMention}`,
                `Reason: ${reason}`,
                `loglink: ${dashboardEnv.DASHBOARD_URL}/logs/${logToken}`
            ].join('\n');
            await transcriptChannel.send({ content: transcriptContent, files: [file] }).catch(() => null);
        }
    }

    // Fully closing means the channel goes away, not just archives — resolveOrRecreateThreadChannel
    // already handles a closed thread's channelId no longer resolving to a usable Thread (it spins up a
    // fresh one on reopen), so deleting here is safe. Falls back to archive+lock only if delete fails
    // (e.g. a missing permission), so the thread doesn't end up in a half-closed state either way.
    const deleted = await channel.delete(reason).catch(() => null);
    if (!deleted) {
        await channel.setArchived(true).catch(() => null);
        await channel.setLocked(true).catch(() => null);
    }
}

/** Shared by both staff-initiated (/mail action:Reopen) and user-initiated (DM confirmation prompt) reopen flows. */
export async function reopenModmailThread(guild: Guild, thread: IRawModmailThread, actorMention: string, actorUserId: string): Promise<ReopenResult> {
    // A suspended thread is still technically 'open' (relay just paused) — that's exactly the case this
    // is meant to resume, so only a genuinely already-active thread is rejected here.
    if (thread.status === 'open' && !thread.suspended) return { success: false, message: 'That thread is already open.' };

    const settings = await database.modmailSettings.fetch(guild.id);
    const resolved = await resolveOrRecreateThreadChannel(guild, thread, settings);
    if ('error' in resolved) return { success: false, message: `${resolved.error} — can't reopen.` };

    const { channel: threadChannel, recreated } = resolved;
    if (!recreated) {
        await threadChannel.setLocked(false).catch(() => null);
        await threadChannel.setArchived(false).catch(() => null);
    }

    await database.modmailThreads.update(thread.id, { channelId: threadChannel.id, status: 'open', closedAt: null, suspended: false });

    const category = settings?.categories.find(c => c.key === thread.categoryKey);
    const categoryLabel = category?.label ?? thread.categoryKey;
    const effectiveStaffRoleIds = settings ? resolveEffectiveStaffRoleIds(settings, thread.categoryKey) : [];
    const pingContent = effectiveStaffRoleIds.map(id => `<@&${id}>`).join(' ');

    // Same profile info (account age, join date, roles, extra fields) a brand-new thread gets — staff
    // shouldn't have to dig through the transcript to remember who this is just because it's a reopen
    // rather than a first contact.
    const userGuildId = settings?.linkedGuildId ?? settings?.guildId ?? guild.id;
    const userGuild = guild.id === userGuildId ? guild : guild.client.guilds.cache.get(userGuildId);
    const member = userGuild ? (userGuild.members.cache.get(thread.userId) ?? await userGuild.members.fetch(thread.userId).catch(() => null)) : null;

    // The client sets allowedMentions: { parse: [] } globally, so without this override the role mention
    // above would render as plain text and never actually notify/highlight anyone. The ping (a raw
    // mention) has to stay in `content` — Discord embeds can't carry a live, notifying mention.
    if (member) {
        const title = recreated ? `Continuing Modmail Thread — ${categoryLabel}` : `Modmail Thread Reopened — ${categoryLabel}`;
        const allUserThreads = await database.modmailThreads.fetchAllForUserInGuild(guild.id, thread.userId);
        const previousThreadCount = allUserThreads.filter(t => t.id !== thread.id).length;
        const headerEmbed = await buildThreadHeaderEmbed(userGuild!, member, categoryLabel, title, previousThreadCount);
        const headerMessage = await threadChannel.send({ content: pingContent || undefined, embeds: [headerEmbed], allowedMentions: { roles: effectiveStaffRoleIds } }).catch(() => null);
        await headerMessage?.pin().catch(() => null);
    } else {
        // Member couldn't be resolved (e.g. they've since left the server) — fall back to a plain notice
        // rather than failing the whole reopen over a missing profile.
        const openingNote = recreated
            ? `↩️ Continuing thread #${thread.threadNumber} — its original channel wasn't a usable Discord thread (likely imported from a legacy bot), so a new channel was created for it. Full prior history is still available via the transcript viewer.`
            : `🔓 Thread reopened by ${actorMention}.`;
        await threadChannel.send({ content: pingContent || undefined, embeds: [modmailNoticeEmbed(openingNote)], allowedMentions: { roles: effectiveStaffRoleIds } }).catch(() => null);
    }
    if (recreated) {
        await threadChannel.send({ embeds: [modmailNoticeEmbed(`↩️ Its original channel wasn't a usable Discord thread (likely imported from a legacy bot), so a new channel was created for it. Full prior history is still available via the transcript viewer.`)] }).catch(() => null);
    }

    // A role ping alone doesn't make a private thread show up in anyone's channel list — only actual
    // thread members get that. Add everyone currently holding a staff role (global or this category's
    // own team) so the thread is immediately visible, same as a brand-new thread — no manual
    // add-staff-member step needed for people who already have category access.
    const staffMembers = guild.members.cache.filter(m => effectiveStaffRoleIds.some(roleId => m.roles.cache.has(roleId)));
    for (const staffMember of staffMembers.values()) {
        await threadChannel.members.add(staffMember.id).catch(() => null);
    }

    // Only DM the user when staff reopened it — if the user did this themselves via the DM button
    // prompt, they already got a direct confirmation there and a second DM would just be noise.
    if (actorUserId !== thread.userId) {
        const user = await guild.client.users.fetch(thread.userId).catch(() => null);
        await user?.send({ embeds: [modmailNoticeEmbed(`Your Modmail thread in **${guild.name}** has been reopened by staff — you can reply here again.`)] }).catch(() => null);
    }

    return { success: true, message: `✅ Reopened thread #${thread.threadNumber}.` };
}


/**
 * Resolves what a staff member's non-anonymous reply should show as their identity. Priority:
 * 1. An explicit /mail-role pick, if they still hold that role (picks can go stale if roles change).
 * 2. Otherwise the default: the highest-positioned configured staff role they currently hold.
 * 3. Falls back to their own display name if neither applies (e.g. their staff role was removed since).
 */
async function resolveStaffDisplayName(guild: Guild, staffUserId: string, fallbackDisplayName: string, categoryKey: string): Promise<string> {
    const settings = await database.modmailSettings.fetch(guild.id);
    const member = guild.members.cache.get(staffUserId) ?? await guild.members.fetch(staffUserId).catch(() => null);
    if (!settings || !member) return fallbackDisplayName;

    const pref = await database.modmailStaffDisplay.fetch(guild.id, staffUserId);
    if (pref?.roleId && member.roles.cache.has(pref.roleId)) {
        const pickedRole = guild.roles.cache.get(pref.roleId);
        if (pickedRole) return pickedRole.name;
    }

    const heldStaffRoles = resolveEffectiveStaffRoleIds(settings, categoryKey)
        .filter(roleId => member.roles.cache.has(roleId))
        .map(roleId => guild.roles.cache.get(roleId))
        .filter((role): role is NonNullable<typeof role> => !!role)
        .sort((a, b) => b.position - a.position);

    return heldStaffRoles[0]?.name ?? fallbackDisplayName;
}

/** One closed thread per (guild, category) — the newest one, since a user could have closed more than one thread in the same category over time but only the latest is worth offering to reopen. Guilds the user is blocked in are excluded entirely — they shouldn't even see a reopen option there. */
async function findReopenableClosedThreads(message: Message): Promise<IRawModmailThread[]> {
    const matches = await resolveMutualEnabledGuilds(message.client, message.author.id);
    if (matches.length === 0) return [];

    // resolveMutualEnabledGuilds resolves to the linked main server's guildId when one's configured
    // (correct for the membership check it does) — but threads are always stored under the mail
    // server's own guildId, which only happens to be the same value in solo (unlinked) mode. Re-resolve
    // each match back to its real mail-server guildId before using it to look up thread records.
    const settingsPerMatch = await Promise.all(matches.map(m => database.modmailSettings.fetchForActingGuild(m.guildId)));
    const guildIds = settingsPerMatch.filter((s): s is NonNullable<typeof s> => s !== null).map(s => s.guildId);
    const closedThreads = await database.modmailThreads.fetchClosedForUserInGuilds(message.author.id, guildIds);

    const seenCategories = new Set<string>();
    const latestPerCategory: IRawModmailThread[] = [];
    for (const t of closedThreads) { // already sorted newest-closed-first
        const key = `${t.guildId}:${t.categoryKey}`;
        if (seenCategories.has(key)) continue;
        if (await database.modmailBlocks.isBlocked(t.guildId, message.author.id)) continue;
        seenCategories.add(key);
        latestPerCategory.push(t);
    }
    return latestPerCategory;
}

/** Offers one "Reopen" button per category the user has a closed thread in, plus a "Start a new thread" catch-all — Discord caps a row at 5 buttons, so only the 4 most recent categories get an explicit button. */
async function promptReopenOrNew(message: Message, closedThreads: IRawModmailThread[]): Promise<void> {
    const offered = closedThreads.slice(0, 4);
    const labels = new Map<string, string>();

    for (const t of offered) {
        const guild = message.client.guilds.cache.get(t.guildId);
        const settings = guild ? await database.modmailSettings.fetch(guild.id) : null;
        const category = settings?.categories.find(c => c.key === t.categoryKey);
        labels.set(t.id, `Reopen ${category?.label ?? t.categoryKey} (#${t.threadNumber})`);
    }

    const buttons = offered.map(t =>
        new ButtonBuilder().setCustomId(`modmail-reopen-${t.id}`).setLabel(labels.get(t.id)!.slice(0, 80)).setStyle(ButtonStyle.Success)
    );
    buttons.push(new ButtonBuilder().setCustomId('modmail-reopen-new').setLabel('Start a new thread').setStyle(ButtonStyle.Secondary));
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const listText = offered.map(t => `• ${labels.get(t.id)}`).join('\n');
    const prompt = await message.reply({
        content: `You have previous closed Modmail thread(s):\n${listText}\n\nReopen one, or start a new thread?`,
        components: [row]
    }).catch(() => null);
    if (!prompt) {
        await handleRawDmIntake(message);
        return;
    }

    const clicked = await prompt.awaitMessageComponent({ filter: i => i.user.id === message.author.id, time: 60_000 }).catch(() => null);
    await prompt.edit({ components: [] }).catch(() => null);

    if (!clicked || clicked.customId === 'modmail-reopen-new') {
        await clicked?.update({ content: 'Starting a new thread...' }).catch(() => null);
        // Any suspended thread offered here is still technically 'open', which would otherwise block
        // creating a genuinely new one (one-open-thread-per-guild guard) — starting fresh means
        // abandoning it, so it's closed (not just left dangling) first.
        for (const t of offered) {
            if (!t.suspended) continue;
            const suspendedGuild = message.client.guilds.cache.get(t.guildId);
            if (!suspendedGuild) continue;
            const suspendedSettings = await database.modmailSettings.fetch(suspendedGuild.id);
            const resolvedChannel = await resolveOrRecreateThreadChannel(suspendedGuild, t, suspendedSettings);
            if ('error' in resolvedChannel) continue;
            await closeModmailThread(suspendedGuild, t, resolvedChannel.channel, 'Suspended thread abandoned — user started a new one instead.', message.author.toString());
        }
        await handleRawDmIntake(message);
        return;
    }

    const chosenThreadId = clicked.customId.replace('modmail-reopen-', '');
    const chosenThread = offered.find(t => t.id === chosenThreadId);
    const guild = chosenThread ? message.client.guilds.cache.get(chosenThread.guildId) : null;

    if (!chosenThread || !guild) {
        await clicked.update({ content: "That thread isn't available anymore — starting a new thread instead." }).catch(() => null);
        await handleRawDmIntake(message);
        return;
    }

    const result = await reopenModmailThread(guild, chosenThread, message.author.toString(), message.author.id);
    if (!result.success) {
        await clicked.update({ content: result.message }).catch(() => null);
        return;
    }

    await clicked.update({ content: `✅ Your thread in **${guild.name}** has been reopened — staff will reply here.` }).catch(() => null);
    await handleIncomingDm(message); // the thread is open again now, so this relays the triggering message normally
}

/**
 * Called from message-create.ts for every DM. If the user has no open thread anywhere, checks for a
 * reopenable closed one first (prompting to reopen instead of starting fresh); otherwise hands off to
 * intake (new thread). If they have exactly one open thread, relays into it. If they somehow have more
 * than one open at once (rare — one open thread per guild is the norm, but a user could have threads
 * open in two different guilds simultaneously), relays to the most recently created one rather than
 * guessing further or blocking the message entirely.
 */
export async function handleIncomingDm(message: Message): Promise<void> {
    const openThreads = await database.modmailThreads.fetchOpenForUser(message.author.id);
    const thread = openThreads.find(t => !t.suspended); // fetchOpenForUser is already sorted newest-first

    if (!thread) {
        // No genuinely active thread — either none at all, or the only "open" one(s) are suspended.
        // Suspended threads act exactly like closed ones here: offered as a Reopen candidate alongside
        // any real closed threads, rather than just silently reacting and going nowhere.
        const suspendedThreads = openThreads.filter(t => t.suspended);
        const closedThreads = await findReopenableClosedThreads(message);
        const reopenable = [...suspendedThreads, ...closedThreads];
        if (reopenable.length > 0) {
            await promptReopenOrNew(message, reopenable);
            return;
        }
        await handleRawDmIntake(message);
        return;
    }

    const guild = message.client.guilds.cache.get(thread.guildId);
    if (!guild) {
        await ErrorHandler.handle(new Error(`Modmail relay: guild ${thread.guildId} not in cache for thread ${thread.id}.`), { context: 'modmail-relay', emitAlert: true });
        return;
    }

    // Private threads aren't reliably kept in the guild channel cache (especially after a bot restart,
    // which clears it entirely), and a thread whose channelId was migrated in from a legacy bot may
    // never have been a real Discord Thread to begin with — resolveOrRecreateThreadChannel handles both
    // by fetching live and spinning up a replacement Thread if the stored id isn't usable, rather than
    // silently dead-ending the user's message with no response at all.
    const settings = await database.modmailSettings.fetch(thread.guildId);
    const resolved = await resolveOrRecreateThreadChannel(guild, thread, settings);
    if ('error' in resolved) {
        await ErrorHandler.handle(new Error(`Modmail relay: ${resolved.error} (thread ${thread.id}).`), { context: 'modmail-relay', emitAlert: true });
        return;
    }
    const { channel: threadChannel, recreated } = resolved;
    if (recreated) {
        await threadChannel.send({ embeds: [modmailNoticeEmbed(`↩️ Continuing thread #${thread.threadNumber} — its original channel wasn't a usable Discord thread (likely imported from a legacy bot), so a new channel was created for it. Full prior history is still available via the transcript viewer.`)] }).catch(() => null);
    }

    // The relay copy previously showed as a plain message from the bot with no indication of who
    // actually sent it — staff had no way to tell users apart without opening the DM themselves.
    const member = guild.members.cache.get(message.author.id) ?? await guild.members.fetch(message.author.id).catch(() => null);
    const displayName = member?.displayName ?? message.author.username;

    // A user's sticker almost never belongs to a guild the bot has access to (Discord blocks re-sending
    // stickers the bot doesn't own), so it's relayed as an image instead of a real sticker.
    const { mediaUrls: stickerMediaUrls, note: stickerNote } = buildStickerRelay(message.stickers);

    const attachmentUrls = [...message.attachments.values()].map(a => a.url);
    const mediaUrls = [...getMediaAttachmentUrls(message.attachments), ...stickerMediaUrls];
    const nonMediaFiles = await fetchNonMediaFiles(message.attachments);
    const convertedImages = await convertHeicAttachments(message.attachments);

    const settingsForLog = await database.modmailSettings.fetch(guild.id);
    const categoryForLog = settingsForLog?.categories.find(c => c.key === thread.categoryKey);
    await relayAttachmentsToLogChannel(guild, categoryForLog, thread.threadNumber, displayName, mediaUrls, nonMediaFiles, convertedImages);

    const text = [message.content, stickerNote].filter(Boolean).join('\n') || undefined;

    let relayed;
    try {
        // Every incoming message posts as the user themselves via a channel webhook (real username +
        // avatar as the actual message author, not repeated inside anything). Text-only messages are
        // wrapped in a plain colored embed (no author/footer on the embed itself — the webhook's own
        // identity already covers that) with nothing sent outside it; a bare link loses Discord's native
        // auto-preview as a result (only content, never an embed description, ever triggers that), which
        // is an accepted trade-off. Media/files stay on the existing Components V2 path (can't carry a
        // legacy embed at all) — webhook still used there for identity. Falls back to a plain bot message
        // with a bolded name prefix if the bot lacks Manage Webhooks or the webhook send otherwise fails,
        // so a permission gap degrades, not breaks.
        const hasMedia = mediaUrls.length > 0 || nonMediaFiles.length > 0 || convertedImages.length > 0;
        const parentChannel = threadChannel.parent;
        const webhook = parentChannel instanceof TextChannel ? await getOrCreateRelayWebhook(parentChannel) : null;
        if (webhook) {
            const payload = hasMedia
                ? buildRelayPayload(text, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages)
                : { embeds: text ? [modmailNoticeEmbed(text)] : [] };
            relayed = await webhook.send({ username: displayName, avatarURL: message.author.displayAvatarURL(), threadId: threadChannel.id, ...payload });
        } else {
            relayed = await threadChannel.send(buildRelayPayload(text ? `**${displayName}:** ${text}` : undefined, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages));
        }
    } catch (err) {
        await ErrorHandler.handle(err, { context: `modmail-relay send to thread ${thread.channelId}`, emitAlert: true });
        return;
    }

    // Confirms to the user, right on their own DM, that it actually made it into the thread —
    // otherwise there's no visible signal on their end that anything happened at all.
    await message.react('✅').catch(() => null);

    // A separate bot message (not folded into the webhook-impersonated relay above) pinging staff so a
    // follow-up reply doesn't just sit there relying on Discord's own channel notification settings —
    // previously only the very first thread-creation message ever pinged anyone. Optional per-server —
    // some servers found a fresh ping on every message in an active back-and-forth too noisy.
    if (settings?.pingOnUserReply) {
        const effectiveStaffRoleIds = resolveEffectiveStaffRoleIds(settings, thread.categoryKey);
        const pingContent = effectiveStaffRoleIds.map(id => `<@&${id}>`).join(' ');
        // The client sets allowedMentions: { parse: [] } globally, so without this override the role
        // mention above would render as plain text and never actually notify/highlight anyone.
        if (pingContent) await threadChannel.send({ content: pingContent, allowedMentions: { roles: effectiveStaffRoleIds } }).catch(() => null);
    }

    await database.modmailMessages.create({
        id: nanoid(12),
        modmailThreadId: thread.id,
        direction: 'from-user',
        authorId: message.author.id,
        body: message.content,
        dmMessageId: message.id,
        relayMessageId: relayed.id,
        attachmentUrls,
        createdAt: Date.now()
    });

    // Feeds the unanswered-thread reminder — clearing reminderSentAt here means a later message that's
    // still unanswered can trigger a fresh reminder, not just a single one-time ping ever.
    await database.modmailThreads.update(thread.id, { lastMessageDirection: 'from-user', lastMessageAt: Date.now(), reminderSentAt: null });
}

export interface ReplyResult { success: boolean; message: string; }

/** Thread -> DM. Used both by /mail's reply/anonreply slash-command actions (typed text only), and by
 * staff typing `/mail reply`/`/mail anonreply` as the start of a normal message in the thread channel —
 * text, attachments, and a sticker all come straight off that one Discord message (see message-create.ts). */
export async function replyToModmailThread(
    thread: IRawModmailThread,
    client: Client,
    channel: ThreadChannel,
    staffUserId: string,
    staffDisplayName: string,
    text: string,
    anonymous: boolean,
    attachments: Collection<string, Attachment> = new Collection(),
    stickerMediaUrls: string[] = []
): Promise<ReplyResult> {
    if (thread.suspended) return { success: false, message: 'This thread is suspended — unsuspend it first to reply.' };

    // The default reply shows just the staff role name, concealing which specific individual is
    // replying. "Real Reply" (the `anonreply` action/param name is legacy — the command choice is
    // labeled "Real Reply" now) is the inverse of that by design: it reveals full accountability
    // (personal name + role) for when staff explicitly want to be identified.
    const roleName = await resolveStaffDisplayName(channel.guild, staffUserId, staffDisplayName, thread.categoryKey);
    const displayName = anonymous
        ? (roleName !== staffDisplayName ? `${staffDisplayName} (${roleName})` : staffDisplayName)
        : roleName;
    const user = await client.users.fetch(thread.userId).catch(() => null);
    if (!user) return { success: false, message: "Couldn't find that user." };

    // Media here is downloaded and genuinely re-uploaded (fetchMediaForReupload), not referenced by URL
    // (unlike the incoming-DM relay below), giving each relayed copy its own independent, permanent file.
    const mediaUrls = [...stickerMediaUrls];
    // Fetched once and reused for both destinations below, rather than once per send — the file itself
    // doesn't change between the DM copy and the thread copy.
    const nonMediaFiles = await fetchNonMediaFiles(attachments);
    const convertedImages = [...await fetchMediaForReupload(attachments), ...await convertHeicAttachments(attachments)];

    const settingsForLog = await database.modmailSettings.fetch(channel.guild.id);
    const categoryForLog = settingsForLog?.categories.find(c => c.key === thread.categoryKey);
    await relayAttachmentsToLogChannel(channel.guild, categoryForLog, thread.threadNumber, displayName, mediaUrls, nonMediaFiles, convertedImages);

    // Always prefixed with the shown identity, even when there's no text (e.g. an image-only reply) —
    // previously this was only added when `text` was non-empty, so an attachment sent with no message
    // reached the user with no attribution at all.
    // Logged, not silently swallowed — a failure here (e.g. a Discord-side attachment/media-gallery
    // rejection, not just "DMs closed") previously left no trace anywhere to diagnose from.
    const dmSent = await user.send(buildRelayPayload(`**${displayName}:**${text ? ` ${text}` : ''}`, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages))
        .catch(err => { ErrorHandler.handle(err, { context: 'modmail-relay replyToModmailThread (dm send)', emitAlert: false }); return null; });
    if (!dmSent) {
        await channel.send({ embeds: [modmailNoticeEmbed("⚠️ Couldn't DM the user — they may have DMs closed or have blocked the bot.")] }).catch(() => null);
        return { success: false, message: "Couldn't DM the user." };
    }

    const attachmentUrls = [...dmSent.attachments.values()].map(a => a.url);

    // Numbered so staff can reference "edit #N" later via /mail action:edit — shown only on the thread
    // copy since it's a staff bookkeeping detail, not something the user on the other end needs to see.
    // The thread copy always shows the actual replying staff member's real name (staffDisplayName), never
    // the possibly-role-only `displayName` the user was sent — anonymity is something the USER sees, not
    // something that should hide who-sent-what from the rest of staff watching the same thread. Shown as
    // "Role (Name)" so staff immediately see both which role posted and who specifically it was; falls
    // back to just the name if there's no distinct role (resolveStaffDisplayName already defaults to the
    // personal name in that case, which would otherwise show as a redundant "Name (Name)").
    const messageNumber = (await database.modmailMessages.countStaffReplies(thread.id)) + 1;
    const threadFooter = `#${messageNumber}${anonymous ? '' : ' · shown to user as role only'}`;
    const staffThreadName = roleName !== staffDisplayName ? `${roleName} (${staffDisplayName})` : staffDisplayName;
    const sendThreadCopy = () => channel.send(buildRelayPayload(text || '*(attachment)*', mediaUrls, nonMediaFiles, { name: staffThreadName, footer: threadFooter }, undefined, convertedImages));
    const relayed = permissionGuard
        ? await permissionGuard(
            { guild: channel.guild, module: 'modmail', moduleLabel: 'Modmail', channelId: channel.id, permission: 'SendMessagesInThreads', disableModule: disableModmail },
            sendThreadCopy
        )
        : await sendThreadCopy().catch(() => null);
    // Confirms right on the thread copy that the DM actually reached the user — reaching this line
    // already means dmSent succeeded above, so this is a delivery confirmation, not a hopeful guess.
    await relayed?.react('✅').catch(() => null);

    await database.modmailMessages.create({
        id: nanoid(12),
        modmailThreadId: thread.id,
        direction: 'to-user',
        authorId: staffUserId,
        body: text,
        dmMessageId: dmSent.id,
        relayMessageId: relayed?.id ?? null,
        attachmentUrls,
        createdAt: Date.now(),
        messageNumber,
        displayName
    });

    // Feeds the unanswered-thread reminder — a staff reply always clears the pending state.
    await database.modmailThreads.update(thread.id, { lastMessageDirection: 'to-user', lastMessageAt: Date.now(), reminderSentAt: null });

    return { success: true, message: 'Reply sent.' };
}

/** Edits both the DM copy and the thread copy of a staff reply, keeping its original displayName prefix so the shown identity can't drift from what the user originally saw. Enforces that only the original sender may edit. */
export async function editModmailReply(
    thread: IRawModmailThread,
    client: Client,
    channel: ThreadChannel,
    staffUserId: string,
    messageNumber: number,
    newText: string
): Promise<ReplyResult> {
    const record = await database.modmailMessages.fetchByThreadAndNumber(thread.id, messageNumber);
    if (!record) return { success: false, message: `No message #${messageNumber} in this thread.` };
    if (record.authorId !== staffUserId) return { success: false, message: 'You can only edit messages you sent yourself.' };

    const name = record.displayName ?? 'Staff';

    // The original message may have had a MediaGallery/File component alongside its text (an attached
    // image or file) — replacing the full `components` array with just a new TextDisplay would silently
    // delete those. Only the TextDisplay (always the first component, if present at all — see
    // buildRelayPayload) gets swapped; anything else carries over untouched.
    const rebuildComponents = (existing: readonly TopLevelComponent[], newContent: string) => [
        new TextDisplayBuilder().setContent(newContent),
        ...existing.filter(c => c.type !== ComponentType.TextDisplay)
    ];

    // A text-only reply goes out as a single author-embed (see buildRelayPayload) — editing that has to
    // rebuild the embed's description in place, preserving its author/color/footer, rather than replacing
    // it with plain content (which would leave the stale old embed sitting there untouched alongside it).
    // The author line already carries the name/number, so the embed case gets the bare new text; the
    // other two cases need it baked into the string themselves, same as when the message was first sent.
    // A reply with media/files is Components V2 (handled first); anything else is a legacy plain message
    // from before either of those existed, which a plain content edit is still correct for.
    const buildEditPayload = (message: Message, plainNewContent: string) => {
        if (message.flags.has(MessageFlags.IsComponentsV2)) {
            return { content: '', embeds: [], flags: MessageFlags.IsComponentsV2 as const, components: rebuildComponents(message.components, plainNewContent) };
        }
        if (message.embeds.length > 0) {
            const embed = new EmbedBuilder(message.embeds[0].toJSON()).setDescription(newText);
            return { content: '', embeds: [embed] };
        }
        return { content: plainNewContent };
    };

    let dmEdited = false;
    if (record.dmMessageId) {
        const user = await client.users.fetch(thread.userId).catch(() => null);
        const dmChannel = await user?.createDM().catch(() => null);
        const dmMessage = await dmChannel?.messages.fetch(record.dmMessageId).catch(() => null);
        dmEdited = !!(dmMessage && await dmMessage.edit(buildEditPayload(dmMessage, `**${name}:** ${newText}`))
            .catch(err => { ErrorHandler.handle(err, { context: 'modmail-relay editModmailReply (dm)', emitAlert: false }); return null; }));
    }

    let relayEdited = false;
    if (record.relayMessageId) {
        const relayMessage = await channel.messages.fetch(record.relayMessageId).catch(() => null);
        relayEdited = !!(relayMessage && await relayMessage.edit(buildEditPayload(relayMessage, `**#${messageNumber} — ${name}:** ${newText}`))
            .catch(err => { ErrorHandler.handle(err, { context: 'modmail-relay editModmailReply (relay)', emitAlert: false }); return null; }));
    }

    await database.modmailMessages.updateBody(record.id, newText);

    if (!dmEdited && !relayEdited) return { success: false, message: "Couldn't edit either copy of that message — it may have been deleted." };
    if (!dmEdited) return { success: true, message: `Edited, but couldn't update the user's DM copy — they may have deleted it or closed their DMs.` };
    if (!relayEdited) return { success: true, message: "Edited, but couldn't update the thread copy — it may have been deleted." };
    return { success: true, message: `✅ Edited message #${messageNumber}.` };
}
