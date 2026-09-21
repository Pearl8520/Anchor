export interface IRawSession {
    id: string;
    userId: string;
    username: string;
    avatar: string | null;
    discordAccessToken: string;
    discordRefreshToken: string;
    discordTokenExpiresAt: number;
    guildsCache?: {
        data: { id: string; name: string; icon: string | null; owner: boolean; permissions: string }[];
        cachedAt: number;
    };
    createdAt: number;
    expiresAt: Date;
}

// ─── Modmail ────────────────────────────────────────────────────────────────
// imports elsewhere in this codebase don't need to change.
export * from "./modmail-database.js";
