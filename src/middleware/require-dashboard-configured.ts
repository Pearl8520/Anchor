import { Request, Response, NextFunction } from "express";
import { isDashboardConfigured } from "../config.js";

/** 503s instead of crashing on a missing env var — mount on every dashboard-only router. */
export function requireDashboardConfigured(req: Request, res: Response, next: NextFunction): void {
    if (!isDashboardConfigured()) {
        res.status(503).json({ error: 'The dashboard is not configured on this server yet.' });
        return;
    }
    next();
}
