import { Collection as MongoCollection } from "mongodb";
import { IRawModmailThread } from "../../types/database.js";

export default class ModmailThreadManager {
    readonly collection: MongoCollection<IRawModmailThread>;

    constructor(collection: MongoCollection<IRawModmailThread>) {
        this.collection = collection;
    }

    async fetch(id: string): Promise<IRawModmailThread | null> {
        return this.collection.findOne({ id });
    }

    /** Every open thread a user has, across every guild — a plain follow-up DM can be ambiguous if this has more than one entry (see modmail-relay.ts). */
    async fetchOpenForUser(userId: string): Promise<IRawModmailThread[]> {
        return this.collection.find({ userId, status: 'open' }).sort({ createdAt: -1 }).toArray();
    }

    async fetchOpenForUserInGuild(guildId: string, userId: string): Promise<IRawModmailThread | null> {
        return this.collection.findOne({ guildId, userId, status: 'open' });
    }

    async fetchByChannelId(channelId: string): Promise<IRawModmailThread | null> {
        return this.collection.findOne({ channelId });
    }

    /** Used by the /logs/:id live-thread viewer — looked up by the long public logToken, never the short internal id. */
    async fetchByLogToken(logToken: string): Promise<IRawModmailThread | null> {
        return this.collection.findOne({ logToken });
    }

    /** Used by /mail action:Reopen's autocomplete — restricted to one category, since reopening is run from that category's own parent channel. */
    async fetchClosedForCategory(guildId: string, categoryKey: string): Promise<IRawModmailThread[]> {
        return this.collection.find({ guildId, categoryKey, status: 'closed' }).sort({ closedAt: -1 }).toArray();
    }

    /** Used by the DM-side reopen prompt — checks whether a user has a closed thread worth offering to reopen instead of starting a new one, scoped to whichever mutual guilds actually have Modmail enabled. */
    async fetchClosedForUserInGuilds(userId: string, guildIds: string[]): Promise<IRawModmailThread[]> {
        return this.collection.find({ userId, guildId: { $in: guildIds }, status: 'closed' }).sort({ closedAt: -1 }).toArray();
    }

    /** Used by /modmail action:User-History — every thread (any status/category) a user has had in one server, server-scoped only, never across other servers the bot is in. */
    async fetchAllForUserInGuild(guildId: string, userId: string): Promise<IRawModmailThread[]> {
        return this.collection.find({ guildId, userId }).sort({ createdAt: -1 }).toArray();
    }

    /** Used by the website's transcript search — every closed thread in a guild, newest-first, capped since this can grow unbounded over time and no pagination UI exists yet. */
    async fetchClosedForGuild(guildId: string, limit = 200): Promise<IRawModmailThread[]> {
        return this.collection.find({ guildId, status: 'closed' }).sort({ closedAt: -1 }).limit(limit).toArray();
    }

    /** Used to rate-limit new thread creation — counts threads a user has opened (any category/status) in a guild since a given timestamp. */
    async countCreatedSince(guildId: string, userId: string, sinceTimestamp: number): Promise<number> {
        return this.collection.countDocuments({ guildId, userId, createdAt: { $gte: sinceTimestamp } });
    }

    /** Used by the unanswered-thread reminder task — open threads whose last message was from the user, longer ago than the threshold, that haven't already had a reminder sent for this same pending message. */
    /** guildId-scoped since the reminder task now uses a per-guild opt-in + threshold rather than one global cutoff for every guild at once. */
    async fetchUnansweredOpenThreads(guildId: string, olderThanTimestamp: number): Promise<IRawModmailThread[]> {
        return this.collection.find({
            guildId,
            status: 'open',
            suspended: { $ne: true }, // a paused thread isn't "unanswered", it's intentionally on hold
            lastMessageDirection: 'from-user',
            lastMessageAt: { $lte: olderThanTimestamp },
            reminderSentAt: null
        }).toArray();
    }

    /**
     * Used to assign the next human-friendly threadNumber for a guild — based on the highest number
     * that currently exists, not a running count of documents. This matters once transcripts can be
     * deleted: deleting the most recent thread (say #4) frees that number for reuse by the next thread,
     * rather than a plain document-count approach either permanently skipping it or (worse) colliding
     * with a still-existing higher number.
     */
    async getHighestThreadNumber(guildId: string): Promise<number> {
        const highest = await this.collection.find({ guildId }).sort({ threadNumber: -1 }).limit(1).toArray();
        return highest[0]?.threadNumber ?? 0;
    }

    async create(data: IRawModmailThread): Promise<void> {
        await this.collection.insertOne(data);
    }

    async update(id: string, fields: Partial<IRawModmailThread>): Promise<void> {
        await this.collection.updateOne({ id }, { $set: fields });
    }

    /** Used by the website's transcript delete — only ever called for closed threads, checked by the caller. */
    async deleteThread(id: string): Promise<void> {
        await this.collection.deleteOne({ id });
    }
}
