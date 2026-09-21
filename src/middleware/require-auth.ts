import { Request, Response, NextFunction } from "express";

/** Gate for routes that need a logged-in dashboard user — mount attachSession before this on the app. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'Not authenticated.' });
        return;
    }
    next();
}
