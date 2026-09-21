import { Collection as MongoCollection } from "mongodb";
import { IRawModmailSnippet } from "../../types/database.js";

export default class ModmailSnippetManager {
    readonly collection: MongoCollection<IRawModmailSnippet>;

    constructor(collection: MongoCollection<IRawModmailSnippet>) {
        this.collection = collection;
    }

    async fetch(guildId: string, trigger: string): Promise<IRawModmailSnippet | null> {
        return this.collection.findOne({ guildId, trigger });
    }

    async fetchAll(guildId: string): Promise<IRawModmailSnippet[]> {
        return this.collection.find({ guildId }).sort({ trigger: 1 }).toArray();
    }

    async create(data: IRawModmailSnippet): Promise<void> {
        await this.collection.insertOne(data);
    }

    async update(guildId: string, trigger: string, body: string): Promise<void> {
        await this.collection.updateOne({ guildId, trigger }, { $set: { body } });
    }

    async delete(guildId: string, trigger: string): Promise<void> {
        await this.collection.deleteOne({ guildId, trigger });
    }
}
