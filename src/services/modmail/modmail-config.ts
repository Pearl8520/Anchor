import { EmbedBuilder, TextChannel, CategoryChannel, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { InGuildChatInputInteraction } from "../../types/discord.js";
import { database } from "../../core/database.js";
import { Colors } from "../../utils/util.js";
import { ErrorHandler } from "../../structures/error-handler.js";
import { IModmailCategory } from "../../types/database.js";
import { postModmailPanel } from "./modmail-panel.js";
import { closeModmailThread, onModmailEnabled } from "./modmail-relay.js";

/** Used in "no category found" errors so the user can immediately see the exact names to use, instead of guessing or re-running /modmail. */
function listCategoryNames(categories: IModmailCategory[]): string {
    return categories.length > 0
        ? categories.map(c => `**${c.label}**`).join(', ')
        : '*(none configured yet — add one first with `/modmail action:Add Category`)*';
}

export function slugify(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Matches a user-typed category name against either its display label or its slugified key — used by /modmail-thread's move action and /modmail's category management. */
export function findMatchingCategory(categories: IModmailCategory[], name: string): IModmailCategory | undefined {
    const normalized = name.toLowerCase().trim();
    return categories.find(c => c.label.toLowerCase() === normalized || c.key === normalized || c.key === slugify(name));
}

export async function modmailConfig(interaction: InGuildChatInputInteraction): Promise<void> {
    return ErrorHandler.wrap(interaction, 'modmail-config', async () => {
        const action = interaction.options.getString('action');
        const guildId = interaction.guildId;

        if (!action) {
            // `hours` only does anything paired with action:Set Reminder Threshold — providing it alone
            // silently fell through to the plain info view below with no indication anything was wrong.
            if (interaction.options.getInteger('hours') !== null) {
                return void interaction.editReply({ content: "`hours` only takes effect with `action:Set Reminder Threshold` — add that too and run it again." });
            }

            const settings = await database.modmailSettings.fetchForActingGuild(guildId);
            if (!settings) return void interaction.editReply({ content: 'Modmail has not been set up on this server yet.' });

            const categoryLines = settings.categories.length > 0
                ? settings.categories.map(c => `**${c.label}** (\`${c.key}\`) → <#${c.parentChannelId}>${c.transcriptChannelId ? ` — transcripts to <#${c.transcriptChannelId}>` : ''}${c.staffRoleIds.length ? ` — team: ${c.staffRoleIds.map(id => `<@&${id}>`).join(', ')}` : ''}`).join('\n')
                : '*(none configured)*';

            const embed = new EmbedBuilder()
                .setColor(Colors.EmiliaPurple)
                .setTitle('Modmail Configuration')
                .addFields(
                    { name: 'Enabled', value: settings.enabled ? 'Yes' : 'No', inline: true },
                    { name: 'Linked Main Server', value: settings.linkedGuildId ? `\`${settings.linkedGuildId}\`` : '*(none — solo mode)*', inline: true },
                    { name: 'Staff Role(s)', value: settings.staffRoleIds.length > 0 ? settings.staffRoleIds.map(id => `<@&${id}>`).join(', ') : '*(none set)*' },
                    { name: 'Reply Ping', value: settings.pingOnUserReply ? 'Yes — staff pinged on every user follow-up' : 'No — only pinged when a thread first opens', inline: true },
                    { name: 'Unanswered Reminders', value: settings.reminderEnabled ? `Yes — after ${settings.reminderThresholdHours ?? 24}h unanswered` : 'No', inline: true },
                    { name: 'Categories', value: categoryLines }
                );
            return void interaction.editReply({ embeds: [embed] });
        }

        if (action === 'add-category') {
            const name = interaction.options.getString('name');
            const rawChannel = interaction.options.getChannel('channel');
            if (!name || !rawChannel) return void interaction.editReply({ content: 'Provide both `name` (what to call this new category, e.g. "Support") and `channel` (a text channel, or a category folder to create one in — its threads will spawn there).' });

            let channel: TextChannel;
            if (rawChannel instanceof TextChannel) {
                channel = rawChannel;
            } else if (rawChannel instanceof CategoryChannel) {
                // The category folder itself can't host threads — create one real text channel inside it
                // to actually hold them, so "point this at my Inbox folder" works without also renaming
                // or hand-creating a channel first. The display name stays independent either way (below).
                channel = await interaction.guild.channels.create({
                    name: slugify(name),
                    type: ChannelType.GuildText,
                    parent: rawChannel.id
                });
            } else {
                return void interaction.editReply({ content: 'Channel must be a text channel or a category folder.' });
            }

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (settings.categories.some(c => c.key === key)) return void interaction.editReply({ content: `A category named **${name}** already exists.` });

            await database.modmailSettings.addCategory(guildId, { key, label: name, parentChannelId: channel.id });

            const canSetPermissions = channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles);
            if (canSetPermissions) {
                const staffRoleIds = settings.staffRoleIds;
                for (const roleId of staffRoleIds) {
                    await channel.permissionOverwrites.edit(roleId, { ViewChannel: true, ManageThreads: true }).catch(() => null);
                }
            }

            return void interaction.editReply({
                content: canSetPermissions
                    ? `✅ Added category **${name}** → ${channel}.`
                    : `✅ Added category **${name}** → ${channel}, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles there — staff won't automatically see it until you grant that permission and re-run this, or set channel permissions manually.`
            });
        }

        if (action === 'rename-category') {
            const name = interaction.options.getString('name');
            const newName = interaction.options.getString('new_name');
            if (!name || !newName) return void interaction.editReply({ content: 'Provide both `name` (the category to rename) and `new_name` (its new display name).' });

            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            const target = findMatchingCategory(settings.categories, name);
            if (!target) return void interaction.editReply({ content: `No category found matching **${name}**. Existing categories: ${listCategoryNames(settings.categories)}` });

            await database.modmailSettings.setCategoryLabel(guildId, target.key, newName);
            return void interaction.editReply({ content: `✅ Renamed **${target.label}** to **${newName}** — its internal key (\`${target.key}\`) is unchanged, so existing threads and transcripts stay intact.` });
        }

        if (action === 'remove-category') {
            const name = interaction.options.getString('name');
            if (!name) return void interaction.editReply({ content: 'Provide `name` — the category to remove.' });

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (!settings.categories.some(c => c.key === key)) {
                return void interaction.editReply({ content: `No category named "${name}" exists. Current categories: ${listCategoryNames(settings.categories)}` });
            }

            await database.modmailSettings.removeCategory(guildId, key);
            return void interaction.editReply({ content: `✅ Removed category **${name}**.` });
        }

        if (action === 'set-staff-role') {
            const role = interaction.options.getRole('role');
            if (!role) return void interaction.editReply({ content: 'Provide `role`.' });
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            const staffRoleIds = [...new Set([...settings.staffRoleIds, role.id])];
            await database.modmailSettings.setStaffRoles(guildId, staffRoleIds);

            const failedCategories: string[] = [];
            for (const category of settings.categories) {
                const channel = interaction.guild.channels.cache.get(category.parentChannelId);
                if (!(channel instanceof TextChannel)) continue;
                if (!channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles)) {
                    failedCategories.push(category.label);
                    continue;
                }
                await channel.permissionOverwrites.edit(role.id, { ViewChannel: true, ManageThreads: true }).catch(() => null);
            }

            return void interaction.editReply({
                content: failedCategories.length
                    ? `✅ ${role} can now manage Modmail threads, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles in: ${failedCategories.join(', ')} — set permissions there manually.`
                    : `✅ ${role} can now manage Modmail threads.`
            });
        }

        if (action === 'remove-staff-role') {
            const role = interaction.options.getRole('role');
            if (!role) return void interaction.editReply({ content: 'Provide `role`.' });

            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (!settings.staffRoleIds.includes(role.id)) {
                return void interaction.editReply({ content: `${role} isn't currently a guild-wide staff role.` });
            }

            await database.modmailSettings.setStaffRoles(guildId, settings.staffRoleIds.filter(id => id !== role.id));
            return void interaction.editReply({ content: `✅ Removed ${role} from the guild-wide staff role(s).` });
        }

        if (action === 'enable-reply-ping') {
            await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setPingOnUserReply(guildId, true);
            return void interaction.editReply({ content: '✅ Staff will now be pinged in-thread on every user follow-up message, not just when a thread first opens.' });
        }

        if (action === 'disable-reply-ping') {
            await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setPingOnUserReply(guildId, false);
            return void interaction.editReply({ content: '✅ Staff will no longer be pinged on follow-up messages — only when a thread first opens.' });
        }

        if (action === 'enable-reminders') {
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setReminderEnabled(guildId, true);
            return void interaction.editReply({ content: `✅ Staff will now be reminded about threads left unanswered for ${settings.reminderThresholdHours ?? 24}+ hour(s). Change that with \`set-reminder-threshold\`.` });
        }

        if (action === 'disable-reminders') {
            await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setReminderEnabled(guildId, false);
            return void interaction.editReply({ content: '✅ Unanswered-thread reminders turned off.' });
        }

        if (action === 'set-reminder-threshold') {
            const hours = interaction.options.getInteger('hours');
            if (!hours || hours < 1) return void interaction.editReply({ content: 'Provide `hours` (at least 1).' });
            await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setReminderThresholdHours(guildId, hours);
            return void interaction.editReply({ content: `✅ Reminder threshold set to ${hours} hour(s).` });
        }

        if (action === 'set-category-staff-role') {
            const name = interaction.options.getString('name');
            const role = interaction.options.getRole('role');
            if (!name || !role) return void interaction.editReply({ content: 'Provide both `name` (an existing category — not the role\'s name) and `role`.' });

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            const category = settings.categories.find(c => c.key === key);
            if (!category) return void interaction.editReply({ content: `No category named "${name}" exists. Current categories: ${listCategoryNames(settings.categories)}` });

            const staffRoleIds = [...new Set([...category.staffRoleIds, role.id])];
            await database.modmailSettings.setCategoryStaffRoles(guildId, key, staffRoleIds);

            let permissionsFailed = false;
            const channel = interaction.guild.channels.cache.get(category.parentChannelId);
            if (channel instanceof TextChannel) {
                if (channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles)) {
                    await channel.permissionOverwrites.edit(role.id, { ViewChannel: true, ManageThreads: true }).catch(() => null);
                } else {
                    permissionsFailed = true;
                }
            }

            return void interaction.editReply({
                content: permissionsFailed
                    ? `✅ ${role} added to **${name}**'s team, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles in ${channel} — set permissions there manually.`
                    : `✅ ${role} added to **${name}**'s team — they'll be added to new threads in this category alongside the guild-wide staff role(s).`
            });
        }

        if (action === 'remove-category-staff-role') {
            const name = interaction.options.getString('name');
            const role = interaction.options.getRole('role');
            if (!name || !role) return void interaction.editReply({ content: 'Provide both `name` (an existing category — not the role\'s name) and `role`.' });

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            const category = settings.categories.find(c => c.key === key);
            if (!category) return void interaction.editReply({ content: `No category named "${name}" exists. Current categories: ${listCategoryNames(settings.categories)}` });

            await database.modmailSettings.setCategoryStaffRoles(guildId, key, category.staffRoleIds.filter(id => id !== role.id));
            return void interaction.editReply({ content: `✅ Removed ${role} from **${name}**'s team.` });
        }

        if (action === 'set-transcript-channel') {
            const name = interaction.options.getString('name');
            const channel = interaction.options.getChannel('channel');
            if (!name || !channel) return void interaction.editReply({ content: 'Provide both `name` (an existing category) and `channel` (where its transcripts should be posted).' });
            if (!(channel instanceof TextChannel)) return void interaction.editReply({ content: 'Channel must be a text channel.' });

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (!settings.categories.some(c => c.key === key)) return void interaction.editReply({ content: `No category named "${name}" exists. Current categories: ${listCategoryNames(settings.categories)}` });

            await database.modmailSettings.setCategoryTranscriptChannel(guildId, key, channel.id);
            return void interaction.editReply({ content: `✅ Closed **${name}** threads will now post their transcript to ${channel}.` });
        }

        if (action === 'set-attachment-channel') {
            const name = interaction.options.getString('name');
            const channel = interaction.options.getChannel('channel');
            if (!name || !channel) return void interaction.editReply({ content: 'Provide both `name` (an existing category) and `channel` (where its attachments should be logged).' });
            if (!(channel instanceof TextChannel)) return void interaction.editReply({ content: 'Channel must be a text channel.' });

            const key = slugify(name);
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (!settings.categories.some(c => c.key === key)) return void interaction.editReply({ content: `No category named "${name}" exists. Current categories: ${listCategoryNames(settings.categories)}` });

            await database.modmailSettings.setCategoryAttachmentLogChannel(guildId, key, channel.id);
            return void interaction.editReply({ content: `✅ Every attachment sent in **${name}** threads will now also be forwarded to ${channel}.` });
        }

        if (action === 'block-user') {
            const user = interaction.options.getUser('user');
            if (!user) return void interaction.editReply({ content: 'Provide `user`.' });

            const reason = interaction.options.getString('reason');
            await database.modmailBlocks.block(guildId, user.id, interaction.user.id, reason);

            const openThread = await database.modmailThreads.fetchOpenForUserInGuild(guildId, user.id);
            if (openThread) {
                const threadChannel = await interaction.guild.channels.fetch(openThread.channelId).catch(() => null);
                if (threadChannel?.isThread()) {
                    await closeModmailThread(interaction.guild, openThread, threadChannel, 'Blocked from Modmail.', interaction.user.toString());
                }
            }

            return void interaction.editReply({ content: `✅ Blocked ${user} from opening new Modmail threads here${openThread ? ' and closed their open thread' : ''}.` });
        }

        if (action === 'unblock-user') {
            const user = interaction.options.getUser('user');
            if (!user) return void interaction.editReply({ content: 'Provide `user`.' });
            await database.modmailBlocks.unblock(guildId, user.id);
            return void interaction.editReply({ content: `✅ Unblocked ${user}.` });
        }

        if (action === 'list-blocked') {
            const blocks = await database.modmailBlocks.fetchAll(guildId);
            if (blocks.length === 0) return void interaction.editReply({ content: 'No one is currently blocked.' });
            const lines = blocks.map(b => `<@${b.userId}> — blocked by <@${b.blockedBy}>${b.reason ? `: ${b.reason}` : ''}`);
            return void interaction.editReply({ content: lines.join('\n') });
        }

        if (action === 'user-history') {
            const user = interaction.options.getUser('user');
            if (!user) return void interaction.editReply({ content: 'Provide `user`.' });

            const threads = await database.modmailThreads.fetchAllForUserInGuild(guildId, user.id);
            if (threads.length === 0) return void interaction.editReply({ content: `${user} has no Modmail threads in this server.` });

            const settings = await database.modmailSettings.fetch(guildId);
            const lines = threads.map(t => {
                const category = settings?.categories.find(c => c.key === t.categoryKey);
                const dates = t.status === 'closed' && t.closedAt
                    ? `opened <t:${Math.floor(t.createdAt / 1000)}:d>, closed <t:${Math.floor(t.closedAt / 1000)}:d>`
                    : `opened <t:${Math.floor(t.createdAt / 1000)}:d>`;
                return `#${t.threadNumber} — **${category?.label ?? t.categoryKey}** (${t.status}) — ${dates}`;
            });

            return void interaction.editReply({ content: `${user}'s Modmail history in this server:\n${lines.join('\n')}` });
        }

        if (action === 'link-main-server') {
            const mainGuildId = interaction.options.getString('main_guild_id');
            if (!mainGuildId) return void interaction.editReply({ content: 'Provide `main_guild_id`.' });
            if (mainGuildId === guildId) return void interaction.editReply({ content: "That's this same server — no need to link it to itself." });

            const mainGuild = interaction.client.guilds.cache.get(mainGuildId);
            if (!mainGuild) return void interaction.editReply({ content: `${interaction.client.user?.username ?? 'This bot'} isn't in a server with that ID — make sure it's been invited there first.` });

            const alreadyLinked = await database.modmailSettings.fetchByLinkedGuildId(mainGuildId);
            if (alreadyLinked && alreadyLinked.guildId !== guildId) {
                return void interaction.editReply({ content: `That server is already linked as the main server for a different mail server.` });
            }

            await database.modmailSettings.fetchOrCreate(guildId);
            await database.modmailSettings.setLinkedGuild(guildId, mainGuildId);
            return void interaction.editReply({ content: `✅ Linked **${mainGuild.name}** as this server's main/community server. Panels should be posted there (\`/modmail action:Post-Panel\`, run from that server), and users will interact entirely through DMs — they're never added to threads here.` });
        }

        if (action === 'unlink-main-server') {
            await database.modmailSettings.setLinkedGuild(guildId, null);
            return void interaction.editReply({ content: '✅ Unlinked — this server now acts as both the main and mail server (solo mode).' });
        }

        if (action === 'post-panel') {
            const channel = interaction.options.getChannel('channel');
            if (!channel || !(channel instanceof TextChannel)) return void interaction.editReply({ content: 'Provide a text `channel`.' });
            const result = await postModmailPanel(guildId, channel);
            return void interaction.editReply({ content: result.success ? `✅ Panel posted in ${channel}.` : result.message });
        }

        if (action === 'enable') {
            const settings = await database.modmailSettings.fetchOrCreate(guildId);
            if (settings.categories.length === 0) return void interaction.editReply({ content: 'Add at least one category before enabling Modmail.' });
            await database.modmailSettings.setEnabled(guildId, true);
            if (onModmailEnabled) await onModmailEnabled(guildId);
            return void interaction.editReply({ content: '✅ Modmail enabled.' });
        }

        if (action === 'disable') {
            await database.modmailSettings.setEnabled(guildId, false);
            return void interaction.editReply({ content: '✅ Modmail disabled.' });
        }

        if (action === 'reset') {
            const existing = await database.modmailSettings.fetch(guildId);
            if (!existing) return void interaction.editReply({ content: 'Modmail has not been set up on this server yet — nothing to reset.' });

            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('modmail-reset-confirm').setLabel('Confirm Reset').setStyle(ButtonStyle.Danger),
                new ButtonBuilder().setCustomId('modmail-reset-cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
            );

            const prompt = await interaction.editReply({
                content: `⚠️ This deletes this server's Modmail configuration — categories, staff roles, enabled state, and any mail-server link. Existing threads, transcripts, and blocked users are **not** affected. Are you sure?`,
                components: [row]
            });

            const clicked = await prompt.awaitMessageComponent({ filter: i => i.user.id === interaction.user.id, time: 30_000 }).catch(() => null);
            if (!clicked || clicked.customId === 'modmail-reset-cancel') {
                await interaction.editReply({ content: 'Cancelled — nothing was reset.', components: [] }).catch(() => null);
                return;
            }

            await database.modmailSettings.deleteSettings(guildId);
            await clicked.update({ content: '✅ Modmail configuration reset. Run `/modmail action:Add Category` to start fresh.', components: [] }).catch(() => null);
            return;
        }

        return void interaction.editReply({ content: 'Unknown action.' });
    });
}
