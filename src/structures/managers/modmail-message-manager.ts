import { Collection as MongoCollection } from "mongodb";
import { IRawModmailMessage } from "../../types/database.js";

export default class ModmailMessageManager {
    readonly collection: MongoCollection<IRawModmailMessage>;

    constructor(collection: MongoCollection<IRawModmailMessage>) {
        this.collection = collection;
    }

    async create(data: IRawModmailMessage): Promise<void> {
        await this.collection.insertOne(data);
    }

    /** Ordered oldest-first — the raw material for both live relay context and transcript reconstruction. */
    async fetchByThread(modmailThreadId: string): Promise<IRawModmailMessage[]> {
        return this.collection.find({ modmailThreadId }).sort({ createdAt: 1 }).toArray();
    }

    async fetchByDmMessageId(dmMessageId: string): Promise<IRawModmailMessage | null> {
        return this.collection.findOne({ dmMessageId });
    }

    /** Used to assign the next human-friendly messageNumber for a staff reply within one thread. */
    async countStaffReplies(modmailThreadId: string): Promise<number> {
        return this.collection.countDocuments({ modmailThreadId, direction: 'to-user' });
    }

    async fetchByThreadAndNumber(modmailThreadId: string, messageNumber: number): Promise<IRawModmailMessage | null> {
        return this.collection.findOne({ modmailThreadId, direction: 'to-user', messageNumber });
    }

    async updateBody(id: string, body: string): Promise<void> {
        await this.collection.updateOne({ id }, { $set: { body } });
    }

    /** Used by the website's transcript delete — removes every message belonging to a thread that's being deleted. */
    async deleteByThread(modmailThreadId: string): Promise<void> {
        await this.collection.deleteMany({ modmailThreadId });
    }
}
