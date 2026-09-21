import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, TextChannel, ButtonInteraction, MessageFlags, PermissionFlagsBits } from "discord.js";
import { database } from "../../core/database.js";
import { Colors } from "../../utils/util.js";
import { createModmailThread } from "./modmail-intake.js";

export interface PanelActionResult { success: boolean; message: string; }

const PANEL_BUTTON_PREFIX = 'modmail-panel_';

export async function postModmailPanel(guildId: string, channel: TextChannel): Promise<PanelActionResult> {
    // Resolves whether `guildId` is the mail server itself (solo mode) or its linked main server
    // (dedicated mail-server mode) — the panel is meant to be posted where users actually are, so this
    // command is expected to run from the main server in the latter case.
    const settings = await database.modmailSettings.fetchForActingGuild(guildId);
    if (!settings || settings.categories.length === 0) {
        return { success: false, message: 'Add at least one category before posting a panel.' };
    }

    const botPermissions = channel.guild.members.me?.permissionsIn(channel);
    if (!botPermissions?.has(PermissionFlagsBits.ViewChannel) || !botPermissions.has(PermissionFlagsBits.SendMessages)) {
        return { success: false, message: `${channel.client.user?.username ?? 'This bot'} does not have permission to send messages in ${channel}.` };
    }

    const embed = new EmbedBuilder()
        .setColor(Colors.EmiliaPurple)
        .setTitle('Contact Staff')
        .setDescription('Click a button below for what you need — this opens a private thread with staff.');

    // Discord caps each action row at 5 buttons (and 5 rows per message) — chunk rather than silently drop extras.
    const buttons = settings.categories.slice(0, 25).map(c =>
        new ButtonBuilder().setCustomId(`${PANEL_BUTTON_PREFIX}${c.key}`).setLabel(c.label).setStyle(ButtonStyle.Primary)
    );
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
    }

    // Re-posting to the same channel refreshes the existing panel message in place instead of duplicating it.
    if (settings.panelChannelId === channel.id && settings.panelMessageId) {
        const existing = await channel.messages.fetch(settings.panelMessageId).catch(() => null);
        if (existing) {
            await existing.edit({ embeds: [embed], components: rows });
            return { success: true, message: 'Panel refreshed.' };
        }
    }

    const message = await channel.send({ embeds: [embed], components: rows });
    // Must key off settings.guildId (the mail server's own key), not the passed-in guildId — those
    // differ whenever this ran from the linked main server, and updating by the wrong id would silently
    // match no document at all.
    await database.modmailSettings.setPanelMessage(settings.guildId, channel.id, message.id);
    return { success: true, message: 'Panel posted.' };
}

/** interaction-create.ts routes any customId starting with modmail-panel_ here. */
export async function handlePanelButtonClick(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild()) return;
    const categoryKey = interaction.customId.slice(PANEL_BUTTON_PREFIX.length);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // the click confirmation is private, the resulting thread is not

    const guild = interaction.guild;
    if (!guild) return;

    const result = await createModmailThread(guild, interaction.user.id, categoryKey, null);
    await interaction.editReply({ content: result.success ? '✅ Thread opened — check your open threads in this server.' : result.message });
}
