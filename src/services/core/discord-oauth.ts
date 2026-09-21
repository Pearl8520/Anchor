import axios from 'axios';
import { dashboardEnv } from '../../config.js';

const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    token_type: string;
    scope: string;
}

export interface DiscordUser {
    id: string;
    username: string;
    avatar: string | null;
}

export interface DiscordPartialGuild {
    id: string;
    name: string;
    icon: string | null;
    owner: boolean;
    permissions: string;
}

const ADMINISTRATOR = 0x8n;
const MANAGE_GUILD = 0x20n;

export function buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
        client_id: dashboardEnv.DISCORD_CLIENT_ID!,
        redirect_uri: dashboardEnv.DISCORD_REDIRECT_URI!,
        response_type: 'code',
        scope: 'identify guilds',
        state
    });
    return `https://discord.com/api/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCode(code: string): Promise<DiscordTokenResponse> {
    const res = await axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({
        client_id: dashboardEnv.DISCORD_CLIENT_ID!,
        client_secret: dashboardEnv.DISCORD_CLIENT_SECRET!,
        grant_type: 'authorization_code',
        code,
        redirect_uri: dashboardEnv.DISCORD_REDIRECT_URI!
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return res.data;
}

export async function refreshAccessToken(refreshToken: string): Promise<DiscordTokenResponse> {
    const res = await axios.post(`${DISCORD_API}/oauth2/token`, new URLSearchParams({
        client_id: dashboardEnv.DISCORD_CLIENT_ID!,
        client_secret: dashboardEnv.DISCORD_CLIENT_SECRET!,
        grant_type: 'refresh_token',
        refresh_token: refreshToken
    }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    return res.data;
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
    const res = await axios.get(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.data;
}

export async function fetchUserGuilds(accessToken: string): Promise<DiscordPartialGuild[]> {
    const res = await axios.get(`${DISCORD_API}/users/@me/guilds`, { headers: { Authorization: `Bearer ${accessToken}` } });
    return res.data;
}

/** Owner, Administrator, or Manage Guild — the bar for showing up as a "manageable" server on the dashboard. */
export function canManageGuild(guild: DiscordPartialGuild): boolean {
    if (guild.owner) return true;
    const perms = BigInt(guild.permissions);
    return (perms & ADMINISTRATOR) !== 0n || (perms & MANAGE_GUILD) !== 0n;
}

/** Owner or Administrator specifically — the bar slash commands like /starboard already require. */
export function isGuildAdministrator(guild: DiscordPartialGuild): boolean {
    if (guild.owner) return true;
    return (BigInt(guild.permissions) & ADMINISTRATOR) !== 0n;
}
