import { ChannelType } from "discord.js";
import { Router } from "express";
import { ConnectionClient } from "../core/client.js";
import { database } from "../core/database.js";
import { requireAuth } from "../middleware/require-auth.js";
import { requireDashboardConfigured } from "../middleware/require-dashboard-configured.js";
import { requireGuildAccess } from "../middleware/require-guild-access.js";
import { canManageGuild, isGuildAdministrator } from "../services/core/discord-oauth.js";
import { resolveUserGuilds } from "../services/core/guild-session.js";
import { ModmailBlockSchema, ModmailSettingsPatchSchema, ModmailCategoryCreateSchema, ModmailCategoryPatchSchema } from "../schemas/modmail-schema.js";
import { closeModmailThread } from "../services/modmail/modmail-relay.js";
import { slugify } from "../services/modmail/modmail-config.js";

export function createGuildRouter(client: ConnectionClient): Router {
    const router = Router();
    router.use(requireDashboardConfigured);
    router.use(requireAuth);

    // ─── Guild list / info / channel & role lookups ───────────────────────────

    router.get('/guilds', async (req, res) => {
        res.set('Cache-Control', 'no-store');
        try {
            const session = await database.sessions.fetch(req.user!.sessionId);
            if (!session) {
                res.status(401).json({ error: 'Not authenticated.' });
                return;
            }

            const discordGuilds = await resolveUserGuilds(session);

            const guilds = discordGuilds
                .filter(canManageGuild)
                .filter(g => client.guilds.cache.has(g.id))
                .map(g => ({
                    id: g.id,
                    name: g.name,
                    icon: g.icon,
                    isAdministrator: isGuildAdministrator(g)
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            res.json({ guilds });
        } catch {
            res.status(502).json({ error: 'Could not reach Discord. Please try again.' });
        }
    });

    router.get('/guilds/:guildId', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const guild = client.guilds.cache.get(req.params.guildId)!;
        res.json({ id: guild.id, name: guild.name, icon: guild.icon });
    });

    router.get('/guilds/:guildId/channels', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const guild = client.guilds.cache.get(req.params.guildId)!;
        const channels = guild.channels.cache
            .filter(c => c.type === ChannelType.GuildText || c.type === ChannelType.GuildAnnouncement)
            .map(c => ({ id: c.id, name: c.name, position: 'position' in c ? c.position : 0 }))
            .sort((a, b) => a.position - b.position)
            .map(({ id, name }) => ({ id, name }));
        res.json({ channels });
    });

    router.get('/guilds/:guildId/roles', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const guild = client.guilds.cache.get(req.params.guildId)!;
        const roles = guild.roles.cache
            .filter(r => r.id !== guild.id)
            .map(r => ({ id: r.id, name: r.name, position: r.position }))
            .sort((a, b) => b.position - a.position)
            .map(({ id, name }) => ({ id, name }));
        res.json({ roles });
    });

    // ─── Modmail (config + block-list + transcript search) ───────────────────────
    // Server-scoped only — a guild's dashboard never exposes another guild's Modmail data. In a
    // dedicated-mail-server setup, settings/categories/threads all live keyed by the *mail* guild's own
    // id — every route resolves via fetchForActingGuild so viewing from either the mail server's own
    // dashboard or its linked main server's dashboard both work, block-list/transcripts included.

    router.get('/guilds/:guildId/modmail/settings', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        // Always the same shape regardless of configured status — the frontend expects categories/
        // staffRoleIds/etc. to exist even on a brand-new server with nothing set up yet.
        if (!settings) {
            return void res.json({
                configured: false,
                isMailServer: true,
                mailGuildId: null,
                enabled: false,
                linkedGuildId: null,
                staffRoleIds: [],
                pingOnUserReply: true,
                categories: []
            });
        }

        res.json({
            configured: true,
            isMailServer: settings.guildId === req.params.guildId,
            mailGuildId: settings.guildId,
            enabled: settings.enabled,
            linkedGuildId: settings.linkedGuildId,
            staffRoleIds: settings.staffRoleIds,
            pingOnUserReply: settings.pingOnUserReply,
            categories: settings.categories
        });
    });

    router.patch('/guilds/:guildId/modmail/settings', requireGuildAccess(client), async (req, res) => {
        const parsed = ModmailSettingsPatchSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid payload.', details: parsed.error.flatten().fieldErrors });
            return;
        }

        const { guildId } = req.params;
        const settings = await database.modmailSettings.fetchOrCreate(guildId);
        // Editing config is only meaningful from the mail server itself (or the solo guild) — its
        // channel/role pickers are scoped to whichever guild the dashboard is currently viewing, and a
        // patch applied from the wrong side would silently create a second, unrelated settings doc.
        if (settings.guildId !== guildId) {
            res.status(400).json({ error: `Modmail is configured from a different server (ID ${settings.guildId}) — edit settings from that server's dashboard.` });
            return;
        }

        if (parsed.data.enabled !== undefined) await database.modmailSettings.setEnabled(guildId, parsed.data.enabled);
        if (parsed.data.staffRoleIds !== undefined) await database.modmailSettings.setStaffRoles(guildId, parsed.data.staffRoleIds);
        if (parsed.data.pingOnUserReply !== undefined) await database.modmailSettings.setPingOnUserReply(guildId, parsed.data.pingOnUserReply);

        if (parsed.data.linkedGuildId !== undefined) {
            const newLinkedGuildId = parsed.data.linkedGuildId;
            if (newLinkedGuildId !== null) {
                if (newLinkedGuildId === guildId) {
                    res.status(400).json({ error: "That's this same server — no need to link it to itself." });
                    return;
                }
                if (!client.guilds.cache.has(newLinkedGuildId)) {
                    res.status(400).json({ error: "The bot isn't in a server with that ID — make sure it's been invited there first." });
                    return;
                }
                const alreadyLinked = await database.modmailSettings.fetchByLinkedGuildId(newLinkedGuildId);
                if (alreadyLinked && alreadyLinked.guildId !== guildId) {
                    res.status(400).json({ error: 'That server is already linked as the main server for a different mail server.' });
                    return;
                }
            }
            await database.modmailSettings.setLinkedGuild(guildId, newLinkedGuildId);
        }

        const updated = await database.modmailSettings.fetch(guildId);
        res.json({
            configured: true,
            isMailServer: true,
            mailGuildId: updated!.guildId,
            enabled: updated!.enabled,
            linkedGuildId: updated!.linkedGuildId,
            staffRoleIds: updated!.staffRoleIds,
            pingOnUserReply: updated!.pingOnUserReply,
            categories: updated!.categories
        });
    });

    router.post('/guilds/:guildId/modmail/categories', requireGuildAccess(client), async (req, res) => {
        const parsed = ModmailCategoryCreateSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid payload.', details: parsed.error.flatten().fieldErrors });
            return;
        }

        const { guildId } = req.params;
        const settings = await database.modmailSettings.fetchOrCreate(guildId);
        if (settings.guildId !== guildId) {
            res.status(400).json({ error: `Modmail is configured from a different server (ID ${settings.guildId}) — add categories from that server's dashboard.` });
            return;
        }

        const key = slugify(parsed.data.name);
        if (settings.categories.some(c => c.key === key)) {
            res.status(400).json({ error: 'A category with that name already exists.' });
            return;
        }

        await database.modmailSettings.addCategory(guildId, { key, label: parsed.data.name, parentChannelId: parsed.data.parentChannelId });
        const updated = await database.modmailSettings.fetch(guildId);
        res.json({ categories: updated!.categories });
    });

    router.delete('/guilds/:guildId/modmail/categories/:key', requireGuildAccess(client), async (req, res) => {
        const { guildId, key } = req.params;
        const settings = await database.modmailSettings.fetch(guildId);
        if (settings && settings.guildId !== guildId) {
            res.status(400).json({ error: `Modmail is configured from a different server (ID ${settings.guildId}) — remove categories from that server's dashboard.` });
            return;
        }

        await database.modmailSettings.removeCategory(guildId, key);
        const updated = await database.modmailSettings.fetch(guildId);
        res.json({ categories: updated?.categories ?? [] });
    });

    router.patch('/guilds/:guildId/modmail/categories/:key', requireGuildAccess(client), async (req, res) => {
        const parsed = ModmailCategoryPatchSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid payload.', details: parsed.error.flatten().fieldErrors });
            return;
        }

        const { guildId, key } = req.params;
        const settings = await database.modmailSettings.fetch(guildId);
        if (!settings || settings.guildId !== guildId) {
            res.status(400).json({ error: settings ? `Modmail is configured from a different server (ID ${settings.guildId}).` : 'Modmail has not been set up here.' });
            return;
        }
        if (!settings.categories.some(c => c.key === key)) {
            res.status(404).json({ error: 'No category with that key exists.' });
            return;
        }

        if (parsed.data.label !== undefined) {
            await database.modmailSettings.setCategoryLabel(guildId, key, parsed.data.label);
        }
        if (parsed.data.transcriptChannelId !== undefined) {
            await database.modmailSettings.setCategoryTranscriptChannel(guildId, key, parsed.data.transcriptChannelId);
        }
        if (parsed.data.staffRoleIds !== undefined) {
            await database.modmailSettings.setCategoryStaffRoles(guildId, key, parsed.data.staffRoleIds);
        }

        const updated = await database.modmailSettings.fetch(guildId);
        res.json({ categories: updated!.categories });
    });

    router.get('/guilds/:guildId/modmail/blocked', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        if (!settings) return void res.json({ blocked: [] });

        const blocks = await database.modmailBlocks.fetchAll(settings.guildId);
        res.json({ blocked: blocks.map(b => ({ userId: b.userId, username: client.users.cache.get(b.userId)?.username ?? null, blockedBy: b.blockedBy, reason: b.reason, createdAt: b.createdAt })) });
    });

    router.post('/guilds/:guildId/modmail/blocked', requireGuildAccess(client), async (req, res) => {
        const parsed = ModmailBlockSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid payload.', details: parsed.error.flatten().fieldErrors });
            return;
        }

        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        if (!settings) {
            res.status(400).json({ error: 'Modmail has not been set up here.' });
            return;
        }

        await database.modmailBlocks.block(settings.guildId, parsed.data.userId, req.user!.userId, parsed.data.reason ?? null);

        const openThread = await database.modmailThreads.fetchOpenForUserInGuild(settings.guildId, parsed.data.userId);
        if (openThread) {
            const guild = client.guilds.cache.get(settings.guildId);
            const threadChannel = guild ? await guild.channels.fetch(openThread.channelId).catch(() => null) : null;
            if (threadChannel?.isThread()) {
                await closeModmailThread(guild!, openThread, threadChannel, 'Blocked from Modmail.', `<@${req.user!.userId}>`);
            }
        }

        res.json({ success: true });
    });

    router.delete('/guilds/:guildId/modmail/blocked/:userId', requireGuildAccess(client), async (req, res) => {
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        if (!settings) return void res.json({ success: true });
        await database.modmailBlocks.unblock(settings.guildId, req.params.userId);
        res.json({ success: true });
    });

    router.get('/guilds/:guildId/modmail/threads', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        if (!settings) return void res.json({ threads: [] });

        const threads = await database.modmailThreads.fetchClosedForGuild(settings.guildId);
        res.json({
            threads: threads.map(t => ({
                id: t.id,
                threadNumber: t.threadNumber,
                userId: t.userId,
                username: t.username ?? client.users.cache.get(t.userId)?.username ?? null,
                categoryKey: t.categoryKey,
                categoryLabel: settings.categories.find(c => c.key === t.categoryKey)?.label ?? t.categoryKey,
                createdAt: t.createdAt,
                closedAt: t.closedAt
            }))
        });
    });

    router.get('/guilds/:guildId/modmail/threads/:threadId/messages', requireGuildAccess(client), async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        const thread = await database.modmailThreads.fetch(req.params.threadId);
        if (!thread || !settings || thread.guildId !== settings.guildId) {
            res.status(404).json({ error: 'Thread not found in this server.' });
            return;
        }

        const messages = await database.modmailMessages.fetchByThread(thread.id);
        res.json({
            messages: messages.map(m => ({ direction: m.direction, authorId: m.authorId, body: m.body, attachmentUrls: m.attachmentUrls, createdAt: m.createdAt }))
        });
    });

    router.delete('/guilds/:guildId/modmail/threads/:threadId', requireGuildAccess(client), async (req, res) => {
        const settings = await database.modmailSettings.fetchForActingGuild(req.params.guildId);
        const thread = await database.modmailThreads.fetch(req.params.threadId);
        if (!thread || !settings || thread.guildId !== settings.guildId) {
            res.status(404).json({ error: 'Thread not found in this server.' });
            return;
        }
        // Only closed threads — deleting an active conversation this way would be a real footgun.
        if (thread.status !== 'closed') {
            res.status(400).json({ error: 'Only closed threads can be deleted — close it first.' });
            return;
        }

        await database.modmailMessages.deleteByThread(thread.id);
        await database.modmailThreads.deleteThread(thread.id);
        res.json({ success: true });
    });

    return router;
}
