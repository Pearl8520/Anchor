import { Router } from "express";
import { nanoid } from "nanoid";
import { database } from "../core/database.js";
import { config, dashboardEnv } from "../config.js";
import { requireDashboardConfigured } from "../middleware/require-dashboard-configured.js";
import { SESSION_COOKIE_NAME } from "../middleware/session.js";
import { buildAuthorizeUrl, exchangeCode, fetchDiscordUser } from "../services/core/discord-oauth.js";

const STATE_COOKIE_NAME = 'modmail_oauth_state';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function createAuthRouter(): Router {
    const router = Router();
    router.use(requireDashboardConfigured);

    router.get('/discord/login', (req, res) => {
        const state = nanoid();
        res.cookie(STATE_COOKIE_NAME, state, {
            httpOnly: true,
            secure: true,
            sameSite: 'none',
            maxAge: 5 * 60 * 1000
        });
        res.redirect(buildAuthorizeUrl(state));
    });

    router.get('/discord/callback', async (req, res) => {
        try {
            const { code, state } = req.query;
            const expectedState = req.cookies?.[STATE_COOKIE_NAME];

            if (typeof code !== 'string' || typeof state !== 'string' || state !== expectedState) {
                res.status(400).send('Invalid or expired login attempt. Please try logging in again.');
                return;
            }

            res.clearCookie(STATE_COOKIE_NAME);

            const tokens = await exchangeCode(code);
            const discordUser = await fetchDiscordUser(tokens.access_token);

            const sessionId = nanoid(21);
            const now = Date.now();

            await database.sessions.create({
                id: sessionId,
                userId: discordUser.id,
                username: discordUser.username,
                avatar: discordUser.avatar,
                discordAccessToken: tokens.access_token,
                discordRefreshToken: tokens.refresh_token,
                discordTokenExpiresAt: now + tokens.expires_in * 1000,
                createdAt: now,
                expiresAt: new Date(now + SESSION_TTL_MS)
            });

            res.cookie(SESSION_COOKIE_NAME, sessionId, {
                httpOnly: true,
                secure: true,
                sameSite: 'none',
                signed: true,
                maxAge: SESSION_TTL_MS
            });

            res.redirect(`${dashboardEnv.DASHBOARD_URL}/servers`);
        } catch {
            res.status(500).send('Something went wrong logging you in. Please try again.');
        }
    });

    router.get('/me', (req, res) => {
        if (!req.user) {
            res.status(401).json({ error: 'Not authenticated.' });
            return;
        }
        res.json({ id: req.user.userId, username: req.user.username, avatar: req.user.avatar, isOwner: req.user.userId === config.ownerId });
    });

    router.post('/logout', async (req, res) => {
        if (req.user) await database.sessions.delete(req.user.sessionId);
        res.clearCookie(SESSION_COOKIE_NAME);
        res.status(204).end();
    });

    return router;
}
