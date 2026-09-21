import { Express } from "express";
import { Client, ThreadChannel } from "discord.js";
import Database from "better-sqlite3";
import { getLegacyLogDbPath } from "../config";
import { database } from "../core/database.js";
import { IRawModmailMessage, IRawModmailThread } from "../types/database.js";
import { backfillThreadChatHistory } from "../services/modmail/modmail-actions.js";

// Also serves the SAME /logs/:threadId URL for CURRENT (live, MongoDB-backed) threads — /mail
// action:Log Link gives staff this exact link for a live thread. Legacy IDs are small
// integers-as-strings from the old Dragory schema; live thread IDs are opaque nanoid(12) strings, so
// there's no real collision risk in trying the legacy DB first and falling back to Mongo.

const THREAD_STATUS: Record<number, string> = { 1: 'Open', 2: 'Closed', 3: 'Suspended' };

const MESSAGE_TYPE = {
    SYSTEM: 1, CHAT: 2, FROM_USER: 3, TO_USER: 4, LEGACY: 5, COMMAND: 6, SYSTEM_TO_USER: 7, REPLY_EDITED: 8, REPLY_DELETED: 9
} as const;

interface LegacyThread {
    id: string;
    status: number;
    user_id: string;
    user_name: string;
    created_at: string;
    thread_number: number | null;
}

interface LegacyMessage {
    message_type: number;
    user_id: string | null;
    user_name: string;
    role_name: string | null;
    created_at: string;
    current_body: string | null;
    original_body: string | null;
    attachments: string | null;
}

let db: Database.Database | null | undefined; // undefined = not yet attempted, null = attempted and unavailable

