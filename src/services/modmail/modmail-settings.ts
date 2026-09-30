import { EmbedBuilder, TextChannel, CategoryChannel, ChannelType, PermissionFlagsBits, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder } from "discord.js";
import { database } from "../../core/database.js";
import { Colors } from "../../utils/util.js";
import { ErrorHandler } from "../../structures/error-handler.js";
import { InGuildChatInputInteraction } from "../../types/discord.js";
import { ActionConfig, PanelInteraction, handleActionInteraction, startAction, updateOrReply } from "../../structures/modmail-settings-engine.js";
import { slugify, findMatchingCategory, listCategoryNames, parseHexColor } from "./modmail-config.js";
import { postModmailPanel } from "./modmail-panel.js";
import { closeModmailThread, onModmailEnabled } from "./modmail-relay.js";

/** Replaces the old `/modmail` flat action-choice command — same options, menu/modal-driven instead of typed. See modmail-settings-engine.ts for the underlying wizard mechanics. */

export const modmailActions: ActionConfig[] = [
    {
        key: 'add-category', label: 'Add Category',
        fields: [
            { key: 'name', label: 'Category Name', kind: 'text' },
            { key: 'channel', label: 'Parent Channel (or a folder to create one in)', kind: 'channel', channelTypes: [ChannelType.GuildText, ChannelType.GuildCategory] }
        ],
        onRun: async (interaction, values) => {
            const rawChannel = interaction.guild.channels.cache.get(values.channel);
            if (!rawChannel) return 'Invalid channel.';

            let channel: TextChannel;
            if (rawChannel instanceof TextChannel) {
                channel = rawChannel;
            } else if (rawChannel instanceof CategoryChannel) {
                channel = await interaction.guild.channels.create({ name: slugify(values.name), type: ChannelType.GuildText, parent: rawChannel.id });
            } else {
                return 'Channel must be a text channel or a category folder.';
            }

            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (settings.categories.some(c => c.key === key)) return `A category named **${values.name}** already exists.`;

            await database.modmailSettings.addCategory(interaction.guildId, { key, label: values.name, parentChannelId: channel.id });

            const canSetPermissions = channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles);
            if (canSetPermissions) {
                for (const roleId of settings.staffRoleIds) {
                    await channel.permissionOverwrites.edit(roleId, { ViewChannel: true, ManageThreads: true }).catch(() => null);
                }
            }
            return canSetPermissions
                ? `✅ Added category **${values.name}** → ${channel}.`
                : `✅ Added category **${values.name}** → ${channel}, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles there — staff won't automatically see it until you grant that permission and re-run this, or set channel permissions manually.`;
        }
    },
    {
        key: 'rename-category', label: 'Rename Category',
        fields: [{ key: 'name', label: 'Existing Category Name', kind: 'text' }, { key: 'new_name', label: 'New Display Name', kind: 'text' }],
        onRun: async (interaction, values) => {
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            const target = findMatchingCategory(settings.categories, values.name);
            if (!target) return `No category found matching **${values.name}**. Existing categories: ${listCategoryNames(settings.categories)}`;
            await database.modmailSettings.setCategoryLabel(interaction.guildId, target.key, values.new_name);
            return `✅ Renamed **${target.label}** to **${values.new_name}** — its internal key (\`${target.key}\`) is unchanged, so existing threads and transcripts stay intact.`;
        }
    },
    {
        key: 'remove-category', label: 'Remove Category',
        fields: [{ key: 'name', label: 'Category Name', kind: 'text' }],
        onRun: async (interaction, values) => {
            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (!settings.categories.some(c => c.key === key)) return `No category named "${values.name}" exists. Current categories: ${listCategoryNames(settings.categories)}`;
            await database.modmailSettings.removeCategory(interaction.guildId, key);
            return `✅ Removed category **${values.name}**.`;
        }
    },
    {
        key: 'set-staff-role', label: 'Set Staff Role',
        fields: [{ key: 'role', label: 'Role', kind: 'role' }],
        onRun: async (interaction, values) => {
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            const staffRoleIds = [...new Set([...settings.staffRoleIds, values.role])];
            await database.modmailSettings.setStaffRoles(interaction.guildId, staffRoleIds);

            const failedCategories: string[] = [];
            for (const category of settings.categories) {
                const channel = interaction.guild.channels.cache.get(category.parentChannelId);
                if (!(channel instanceof TextChannel)) continue;
                if (!channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles)) {
                    failedCategories.push(category.label);
                    continue;
                }
                await channel.permissionOverwrites.edit(values.role, { ViewChannel: true, ManageThreads: true }).catch(() => null);
            }
            return failedCategories.length
                ? `✅ <@&${values.role}> can now manage Modmail threads, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles in: ${failedCategories.join(', ')} — set permissions there manually.`
                : `✅ <@&${values.role}> can now manage Modmail threads.`;
        }
    },
    {
        key: 'remove-staff-role', label: 'Remove Staff Role',
        fields: [{ key: 'role', label: 'Role', kind: 'role' }],
        onRun: async (interaction, values) => {
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (!settings.staffRoleIds.includes(values.role)) return `<@&${values.role}> isn't currently a guild-wide staff role.`;
            await database.modmailSettings.setStaffRoles(interaction.guildId, settings.staffRoleIds.filter(id => id !== values.role));
            return `✅ Removed <@&${values.role}> from the guild-wide staff role(s).`;
        }
    },
    {
        key: 'set-category-staff-role', label: 'Set Category Staff Role',
        fields: [{ key: 'name', label: 'Category Name (not the role)', kind: 'text' }, { key: 'role', label: 'Role', kind: 'role' }],
        onRun: async (interaction, values) => {
            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            const category = settings.categories.find(c => c.key === key);
            if (!category) return `No category named "${values.name}" exists. Current categories: ${listCategoryNames(settings.categories)}`;

            const staffRoleIds = [...new Set([...category.staffRoleIds, values.role])];
            await database.modmailSettings.setCategoryStaffRoles(interaction.guildId, key, staffRoleIds);

            let permissionsFailed = false;
            const channel = interaction.guild.channels.cache.get(category.parentChannelId);
            if (channel instanceof TextChannel) {
                if (channel.permissionsFor(interaction.guild.members.me!).has(PermissionFlagsBits.ManageRoles)) {
                    await channel.permissionOverwrites.edit(values.role, { ViewChannel: true, ManageThreads: true }).catch(() => null);
                } else {
                    permissionsFailed = true;
                }
            }
            return permissionsFailed
                ? `✅ <@&${values.role}> added to **${values.name}**'s team, but ${interaction.client.user?.username ?? 'this bot'} lacks Manage Roles in ${channel} — set permissions there manually.`
                : `✅ <@&${values.role}> added to **${values.name}**'s team — they'll be added to new threads in this category alongside the guild-wide staff role(s).`;
        }
    },
    {
        key: 'remove-category-staff-role', label: 'Remove Category Staff Role',
        fields: [{ key: 'name', label: 'Category Name (not the role)', kind: 'text' }, { key: 'role', label: 'Role', kind: 'role' }],
        onRun: async (interaction, values) => {
            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            const category = settings.categories.find(c => c.key === key);
            if (!category) return `No category named "${values.name}" exists. Current categories: ${listCategoryNames(settings.categories)}`;
            await database.modmailSettings.setCategoryStaffRoles(interaction.guildId, key, category.staffRoleIds.filter(id => id !== values.role));
            return `✅ Removed <@&${values.role}> from **${values.name}**'s team.`;
        }
    },
    {
        key: 'set-transcript-channel', label: 'Set Transcript Channel',
        fields: [{ key: 'name', label: 'Category Name', kind: 'text' }, { key: 'channel', label: 'Transcript Channel', kind: 'channel', channelTypes: [ChannelType.GuildText] }],
        onRun: async (interaction, values) => {
            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (!settings.categories.some(c => c.key === key)) return `No category named "${values.name}" exists. Current categories: ${listCategoryNames(settings.categories)}`;
            await database.modmailSettings.setCategoryTranscriptChannel(interaction.guildId, key, values.channel);
            return `✅ Closed **${values.name}** threads will now post their transcript to <#${values.channel}>.`;
        }
    },
    {
        key: 'set-attachment-channel', label: 'Set Attachment Channel',
        fields: [{ key: 'name', label: 'Category Name', kind: 'text' }, { key: 'channel', label: 'Attachment Log Channel', kind: 'channel', channelTypes: [ChannelType.GuildText] }],
        onRun: async (interaction, values) => {
            const key = slugify(values.name);
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (!settings.categories.some(c => c.key === key)) return `No category named "${values.name}" exists. Current categories: ${listCategoryNames(settings.categories)}`;
            await database.modmailSettings.setCategoryAttachmentLogChannel(interaction.guildId, key, values.channel);
            return `✅ Every attachment sent in **${values.name}** threads will now also be forwarded to <#${values.channel}>.`;
        }
    },
    {
        key: 'enable-reply-ping', label: 'Enable Reply Ping',
        fields: [],
        onRun: async interaction => {
            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setPingOnUserReply(interaction.guildId, true);
            return '✅ Staff will now be pinged in-thread on every user follow-up message, not just when a thread first opens.';
        }
    },
    {
        key: 'disable-reply-ping', label: 'Disable Reply Ping',
        fields: [],
        onRun: async interaction => {
            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setPingOnUserReply(interaction.guildId, false);
            return '✅ Staff will no longer be pinged on follow-up messages — only when a thread first opens.';
        }
    },
    {
        key: 'enable-reminders', label: 'Enable Reminders',
        fields: [],
        onRun: async interaction => {
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setReminderEnabled(interaction.guildId, true);
            return `✅ Staff will now be reminded about threads left unanswered for ${settings.reminderThresholdHours ?? 24}+ hour(s). Change that with **Set Reminder Threshold**.`;
        }
    },
    {
        key: 'disable-reminders', label: 'Disable Reminders',
        fields: [],
        onRun: async interaction => {
            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setReminderEnabled(interaction.guildId, false);
            return '✅ Unanswered-thread reminders turned off.';
        }
    },
    {
        key: 'set-reminder-threshold', label: 'Set Reminder Threshold',
        fields: [{ key: 'hours', label: 'Hours (at least 1)', kind: 'text' }],
        onRun: async (interaction, values) => {
            const hours = parseInt(values.hours, 10);
            if (!Number.isFinite(hours) || hours < 1) return 'Provide a whole number of hours (at least 1).';
            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setReminderThresholdHours(interaction.guildId, hours);
            return `✅ Reminder threshold set to ${hours} hour(s).`;
        }
    },
    {
        key: 'post-panel', label: 'Post Panel',
        fields: [{ key: 'channel', label: 'Channel', kind: 'channel', channelTypes: [ChannelType.GuildText] }],
        onRun: async (interaction, values) => {
            const channel = interaction.guild.channels.cache.get(values.channel);
            if (!(channel instanceof TextChannel)) return 'Provide a text channel.';
            const result = await postModmailPanel(interaction.guildId, channel);
            return result.success ? `✅ Panel posted in ${channel}.` : result.message;
        }
    },
    {
        key: 'block-user', label: 'Block User',
        fields: [{ key: 'user', label: 'User', kind: 'user' }, { key: 'reason', label: 'Block Reason (staff-only)', kind: 'text', required: false }],
        onRun: async (interaction, values) => {
            await database.modmailBlocks.block(interaction.guildId, values.user, interaction.user.id, values.reason || null);
            const openThread = await database.modmailThreads.fetchOpenForUserInGuild(interaction.guildId, values.user);
            if (openThread) {
                const threadChannel = await interaction.guild.channels.fetch(openThread.channelId).catch(() => null);
                if (threadChannel?.isThread()) await closeModmailThread(interaction.guild, openThread, threadChannel, 'Blocked from Modmail.', `<@${values.user}>`);
            }
            return `✅ Blocked <@${values.user}> from opening new Modmail threads here${openThread ? ' and closed their open thread' : ''}.`;
        }
    },
    {
        key: 'unblock-user', label: 'Unblock User',
        fields: [{ key: 'user', label: 'User', kind: 'user' }],
        onRun: async (interaction, values) => {
            await database.modmailBlocks.unblock(interaction.guildId, values.user);
            return `✅ Unblocked <@${values.user}>.`;
        }
    },
    {
        key: 'list-blocked', label: 'List Blocked Users',
        fields: [],
        onRun: async interaction => {
            const blocks = await database.modmailBlocks.fetchAll(interaction.guildId);
            if (blocks.length === 0) return 'No one is currently blocked.';
            return blocks.map(b => `<@${b.userId}> — blocked by <@${b.blockedBy}>${b.reason ? `: ${b.reason}` : ''}`).join('\n');
        }
    },
    {
        key: 'user-history', label: 'User History',
        fields: [{ key: 'user', label: 'User', kind: 'user' }],
        onRun: async (interaction, values) => {
            const threads = await database.modmailThreads.fetchAllForUserInGuild(interaction.guildId, values.user);
            if (threads.length === 0) return `<@${values.user}> has no Modmail threads in this server.`;

            const settings = await database.modmailSettings.fetch(interaction.guildId);
            const lines = threads.map(t => {
                const category = settings?.categories.find(c => c.key === t.categoryKey);
                const dates = t.status === 'closed' && t.closedAt
                    ? `opened <t:${Math.floor(t.createdAt / 1000)}:d>, closed <t:${Math.floor(t.closedAt / 1000)}:d>`
                    : `opened <t:${Math.floor(t.createdAt / 1000)}:d>`;
                return `#${t.threadNumber} — **${category?.label ?? t.categoryKey}** (${t.status}) — ${dates}`;
            });
            return `<@${values.user}>'s Modmail history in this server:\n${lines.join('\n')}`;
        }
    },
    {
        key: 'link-main-server', label: 'Link Main Server',
        fields: [{ key: 'main_guild_id', label: 'Main Server ID', kind: 'text', placeholder: 'Developer Mode → Copy ID' }],
        onRun: async (interaction, values) => {
            if (values.main_guild_id === interaction.guildId) return "That's this same server — no need to link it to itself.";

            const mainGuild = interaction.client.guilds.cache.get(values.main_guild_id);
            if (!mainGuild) return `${interaction.client.user?.username ?? 'This bot'} isn't in a server with that ID — make sure it's been invited there first.`;

            const alreadyLinked = await database.modmailSettings.fetchByLinkedGuildId(values.main_guild_id);
            if (alreadyLinked && alreadyLinked.guildId !== interaction.guildId) return 'That server is already linked as the main server for a different mail server.';

            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setLinkedGuild(interaction.guildId, values.main_guild_id);
            return `✅ Linked **${mainGuild.name}** as this server's main/community server. Panels should be posted there (**Post Panel**, run from that server), and users will interact entirely through DMs — they're never added to threads here.`;
        }
    },
    {
        key: 'unlink-main-server', label: 'Unlink Main Server',
        fields: [],
        onRun: async interaction => {
            await database.modmailSettings.setLinkedGuild(interaction.guildId, null);
            return '✅ Unlinked — this server now acts as both the main and mail server (solo mode).';
        }
    },
    {
        key: 'enable', label: 'Enable Modmail',
        fields: [],
        onRun: async interaction => {
            const settings = await database.modmailSettings.fetchOrCreate(interaction.guildId);
            if (settings.categories.length === 0) return 'Add at least one category before enabling Modmail.';
            await database.modmailSettings.setEnabled(interaction.guildId, true);
            if (onModmailEnabled) await onModmailEnabled(interaction.guildId);
            return '✅ Modmail enabled.';
        }
    },
    {
        key: 'disable', label: 'Disable Modmail',
        fields: [],
        onRun: async interaction => {
            await database.modmailSettings.setEnabled(interaction.guildId, false);
            return '✅ Modmail disabled.';
        }
    },
    {
        key: 'appearance', label: 'Edit Embed Colors & Emoji',
        fields: [
            { key: 'staff-color', label: 'Staff message color, hex (blank = default)', kind: 'text', required: false },
            { key: 'user-color', label: 'User message color, hex (blank = default)', kind: 'text', required: false },
            { key: 'confirmation-emoji', label: 'Delivery confirmation emoji (blank = ✅)', kind: 'text', required: false, placeholder: 'Custom emoji: type \\:name: in a channel, paste the <:name:id> result' },
            { key: 'notice-icon', label: 'Notice title icon (blank = 🛡️)', kind: 'text', required: false, placeholder: 'Custom emoji: type \\:name: in a channel, paste the <:name:id> result' }
        ],
        onRun: async (interaction, values) => {
            const staffColor = parseHexColor(values['staff-color']);
            if (values['staff-color'] && !staffColor) return 'Staff message color must be a hex code like `#FF0000`.';
            const userColor = parseHexColor(values['user-color']);
            if (values['user-color'] && !userColor) return 'User message color must be a hex code like `#00FF00`.';

            await database.modmailSettings.fetchOrCreate(interaction.guildId);
            await database.modmailSettings.setEmbedColors(interaction.guildId, staffColor, userColor);
            await database.modmailSettings.setConfirmationEmoji(interaction.guildId, values['confirmation-emoji'] || null);
            await database.modmailSettings.setNoticeIcon(interaction.guildId, values['notice-icon'] || null);
            return '✅ Modmail appearance updated.';
        }
    },
    {
        key: 'reset', label: 'Reset Configuration',
        fields: [{ key: 'confirm', label: 'Type CONFIRM to proceed', kind: 'text' }],
        onRun: async (interaction, values) => {
            if (values.confirm !== 'CONFIRM') return 'Cancelled — nothing was reset (you must type CONFIRM exactly).';
            const existing = await database.modmailSettings.fetch(interaction.guildId);
            if (!existing) return 'Modmail has not been set up on this server yet — nothing to reset.';
            await database.modmailSettings.deleteSettings(interaction.guildId);
            return '✅ Modmail configuration reset — categories, staff roles, enabled state, and any mail-server link were cleared. Existing threads, transcripts, and blocked users are **not** affected. Run **Add Category** to start fresh.';
        }
    }
];

