import { Collection as MongoCollection } from "mongodb";
import { IRawModmailBlock } from "../../types/database.js";

export default class ModmailBlockManager {
    readonly collection: MongoCollection<IRawModmailBlock>;

    constructor(collection: MongoCollection<IRawModmailBlock>) {
        this.collection = collection;
    }

    async fetch(guildId: string, userId: string): Promise<IRawModmailBlock | null> {
        return this.collection.findOne({ guildId, userId });
    }

    async isBlocked(guildId: string, userId: string): Promise<boolean> {
        return !!(await this.fetch(guildId, userId));
    }

    async block(guildId: string, userId: string, blockedBy: string, reason: string | null): Promise<void> {
        await this.collection.updateOne({ guildId, userId }, { $set: { guildId, userId, blockedBy, reason, createdAt: Date.now() } }, { upsert: true });
    }

    async unblock(guildId: string, userId: string): Promise<void> {
        await this.collection.deleteOne({ guildId, userId });
    }

    async fetchAll(guildId: string): Promise<IRawModmailBlock[]> {
        return this.collection.find({ guildId }).sort({ createdAt: -1 }).toArray();
    }
}
