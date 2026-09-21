import { IModmailCategory, IRawModmailSettings } from "../../types/database.js";
import { CollectionManager } from "./collection-manager.js";

const DEFAULT_SETTINGS = (guildId: string): IRawModmailSettings => ({
    guildId,
    linkedGuildId: null,
    enabled: false,
    staffRoleIds: [],
    pingOnUserReply: true,
    categories: [],
    panelChannelId: null,
    panelMessageId: null
});

export default class ModmailSettingsManager extends CollectionManager<IRawModmailSettings> {

    /** Docs created before `staffRoleIds`/`transcriptChannelId`/`pingOnUserReply` were added to the schema simply don't have them in Mongo — every reader downstream assumes they always do, so normalize once here rather than defending at every call site. */
    private normalize(settings: IRawModmailSettings): IRawModmailSettings {
        settings.categories = settings.categories.map(c => ({
            ...c,
            transcriptChannelId: c.transcriptChannelId ?? null,
            attachmentLogChannelId: c.attachmentLogChannelId ?? null,
            staffRoleIds: c.staffRoleIds ?? []
        }));
        settings.pingOnUserReply = settings.pingOnUserReply ?? true;
        settings.reminderEnabled = settings.reminderEnabled ?? false;
        settings.reminderThresholdHours = settings.reminderThresholdHours ?? 24;
        return settings;
    }

    async fetch(guildId: string) {
        const cached = this.cache.get(guildId);
        if (cached) return cached;

        const res = await this.findOne({ guildId });
        if (!res) return null;

        this.normalize(res);
        this.cache.set(guildId, res);
        return res;
    }

    /** Used to resolve which of the bot's mutual guilds with a DMing user have Modmail turned on. */
    async fetchAllEnabled(): Promise<IRawModmailSettings[]> {
        const all = await this.find({ enabled: true }).toArray();
        return all.map(s => this.normalize(s));
    }

    /** Resolves a settings doc when the acting guild might be the linked main/community server instead of the mail server the doc is actually keyed by — used by post-panel and panel-button clicks, both of which happen in the main guild in a dedicated-mail-server setup. */
    async fetchByLinkedGuildId(linkedGuildId: string): Promise<IRawModmailSettings | null> {
        const res = await this.findOne({ linkedGuildId });
        return res ? this.normalize(res) : null;
    }

    /** Tries a direct match first (covers solo mode and running config from the mail server), then falls back to the linked-guild match (covers post-panel/panel-clicks happening in the main server). */
    async fetchForActingGuild(guildId: string): Promise<IRawModmailSettings | null> {
        return (await this.fetch(guildId)) ?? (await this.fetchByLinkedGuildId(guildId));
    }

    async setLinkedGuild(guildId: string, linkedGuildId: string | null) {
        await this.updateOne({ guildId }, { $set: { linkedGuildId } });
        const cached = this.cache.get(guildId);
        if (cached) cached.linkedGuildId = linkedGuildId;
    }

    async fetchOrCreate(guildId: string): Promise<IRawModmailSettings> {
        const existing = await this.fetch(guildId);
        if (existing) return existing;

        const settings = DEFAULT_SETTINGS(guildId);
        await this.insertOne(settings);
        this.cache.set(guildId, settings);
        return settings;
    }

    async setEnabled(guildId: string, enabled: boolean) {
        await this.updateOne({ guildId }, { $set: { enabled } });
        const cached = this.cache.get(guildId);
        if (cached) cached.enabled = enabled;
    }

    async setStaffRoles(guildId: string, staffRoleIds: string[]) {
        await this.updateOne({ guildId }, { $set: { staffRoleIds } });
        const cached = this.cache.get(guildId);
        if (cached) cached.staffRoleIds = staffRoleIds;
    }

    async setPingOnUserReply(guildId: string, pingOnUserReply: boolean) {
        await this.updateOne({ guildId }, { $set: { pingOnUserReply } });
        const cached = this.cache.get(guildId);
        if (cached) cached.pingOnUserReply = pingOnUserReply;
    }

    async setReminderEnabled(guildId: string, reminderEnabled: boolean) {
        await this.updateOne({ guildId }, { $set: { reminderEnabled } });
        const cached = this.cache.get(guildId);
        if (cached) cached.reminderEnabled = reminderEnabled;
    }

    async setReminderThresholdHours(guildId: string, reminderThresholdHours: number) {
        await this.updateOne({ guildId }, { $set: { reminderThresholdHours } });
        const cached = this.cache.get(guildId);
        if (cached) cached.reminderThresholdHours = reminderThresholdHours;
    }

    async setPanelMessage(guildId: string, panelChannelId: string, panelMessageId: string) {
        await this.updateOne({ guildId }, { $set: { panelChannelId, panelMessageId } });
        const cached = this.cache.get(guildId);
        if (cached) { cached.panelChannelId = panelChannelId; cached.panelMessageId = panelMessageId; }
    }

    async addCategory(guildId: string, category: Omit<IModmailCategory, 'transcriptChannelId' | 'staffRoleIds'>) {
        await this.fetchOrCreate(guildId); // ensures a settings doc exists to $push into
        const newCategory: IModmailCategory = { ...category, transcriptChannelId: null, staffRoleIds: [] };

        await this.updateOne({ guildId }, { $push: { categories: newCategory } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories.push(newCategory);
    }

    // Only the display label changes — key stays put on purpose, so existing threads' categoryKey
    // references (and their transcripts) aren't affected by a rename.
    async setCategoryLabel(guildId: string, key: string, label: string) {
        const settings = await this.fetchOrCreate(guildId);
        const updated = settings.categories.map(c => c.key === key ? { ...c, label } : c);

        await this.updateOne({ guildId }, { $set: { categories: updated } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories = updated;
    }

    async setCategoryAttachmentLogChannel(guildId: string, key: string, attachmentLogChannelId: string | null) {
        const settings = await this.fetchOrCreate(guildId);
        const updated = settings.categories.map(c => c.key === key ? { ...c, attachmentLogChannelId } : c);

        await this.updateOne({ guildId }, { $set: { categories: updated } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories = updated;
    }

    async setCategoryTranscriptChannel(guildId: string, key: string, transcriptChannelId: string | null) {
        const settings = await this.fetchOrCreate(guildId);
        const updated = settings.categories.map(c => c.key === key ? { ...c, transcriptChannelId } : c);

        await this.updateOne({ guildId }, { $set: { categories: updated } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories = updated;
    }

    async setCategoryStaffRoles(guildId: string, key: string, staffRoleIds: string[]) {
        const settings = await this.fetchOrCreate(guildId);
        const updated = settings.categories.map(c => c.key === key ? { ...c, staffRoleIds } : c);

        await this.updateOne({ guildId }, { $set: { categories: updated } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories = updated;
    }

    async removeCategory(guildId: string, key: string) {
        await this.updateOne({ guildId }, { $pull: { categories: { key } } });
        const cached = this.cache.get(guildId);
        if (cached) cached.categories = cached.categories.filter(c => c.key !== key);
    }

    /** Used by /modmail action:Reset — deletes this guild's whole Modmail config (categories/staff-roles/enabled/link), but never touches threads/messages/blocks, which stay intact as history. */
    async deleteSettings(guildId: string): Promise<void> {
        await this.deleteOne({ guildId });
        this.cache.delete(guildId);
    }
}
