import { Client, EmbedBuilder, ChannelType, TextChannel, Message, Guild, GuildMember, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { IRawModmailSettings } from "../../types/database.js";
import { database } from "../../core/database.js";
import { ErrorHandler } from "../../structures/error-handler.js";
import { Colors } from "../../utils/util.js";
import { nanoid } from "nanoid";
import { randomUUID } from "crypto";
import { buildStickerRelay, buildRelayPayload, fetchNonMediaFiles, getMediaAttachmentUrls, relayAttachmentsToLogChannel, modmailNoticeEmbed, getOrCreateRelayWebhook, convertHeicAttachments } from "./modmail-relay-content.js";

export interface MutualEnabledGuild { guildId: string; guildName: string; }

const THREAD_RATE_LIMIT_MAX = 3;
const THREAD_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const BLOCKED_MESSAGE = 'Hello, due to your recent behaviour, you are hereby blocked from using modmail until further notice. Good day to you.';

/** Guild-wide staff roles apply to every category; a category can also have its own team (e.g. "Event Team") layered on top, not instead of, the global ones — used anywhere a ping/auto-add/permission check needs "who's staff for this specific thread." */
export function resolveEffectiveStaffRoleIds(settings: IRawModmailSettings, categoryKey: string): string[] {
    const category = settings.categories.find(c => c.key === categoryKey);
    return [...new Set([...settings.staffRoleIds, ...(category?.staffRoleIds ?? [])])];
}

/** Narrows the bot's mutual guilds with a user down to the ones that actually have Modmail enabled — used both for raw-DM intake and for /modmail's own bookkeeping. Checks membership against the guild the user is actually meant to be in — the linked main/community server if a dedicated mail server is configured, otherwise the solo guild — never the mail server itself, which the user may not have access to at all. */
export async function resolveMutualEnabledGuilds(client: Client, userId: string): Promise<MutualEnabledGuild[]> {
    const enabledSettings = await database.modmailSettings.fetchAllEnabled();
    const matches: MutualEnabledGuild[] = [];

    for (const settings of enabledSettings) {
        const userGuildId = settings.linkedGuildId ?? settings.guildId;
        const guild = client.guilds.cache.get(userGuildId);
        if (!guild) continue;
        const member = guild.members.cache.get(userId) ?? await guild.members.fetch(userId).catch(() => null);
        if (member) matches.push({ guildId: guild.id, guildName: guild.name });
    }

    return matches;
}

export interface ThreadHeaderExtraField { name: string; value: string; inline?: boolean; }

/**
 * Optional hook for bot-specific extra info on the new-thread header embed — e.g. a points/balance
 * system, warns/notes, or anything else that only makes sense where those other systems actually exist.
 * Left null (Discord-native info only: account age, join date, roles) for a Modmail-only deployment; a
 * larger bot embedding this module can set this once at startup so this module itself never has a
 * compile-time dependency on that bot's other systems.
 */
export let fetchExtraThreadInfoFields: ((guild: Guild, member: GuildMember) => Promise<ThreadHeaderExtraField[]>) | null = null;
export function setFetchExtraThreadInfoFields(fn: typeof fetchExtraThreadInfoFields): void {
    fetchExtraThreadInfoFields = fn;
}

/**
 * Optional hook for a host bot's own permission-alert/auto-disable system (e.g. tied to a moderation-log
 * feature) — recorded directly here (rather than via modmail-relay.ts's own permissionGuard hook, which
 * wraps an action instead) since this file can't import from modmail-relay.ts without a circular
 * dependency (modmail-relay.ts already imports from this file). Left unset for a Modmail-only
 * deployment; a larger bot embedding this module can register a real implementation once at startup.
 */
export let recordPermissionError: ((guild: Guild, module: string, moduleLabel: string, channelId: string | null, permission: string, disableModule: (guildId: string) => Promise<void>) => Promise<void>) | null = null;
export function setRecordPermissionError(fn: typeof recordPermissionError): void {
    recordPermissionError = fn;
}

/** Also used on reopen (see reopenModmailThread in modmail-relay.ts) so staff get the same profile
 * info regardless of whether a thread is brand new or picking back up — `title` defaults to the
 * new-thread wording, overridden there to something reopen-appropriate. `previousThreadCount` (any
 * OTHER thread this user has ever had in this guild, excluding whichever one this header is for) lets
 * staff immediately see whether this is a first-timer or a repeat visitor without leaving the thread —
 * pass it in as the caller already knows the guild/user; omit it and the field is simply left out. */
export async function buildThreadHeaderEmbed(guild: Guild, member: GuildMember, categoryLabel: string, title?: string, previousThreadCount?: number): Promise<EmbedBuilder> {
    const accountAgeDays = Math.floor((Date.now() - member.user.createdTimestamp) / (24 * 60 * 60 * 1000));
    const joinedDays = member.joinedTimestamp ? Math.floor((Date.now() - member.joinedTimestamp) / (24 * 60 * 60 * 1000)) : null;
    // Plain names, not real mentions — this embed can be posted in a *different* guild (the mail
    // server) than the one these roles belong to (the user's own main server), and role mentions only
    // resolve to a name within their own guild; cross-guild they'd all show as "@unknown-role".
    const roles = member.roles.cache.filter(r => r.id !== guild.id).map(r => `@${r.name}`).join(', ') || 'None';

    const extraFields = fetchExtraThreadInfoFields ? await fetchExtraThreadInfoFields(guild, member) : [];

    return new EmbedBuilder()
        .setColor(Colors.EmiliaPurple)
        .setTitle(title ?? `New Modmail Thread — ${categoryLabel}`)
        .setDescription(`${member} (${member.id})`)
        .addFields(
            { name: 'Account Age', value: `${accountAgeDays} day(s)`, inline: true },
            { name: 'Joined Server', value: joinedDays !== null ? `${joinedDays} day(s) ago` : 'Unknown', inline: true },
            ...(previousThreadCount !== undefined ? [{ name: 'Previous Threads', value: `${previousThreadCount} — see /mail action:Logs`, inline: true }] : []),
            { name: 'Roles', value: roles.length > 1024 ? roles.slice(0, 1021) + '...' : roles },
            ...extraFields
        );
}

export interface CreateThreadResult { success: boolean; message: string; threadId?: string; }

/**
 * Shared by both the ticket-panel button click and raw-DM intake. `actingGuild` is whichever guild the
 * request actually originated from (the linked main server if one's configured, otherwise the solo
 * guild) — settings, categories, and the actual thread channel might live in a *different* dedicated
 * mail server, resolved here via `fetchForActingGuild`.
 */
export async function createModmailThread(actingGuild: Guild, userId: string, categoryKey: string, firstMessage: Message | null): Promise<CreateThreadResult> {
    const settings = await database.modmailSettings.fetchForActingGuild(actingGuild.id);
    if (!settings?.enabled) return { success: false, message: 'Modmail is not enabled on that server.' };

    // Deliberately vague — the block reason is staff-only bookkeeping, never shared with the blocked user.
    // Reached via the ticket-panel button (in-guild) path; the raw-DM path checks earlier, before the
    // category picker, so this is really just the fallback for that other entry point.
    if (await database.modmailBlocks.isBlocked(settings.guildId, userId)) {
        return { success: false, message: BLOCKED_MESSAGE };
    }

    const existing = await database.modmailThreads.fetchOpenForUserInGuild(settings.guildId, userId);
    if (existing) return { success: false, message: 'You already have an open thread there.' };

    // Thread-spam protection — a reasonable default, not a precise spec; tune if it's too tight/loose.
    const recentCount = await database.modmailThreads.countCreatedSince(settings.guildId, userId, Date.now() - THREAD_RATE_LIMIT_WINDOW_MS);
    if (recentCount >= THREAD_RATE_LIMIT_MAX) {
        return { success: false, message: "You've opened too many Modmail threads recently — please wait a bit before opening another." };
    }

    const category = settings.categories.find(c => c.key === categoryKey);
    if (!category) return { success: false, message: 'That category no longer exists.' };

    // The user must be a member of the guild they actually belong to — the linked main/community
    // server if one's configured, never the dedicated mail server, which they may not have access to.
    const userGuildId = settings.linkedGuildId ?? settings.guildId;
    const userGuild = actingGuild.id === userGuildId ? actingGuild : actingGuild.client.guilds.cache.get(userGuildId);
    if (!userGuild) return { success: false, message: 'Something went wrong resolving that server.' };
    const member = userGuild.members.cache.get(userId) ?? await userGuild.members.fetch(userId).catch(() => null);
    if (!member) return { success: false, message: "You aren't a member of that server." };

    // Categories/threads always live in the mail guild, which may differ from the guild this request
    // originated from (e.g. a panel click happening in the linked main server).
    const mailGuild = actingGuild.id === settings.guildId ? actingGuild : actingGuild.client.guilds.cache.get(settings.guildId);
    if (!mailGuild) return { success: false, message: 'Something went wrong resolving the mail server.' };

    const parentChannel = mailGuild.channels.cache.get(category.parentChannelId);
    if (!parentChannel || !(parentChannel instanceof TextChannel)) {
        return { success: false, message: 'That category\'s channel is no longer available.' };
    }

    const disableModmail = (guildId: string) => database.modmailSettings.setEnabled(guildId, false);
    const botPermissions = mailGuild.members.me?.permissionsIn(parentChannel);
    if (!botPermissions?.has(PermissionFlagsBits.ViewChannel)) {
        if (recordPermissionError) await recordPermissionError(mailGuild, 'modmail', 'Modmail', parentChannel.id, 'ViewChannel', disableModmail);
        return { success: false, message: `${mailGuild.client.user?.username ?? 'This bot'} does not have permission to view that category's channel — ask a staff member to fix this.` };
    }
    if (!botPermissions.has(PermissionFlagsBits.CreatePrivateThreads)) {
        if (recordPermissionError) await recordPermissionError(mailGuild, 'modmail', 'Modmail', parentChannel.id, 'CreatePrivateThreads', disableModmail);
        return { success: false, message: `${mailGuild.client.user?.username ?? 'This bot'} does not have permission to create threads in that category's channel — ask a staff member to fix this.` };
    }

    // Everything past this point touches the Discord API repeatedly (thread creation, member add,
    // messages) — wrapped so a permission edge case we didn't anticipate returns a clean failure
    // instead of an unhandled rejection (this used to have no guard at all).
    try {
        const threadNumber = (await database.modmailThreads.getHighestThreadNumber(settings.guildId)) + 1;
        // The user is never added to the thread — it's staff-only. Their entire experience is the DM
        // relay; adding them as a real thread member would let them read staff's internal discussion
        // directly in Discord regardless of what the bot chooses to relay.
        const thread = await parentChannel.threads.create({
            name: `${threadNumber}-${member.user.username}`,
            type: ChannelType.PrivateThread
        });

        const threadId = nanoid(12);
        const now = Date.now();
        await database.modmailThreads.create({
            id: threadId,
            guildId: settings.guildId,
            userId,
            channelId: thread.id,
            categoryKey,
            threadNumber,
            status: 'open',
            claimedBy: null,
            createdAt: now,
            closedAt: null,
            lastMessageDirection: 'from-user',
            lastMessageAt: now,
            reminderSentAt: null,
            logToken: randomUUID()
        });

        const effectiveStaffRoleIds = resolveEffectiveStaffRoleIds(settings, categoryKey);

        // Counted before this thread's own record above would've been included — every OTHER thread this
        // user has ever had here.
        const previousThreadCount = (await database.modmailThreads.fetchAllForUserInGuild(settings.guildId, userId)).length - 1;
        const headerEmbed = await buildThreadHeaderEmbed(userGuild, member, category.label, undefined, previousThreadCount);
        const pingContent = effectiveStaffRoleIds.map(id => `<@&${id}>`).join(' ');
        // The client sets allowedMentions: { parse: [] } globally, so without this override the role
        // mention above would render as plain text and never actually notify/highlight anyone.
        const headerMessage = await thread.send({ content: pingContent || undefined, embeds: [headerEmbed], allowedMentions: { roles: effectiveStaffRoleIds } });
        // Pinned so it stays visible/accessible at the top of the thread as the conversation grows,
        // instead of scrolling out of view — just the info embed itself, not every message after it.
        await headerMessage.pin().catch(() => null);

        // The raw ID as its own plain message (not just baked into the profile embed above) so it can
        // actually be selected and copied on mobile — long-pressing text inside an embed field doesn't
        // reliably let you grab just the ID the way a bare message does.
        const idMessage = await thread.send({ content: userId }).catch(() => null);
        await idMessage?.pin().catch(() => null);

        // A role ping alone doesn't make a private thread show up in anyone's channel list — only
        // actual thread members get that. Add everyone currently holding a staff role (global or this
        // category's own team) so the thread is immediately visible, instead of staff having to browse
        // the parent channel's thread list.
        const staffMembers = mailGuild.members.cache.filter(m => effectiveStaffRoleIds.some(roleId => m.roles.cache.has(roleId)));
        for (const staffMember of staffMembers.values()) {
            await thread.members.add(staffMember.id).catch(() => null);
        }

        if (firstMessage) {
            // Same relay logic as every other DM<->thread message (see modmail-relay-content.ts) — this
            // used to only relay `firstMessage.content`, silently dropping the very first message's
            // attachments/stickers entirely if it opened the thread with an image and no caption.
            const { mediaUrls: stickerMediaUrls, note: stickerNote } = buildStickerRelay(firstMessage.stickers);
            const mediaUrls = [...getMediaAttachmentUrls(firstMessage.attachments), ...stickerMediaUrls];
            const nonMediaFiles = await fetchNonMediaFiles(firstMessage.attachments);
            const convertedImages = await convertHeicAttachments(firstMessage.attachments);
            await relayAttachmentsToLogChannel(mailGuild, category, threadNumber, member.displayName ?? member.user.username, mediaUrls, nonMediaFiles, convertedImages);
            const text = [firstMessage.content, stickerNote].filter(Boolean).join('\n') || undefined;
            const displayName = member.displayName ?? member.user.username;
            const hasMedia = mediaUrls.length > 0 || nonMediaFiles.length > 0 || convertedImages.length > 0;

            if (text || hasMedia) {
                // Posts as the user themselves via a channel webhook (real username + avatar, not
                // repeated inside anything) — same as every other incoming message. Text-only wraps in a
                // plain colored embed with nothing sent outside it (a bare link loses Discord's native
                // auto-preview as a result — only content, never an embed description, triggers that).
                // Falls back to a plain bot message with a bolded name prefix if the bot lacks Manage
                // Webhooks or the webhook send otherwise fails.
                const webhook = await getOrCreateRelayWebhook(parentChannel);
                const payload = hasMedia
                    ? buildRelayPayload(text, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages)
                    : { embeds: text ? [modmailNoticeEmbed(text)] : [] };
                const relayed = webhook
                    ? await webhook.send({ username: displayName, avatarURL: member.displayAvatarURL(), threadId: thread.id, ...payload })
                    : await thread.send(buildRelayPayload(text ? `**${displayName}:** ${text}` : undefined, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages));
                await database.modmailMessages.create({
                    id: nanoid(12),
                    modmailThreadId: threadId,
                    direction: 'from-user',
                    authorId: userId,
                    body: firstMessage.content,
                    dmMessageId: firstMessage.id,
                    relayMessageId: relayed.id,
                    attachmentUrls: [...firstMessage.attachments.values()].map(a => a.url),
                    createdAt: Date.now()
                });
            }

            // Confirms to the user, right on their own DM, that it actually opened the thread — matches
            // the same confirmation every later message into this thread already gets (see handleIncomingDm).
            await firstMessage.react('✅').catch(() => null);
        }

        return { success: true, message: 'Thread created.', threadId };
    } catch (err) {
        ErrorHandler.handle(err, { context: `modmail-intake - createModmailThread (mail guild ${settings.guildId})`, emitAlert: true });
        return { success: false, message: 'Something went wrong creating that thread — please try again.' };
    }
}

const DM_CATEGORY_BUTTON_PREFIX = 'modmail-dm-category_';

/** Same category buttons as the guild-posted panel, shown directly in DMs — a raw DM no longer silently defaults into one category, the user picks same as they would clicking the main-server panel. */
async function promptCategoryPicker(guild: Guild, settings: IRawModmailSettings, message: Message): Promise<void> {
    const buttons = settings.categories.slice(0, 25).map(c =>
        new ButtonBuilder().setCustomId(`${DM_CATEGORY_BUTTON_PREFIX}${c.key}`).setLabel(c.label).setStyle(ButtonStyle.Primary)
    );
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
    }

    const prompt = await message.reply({ embeds: [modmailNoticeEmbed(`What do you need help with in **${guild.name}**? Pick one below.`)], components: rows }).catch(() => null);
    if (!prompt) return;

    const clicked = await prompt.awaitMessageComponent({ filter: i => i.user.id === message.author.id, time: 120_000 }).catch(() => null);
    await prompt.edit({ components: [] }).catch(() => null);

    if (!clicked) {
        await message.reply({ embeds: [modmailNoticeEmbed('Timed out — DM me again if you still need help.')] }).catch(() => null);
        return;
    }

    const categoryKey = clicked.customId.slice(DM_CATEGORY_BUTTON_PREFIX.length);
    const categoryLabel = settings.categories.find(c => c.key === categoryKey)?.label ?? categoryKey;

    // A confirm step before actually opening anything — easy to fat-finger the wrong category button,
    // or change your mind entirely, and there was previously no way back once one was clicked.
    const confirmRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('modmail-open-confirm').setLabel('Confirm').setStyle(ButtonStyle.Success).setEmoji('✅'),
        new ButtonBuilder().setCustomId('modmail-open-cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    );
    await clicked.update({ embeds: [modmailNoticeEmbed(`Open a ticket for **${categoryLabel}** in **${guild.name}**?`)], components: [confirmRow] }).catch(() => null);

    const confirmed = await prompt.awaitMessageComponent({ filter: i => i.user.id === message.author.id, time: 60_000 }).catch(() => null);
    await prompt.edit({ components: [] }).catch(() => null);

    if (!confirmed || confirmed.customId === 'modmail-open-cancel') {
        if (confirmed) await confirmed.update({ embeds: [modmailNoticeEmbed('Cancelled — DM me again if you change your mind.')], components: [] }).catch(() => null);
        else await message.reply({ embeds: [modmailNoticeEmbed('Timed out — DM me again if you still need help.')] }).catch(() => null);
        return;
    }

    await confirmed.update({ embeds: [modmailNoticeEmbed(`Opening a thread for **${categoryLabel}**...`)], components: [] }).catch(() => null);

    const result = await createModmailThread(guild, message.author.id, categoryKey, message);
    await confirmed.followUp({
        embeds: [modmailNoticeEmbed(
            result.success ? `✅ Your Modmail thread in **${guild.name}** has been created — staff will reply here.` : result.message
        )]
    }).catch(() => null);
}

/** Raw-DM entry point — called from message-create.ts when a DM has no existing open thread anywhere. */
export async function handleRawDmIntake(message: Message): Promise<void> {
    const matches = await resolveMutualEnabledGuilds(message.client, message.author.id);

    if (matches.length === 0) {
        await message.reply({ content: "I couldn't find a server we're both in that has Modmail set up." }).catch(() => null);
        return;
    }

    if (matches.length > 1) {
        const names = matches.map(m => `**${m.guildName}**`).join(', ');
        await message.reply({ content: `You're in more than one server with Modmail set up (${names}) — please use that server's ticket panel instead so I know which one you mean.` }).catch(() => null);
        return;
    }

    const guild = message.client.guilds.cache.get(matches[0].guildId);
    if (!guild) return;

    const settings = await database.modmailSettings.fetchForActingGuild(guild.id);
    if (!settings || settings.categories.length === 0) {
        await message.reply({ content: "That server's Modmail isn't fully configured yet (no categories) — try again later." }).catch(() => null);
        return;
    }

    // Checked before the category picker (rather than only at the very end, in createModmailThread) so
    // a blocked user gets one immediate, clear answer instead of picking a category and confirming first.
    if (await database.modmailBlocks.isBlocked(settings.guildId, message.author.id)) {
        await message.reply({ content: BLOCKED_MESSAGE }).catch(() => null);
        return;
    }

    await promptCategoryPicker(guild, settings, message);
}
