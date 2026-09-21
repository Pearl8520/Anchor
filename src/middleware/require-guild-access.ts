import { Request, Response, NextFunction } from "express";
import { ConnectionClient } from "../core/client.js";
import { database } from "../core/database.js";
import { canManageGuild } from "../services/core/discord-oauth.js";
import { resolveUserGuilds } from "../services/core/guild-session.js";

/** Gate for per-guild dashboard routes — verifies the session's user can manage :guildId and the bot is actually in it. */
export function requireGuildAccess(client: ConnectionClient) {
    return async function (req: Request, res: Response, next: NextFunction): Promise<void> {
        const { guildId } = req.params;
        try {
            const session = await database.sessions.fetch(req.user!.sessionId);
            if (!session) {
                res.status(401).json({ error: 'Not authenticated.' });
                return;
            }

            if (!client.guilds.cache.has(guildId)) {
                res.status(403).json({ error: `${client.user?.username ?? 'This bot'} is not in that server.` });
                return;
            }

            const discordGuilds = await resolveUserGuilds(session);
            const guild = discordGuilds.find(g => g.id === guildId);
            if (!guild || !canManageGuild(guild)) {
                res.status(403).json({ error: 'You do not have permission to manage that server.' });
                return;
            }

            next();
        } catch {
            res.status(502).json({ error: 'Could not reach Discord. Please try again.' });
        }
    };
}