function getDb(): Database.Database | null {
    if (db !== undefined) return db;
    const path = getLegacyLogDbPath();
    if (!path) { db = null; return db; }
    try {
        db = new Database(path, { readonly: true, fileMustExist: true });
    } catch (err) {
        console.error('[legacy-log-routes] Failed to open legacy modmailbot database:', err);
        db = null;
    }
    return db;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

const LOG_IMAGE_URL = /\.(png|jpe?g|gif|webp)(\?.*)?$/i;

/** Image URLs render inline; anything else stays a plain clickable link. Shared by both the legacy-SQLite and live-Mongo render paths below. */
function renderAttachments(urls: string[]): string {
    return urls.map(url => LOG_IMAGE_URL.test(url)
        ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener"><img class="log-image" src="${escapeHtml(url)}" loading="lazy"></a>`
        : `<a class="log-attachment" href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`
    ).join('');
}

function speakerLabel(message: LegacyMessage): string {
    switch (message.message_type) {
        case MESSAGE_TYPE.SYSTEM:
        case MESSAGE_TYPE.SYSTEM_TO_USER:
            return 'System';
        case MESSAGE_TYPE.TO_USER:
            return message.role_name || message.user_name || 'Staff';
        case MESSAGE_TYPE.CHAT:
        case MESSAGE_TYPE.COMMAND:
            return `${message.user_name} (internal)`;
        default:
            return message.user_name || 'Unknown';
    }
}

function messageRowClass(message: LegacyMessage): string {
    switch (message.message_type) {
        case MESSAGE_TYPE.SYSTEM:
        case MESSAGE_TYPE.SYSTEM_TO_USER:
            return 'log-row log-row-system';
        case MESSAGE_TYPE.TO_USER:
            return 'log-row log-row-staff';
        case MESSAGE_TYPE.FROM_USER:
            return 'log-row log-row-user';
        case MESSAGE_TYPE.REPLY_EDITED:
        case MESSAGE_TYPE.REPLY_DELETED:
            return 'log-row log-row-meta';
        default:
            return 'log-row log-row-internal';
    }
}

function renderPage(title: string, body: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
    :root { color-scheme: dark; }
    body { background: #17181c; color: #dcddde; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 32px 16px; }
    .log-container { max-width: 760px; margin: 0 auto; }
    h1 { font-size: 1.4rem; margin-bottom: 4px; }
    .log-meta { color: #96989d; font-size: 0.9rem; margin-bottom: 24px; }
    .log-meta span { margin-right: 16px; }
    .log-row { border-left: 3px solid #4A2E8A; background: #202127; border-radius: 4px; padding: 10px 14px; margin-bottom: 8px; }
    .log-row-user { border-left-color: #3ba55d; }
    .log-row-staff { border-left-color: #5865f2; }
    .log-row-system { border-left-color: #96989d; opacity: 0.85; }
    .log-row-internal { border-left-color: #faa61a; opacity: 0.85; }
    .log-row-meta { border-left-color: #ed4245; opacity: 0.7; font-size: 0.85rem; font-style: italic; }
    .log-speaker { font-weight: 600; color: #fff; }
    .log-time { color: #72767d; font-size: 0.78rem; margin-left: 8px; }
    .log-body { white-space: pre-wrap; word-break: break-word; margin-top: 4px; }
    .log-attachment { display: block; color: #00a8fc; font-size: 0.85rem; margin-top: 4px; }
    .log-image { max-width: 400px; max-height: 400px; display: block; margin-top: 6px; border-radius: 4px; }
    .log-empty { color: #72767d; padding: 40px; text-align: center; }
</style>
</head>
<body>
<div class="log-container">
${body}
</div>
</body>
</html>`;
}

function speakerLabelLive(message: IRawModmailMessage, thread: IRawModmailThread): string {
    switch (message.direction) {
        case 'system': return 'System';
        case 'to-user': return message.displayName || 'Staff';
        case 'staff-chat': return `${message.displayName || 'Staff'} (internal)`;
        case 'from-user': return thread.username || 'User';
        default: return 'Unknown';
    }
}

function messageRowClassLive(message: IRawModmailMessage): string {
    switch (message.direction) {
        case 'system': return 'log-row log-row-system';
        case 'to-user': return 'log-row log-row-staff';
        case 'from-user': return 'log-row log-row-user';
        case 'staff-chat': return 'log-row log-row-internal';
        default: return 'log-row log-row-internal';
    }
}

async function renderLiveLog(logToken: string, client: Client, res: import("express").Response): Promise<void> {
    const thread = await database.modmailThreads.fetchByLogToken(logToken);
    if (!thread) { res.status(404).send(renderPage('Not Found', '<div class="log-empty">No thread found with that ID.</div>')); return; }

    // Every view re-syncs from the actual Discord channel first, so opening/refreshing this page alone
    // always shows the complete, current history — same backfill /mail action:Log Link itself runs,
    // just triggered by loading the page instead of the command. A missing/inaccessible channel (e.g. a
    // very old thread whose channel was deleted) just falls back to whatever's already saved.
    try {
        // force: true — a plain cache-first fetch can hand back a stale ThreadChannel for a channel
        // that's since been deleted (closing a thread deletes it), which then 404s one level down when
        // backfill tries to fetch messages from it instead of failing here where it's already handled.
        const channel = await client.channels.fetch(thread.channelId, { force: true }).catch(() => null);
        if (channel instanceof ThreadChannel) await backfillThreadChatHistory(thread, channel);
    } catch (err) {
        console.error('[legacy-log-routes] Live backfill failed:', err);
    }

    const messages = await database.modmailMessages.fetchByThread(thread.id);

    const rows = messages.map(m => {
        const attachmentsHtml = renderAttachments(m.attachmentUrls);
        return `<div class="${messageRowClassLive(m)}">
    <span class="log-speaker">${escapeHtml(speakerLabelLive(m, thread))}</span><span class="log-time">${escapeHtml(new Date(m.createdAt).toISOString())}</span>
    ${m.body ? `<div class="log-body">${escapeHtml(m.body)}</div>` : ''}
    ${attachmentsHtml}
</div>`;
    }).join('\n');

    const statusLabel = thread.status === 'open' ? (thread.suspended ? 'Open (Suspended)' : 'Open') : 'Closed';
    const displayName = thread.username || thread.userId;
    const header = `<h1>Thread #${thread.threadNumber} — ${escapeHtml(displayName)}</h1>
<div class="log-meta"><span>Status: ${statusLabel}</span><span>Opened: ${escapeHtml(new Date(thread.createdAt).toISOString())}</span><span>User ID: ${escapeHtml(thread.userId)}</span></div>`;

    res.send(renderPage(`Thread #${thread.threadNumber} — ${displayName}`, header + (rows || '<div class="log-empty">No messages.</div>')));
}

export function registerLegacyLogRoutes(app: Express, client: Client): void {
    app.get('/logs/:threadId', async (req, res) => {
        const conn = getDb();
        const thread = conn?.prepare('SELECT id, status, user_id, user_name, created_at, thread_number FROM threads WHERE id = ?').get(req.params.threadId) as LegacyThread | undefined;

        if (!thread) return void renderLiveLog(req.params.threadId, client, res);

        const messages = conn!.prepare('SELECT message_type, user_id, user_name, role_name, created_at, current_body, original_body, attachments FROM thread_messages WHERE thread_id = ? ORDER BY id ASC').all(thread.id) as LegacyMessage[];

        const rows = messages.map(m => {
            const body = m.current_body ?? m.original_body ?? '';
            const attachmentUrls: string[] = m.attachments ? JSON.parse(m.attachments) : [];
            const attachmentsHtml = renderAttachments(attachmentUrls);
            return `<div class="${messageRowClass(m)}">
    <span class="log-speaker">${escapeHtml(speakerLabel(m))}</span><span class="log-time">${escapeHtml(m.created_at)}</span>
    ${body ? `<div class="log-body">${escapeHtml(body)}</div>` : ''}
    ${attachmentsHtml}
</div>`;
        }).join('\n');

        const header = `<h1>Thread #${thread.thread_number ?? '?'} — ${escapeHtml(thread.user_name)}</h1>
<div class="log-meta"><span>Status: ${THREAD_STATUS[thread.status] ?? 'Unknown'}</span><span>Opened: ${escapeHtml(thread.created_at)}</span><span>User ID: ${escapeHtml(thread.user_id)}</span></div>`;

        res.send(renderPage(`Thread #${thread.thread_number ?? thread.id} — ${thread.user_name}`, header + (rows || '<div class="log-empty">No messages.</div>')));
    });
}
