import { IRawSession } from "../../types/database.js";
import { CollectionManager } from "./collection-manager.js";

export default class SessionManager extends CollectionManager<IRawSession> {

    async fetch(id: string) {
        const cached = this.cache.get(id);
        if (cached) return cached;

        const res = await this.findOne({ id });
        if (!res) return null;

        this.cache.set(id, res);
        return res;
    }

    async create(data: IRawSession) {
        await this.insertOne(data);
        this.cache.set(data.id, data);
    }

    async delete(id: string) {
        await this.deleteOne({ id });
        this.cache.delete(id);
    }

    async updateGuildsCache(id: string, guildsCache: IRawSession['guildsCache']) {
        await this.updateOne({ id }, { $set: { guildsCache } });
        const cached = this.cache.get(id);
        if (cached) cached.guildsCache = guildsCache;
    }

    async refreshTokens(id: string, discordAccessToken: string, discordRefreshToken: string, discordTokenExpiresAt: number) {
        await this.updateOne({ id }, { $set: { discordAccessToken, discordRefreshToken, discordTokenExpiresAt } });
        const cached = this.cache.get(id);
        if (cached) {
            cached.discordAccessToken = discordAccessToken;
            cached.discordRefreshToken = discordRefreshToken;
            cached.discordTokenExpiresAt = discordTokenExpiresAt;
        }
    }
}
