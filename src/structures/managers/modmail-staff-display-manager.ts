import { Collection as MongoCollection } from "mongodb";
import { IRawModmailStaffDisplay } from "../../types/database.js";

export default class ModmailStaffDisplayManager {
    readonly collection: MongoCollection<IRawModmailStaffDisplay>;

    constructor(collection: MongoCollection<IRawModmailStaffDisplay>) {
        this.collection = collection;
    }

    async fetch(guildId: string, userId: string): Promise<IRawModmailStaffDisplay | null> {
        return this.collection.findOne({ guildId, userId });
    }

    async setRole(guildId: string, userId: string, roleId: string | null): Promise<void> {
        await this.collection.updateOne({ guildId, userId }, { $set: { guildId, userId, roleId } }, { upsert: true });
    }
}
