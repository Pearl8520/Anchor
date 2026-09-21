import { Request, Response, NextFunction } from "express";
import { database } from "../core/database.js";

export const SESSION_COOKIE_NAME = 'modmail_session';

/** Loads the session (if any) onto req.user. Never blocks the request — use requireAuth to actually gate routes. */
export async function attachSession(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const sessionId = req.signedCookies?.[SESSION_COOKIE_NAME];
    if (!sessionId) return next();

    const session = await database.sessions.fetch(sessionId);
    if (!session) return next();

    req.user = {
        sessionId: session.id,
        userId: session.userId,
        username: session.username,
        avatar: session.avatar
    };
    next();
}
