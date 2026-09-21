import { database } from "../../core/database.js";
import { IRawSession } from "../../types/database.js";
import { DiscordPartialGuild, fetchUserGuilds, refreshAccessToken } from "./discord-oauth.js";

export const GUILDS_CACHE_MS = 3 * 60 * 1000;

export async function resolveUserGuilds(session: IRawSession): Promise<DiscordPartialGuild[]> {
    const cached = session.guildsCache;
    if (cached && Date.now() - cached.cachedAt < GUILDS_CACHE_MS) return cached.data;

    let accessToken = session.discordAccessToken;
    if (Date.now() >= session.discordTokenExpiresAt) {
        const refreshed = await refreshAccessToken(session.discordRefreshToken);
        accessToken = refreshed.access_token;
        await database.sessions.refreshTokens(
            session.id, refreshed.access_token, refreshed.refresh_token,
            Date.now() + refreshed.expires_in * 1000
        );
    }

    const discordGuilds = await fetchUserGuilds(accessToken);
    await database.sessions.updateGuildsCache(session.id, { data: discordGuilds, cachedAt: Date.now() });
    return discordGuilds;
}
