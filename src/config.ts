function getEnvVar(key: string): string {
    const secret = process.env[key];
    if (!secret) throw new Error('Unknown Environment variable ' + key);

    return secret;
}

/** Unlike getEnvVar, missing values don't crash the bot — used for optional dashboard config. */
function getOptionalEnvVar(key: string): string | null {
    return process.env[key] || null;
}

export const config = {
    ownerId: getEnvVar('OWNER_ID'),
    devId: getEnvVar('DEV_ID'),
    alertChannelId: getEnvVar('ALERT_CHANNEL_ID'),
    logToFile: true,
    logPath: './app.log'
} as const;

export const env = {
    CLIENT_TOKEN: getEnvVar('CLIENT_TOKEN'),
    MONGO_URI: getEnvVar('MONGO_URI'),
    MONGO_DB: getEnvVar('MONGO_DB'),
};

/** Dashboard/OAuth config — the dashboard's whole purpose here, so required (a larger bot embedding this module might treat it as optional instead, being just one of many modules). */
export const dashboardEnv = {
    DISCORD_CLIENT_ID: getEnvVar('DISCORD_CLIENT_ID'),
    DISCORD_CLIENT_SECRET: getEnvVar('DISCORD_CLIENT_SECRET'),
    DISCORD_REDIRECT_URI: getEnvVar('DISCORD_REDIRECT_URI'),
    SESSION_COOKIE_SECRET: getEnvVar('SESSION_COOKIE_SECRET'),
    DASHBOARD_URL: getEnvVar('DASHBOARD_URL'),
};

/** Kept for parity with a larger host bot's own config shape (some shared files reference it) — always true here since dashboardEnv is required, not optional. */
export function isDashboardConfigured(): boolean {
    return Object.values(dashboardEnv).every(v => v !== null);
}

export function getPort(): number {
    return Number(getOptionalEnvVar('PORT') ?? 8051);
}

/** Path to a pre-migration Dragory/modmailbot SQLite database — read-only, only used to keep old
 * /logs/:threadId links viewable. Optional: if unset, that route just 404s instead of the bot failing
 * to start. */
export function getLegacyLogDbPath(): string | null {
    return getOptionalEnvVar('LEGACY_LOG_DB_PATH');
}