export async function renderModmailSettingsMenu(interaction: InGuildChatInputInteraction | PanelInteraction): Promise<void> {
    const settings = await database.modmailSettings.fetchForActingGuild(interaction.guildId);

    const categoryLines = settings && settings.categories.length > 0
        ? settings.categories.map(c => `**${c.label}** (\`${c.key}\`) → <#${c.parentChannelId}>${c.transcriptChannelId ? ` — transcripts to <#${c.transcriptChannelId}>` : ''}${c.staffRoleIds.length ? ` — team: ${c.staffRoleIds.map(id => `<@&${id}>`).join(', ')}` : ''}`).join('\n')
        : '*(none configured)*';

    const embed = new EmbedBuilder()
        .setColor(Colors.EmiliaPurple)
        .setTitle('Modmail Settings')
        .addFields(
            { name: 'Enabled', value: settings?.enabled ? 'Yes' : 'No', inline: true },
            { name: 'Linked Main Server', value: settings?.linkedGuildId ? `\`${settings.linkedGuildId}\`` : '*(none — solo mode)*', inline: true },
            { name: 'Staff Role(s)', value: settings && settings.staffRoleIds.length > 0 ? settings.staffRoleIds.map(id => `<@&${id}>`).join(', ') : '*(none set)*' },
            { name: 'Reply Ping', value: settings?.pingOnUserReply ? 'Yes — staff pinged on every user follow-up' : 'No — only pinged when a thread first opens', inline: true },
            { name: 'Unanswered Reminders', value: settings?.reminderEnabled ? `Yes — after ${settings.reminderThresholdHours ?? 24}h unanswered` : 'No', inline: true },
            { name: 'Embed Colors', value: `Staff: ${settings?.staffEmbedColor ?? '*(default)*'} · User: ${settings?.userEmbedColor ?? '*(default)*'}`, inline: true },
            { name: 'Confirmation Emoji', value: settings?.confirmationEmoji ?? '✅ *(default)*', inline: true },
            { name: 'Notice Title Icon', value: settings?.noticeIcon ?? '🛡️ *(default)*', inline: true },
            { name: 'Categories', value: categoryLines }
        )
        .setFooter({ text: 'Pick an option below to configure it.' });

    const select = new StringSelectMenuBuilder()
        .setCustomId('modmail-settings_menu')
        .setPlaceholder('Choose a setting to configure...')
        .addOptions(modmailActions.map(a => new StringSelectMenuOptionBuilder().setLabel(a.label).setValue(a.key)));

    const payload = { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)] };

    if ('isChatInputCommand' in interaction && interaction.isChatInputCommand()) {
        await interaction.editReply(payload);
    } else {
        await updateOrReply(interaction as PanelInteraction, payload);
    }
}

export async function modmailSettingsCommand(interaction: InGuildChatInputInteraction): Promise<void> {
    return ErrorHandler.wrap(interaction, 'modmail-settings', () => renderModmailSettingsMenu(interaction));
}

/** interaction-create.ts routes every modmail-settings_* component/modal here. */
export async function handleModmailSettingsInteraction(interaction: PanelInteraction): Promise<void> {
    const rest = interaction.customId.slice('modmail-settings_'.length);

    if (rest === 'menu' && interaction.isStringSelectMenu()) {
        const action = modmailActions.find(a => a.key === interaction.values[0]);
        if (action) return startAction(interaction, action);
        return;
    }

    if (rest === 'back') {
        return renderModmailSettingsMenu(interaction);
    }

    if (rest.startsWith('action.')) {
        const withoutPrefix = rest.slice('action.'.length);
        const dotIndex = withoutPrefix.indexOf('.');
        if (dotIndex === -1) return;
        const actionKey = withoutPrefix.slice(0, dotIndex);
        const verb = withoutPrefix.slice(dotIndex + 1);
        return handleActionInteraction(interaction, modmailActions, actionKey, verb);
    }
}
