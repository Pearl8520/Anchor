// ─── Modmail (per-server feature, backend + live wiring) ──────────────────────
// Kept in its own file (rather than inline in database.ts) so the whole Modmail module — this file,
// src/services/modmail/*, the modmail-* managers, commands, schema, task, and website component — stays
// a clean, self-contained unit that can be dropped into another bot on its own.

export interface IModmailCategory {
    key: string;
    label: string;
    parentChannelId: string; // its own channel — threads for this category spawn under here
    transcriptChannelId: string | null; // where a closed thread in this category auto-posts its transcript, if set
    attachmentLogChannelId?: string | null; // where every attachment sent in this category's threads (either direction) also gets forwarded, if set
    staffRoleIds: string[]; // roles specific to this category (e.g. "Event Team") — ADDED to the guild-wide staffRoleIds, not a replacement, so a global "sees everything" role still works alongside per-category teams
}

export interface IRawModmailSettings {
    guildId: string;             // the guild Modmail is configured from — the dedicated mail/staff server if one is linked, otherwise this single guild serves as both
    linkedGuildId: string | null; // the separate main/community guild, if a dedicated mail server is set up (users are members here, not of guildId); null = solo mode, guildId is both
    enabled: boolean;
    staffRoleIds: string[];      // role IDs in `guildId` (the mail server, or the solo guild) — apply to every category
    pingOnUserReply: boolean;   // whether staff roles get re-pinged in-thread on every follow-up DM the user sends, not just at thread creation
    reminderEnabled?: boolean;       // opt-in — the unanswered-thread reminder sweep skips this guild entirely unless true
    reminderThresholdHours?: number; // hours an open thread can sit with the last message from the user before a reminder fires; only meaningful when reminderEnabled
    categories: IModmailCategory[]; // parentChannelId channels live in `guildId`
    panelChannelId: string | null; // informational — where the ticket panel was last posted (lives in `linkedGuildId` if set, else `guildId`)
    panelMessageId: string | null; // the panel message itself — re-posting to the same channel edits this message in place instead of duplicating it
}

export type ModmailThreadStatus = 'open' | 'closed';

export interface IRawModmailThread {
    id: string;
    guildId: string;
    userId: string;
    channelId: string;        // the private thread's id
    categoryKey: string;
    threadNumber: number;      // per-guild incrementing human-friendly number
    status: ModmailThreadStatus;
    claimedBy: string | null;  // staff userId currently handling this thread — advisory, not a hard access gate
    createdAt: number;
    closedAt: number | null;
    lastMessageDirection?: 'from-user' | 'to-user' | null; // used by the unanswered-thread reminder — only set/read there
    lastMessageAt?: number | null;
    reminderSentAt?: number | null; // cleared whenever a new from-user message lands, so a later message can trigger a fresh reminder
    username?: string | null; // snapshot at creation time — mainly for migrated legacy threads, whose user may no longer be cached/resolvable live
    suspended?: boolean; // pauses relay both ways without closing/archiving the thread — orthogonal to status (a suspended thread is still 'open' for duplicate-thread-prevention purposes), toggled via /mail action:Suspend|Unsuspend
    logToken?: string | null; // long UUID (crypto.randomUUID()) used in the public /logs/:id link — separate from the short internal `id` so that isn't what's exposed publicly. Generated at thread creation for new threads; lazily generated+persisted on first Log Link use for older threads that predate this field.
}

export type ModmailMessageDirection = 'from-user' | 'to-user' | 'staff-chat' | 'system';

export interface IRawModmailMessage {
    id: string;
    modmailThreadId: string;
    direction: ModmailMessageDirection;
    authorId: string;
    body: string;
    dmMessageId: string | null;     // set for from-user/to-user — the DM-side message id
    relayMessageId: string | null;  // set for from-user/to-user/staff-chat — the thread-side message id
    attachmentUrls: string[];
    createdAt: number;
    messageNumber?: number | null;  // to-user only — per-thread sequential number staff reference to edit their own reply
    displayName?: string | null;    // to-user only — the identity shown when sent, reused verbatim on edit so it can't drift if the staffer's role config changes later
}

/** A staff member's preferred display identity for non-anonymous replies in a given guild — set via /mail-role. roleId: null means "use the default (highest configured staff role the member currently holds)". */
export interface IRawModmailStaffDisplay {
    guildId: string;
    userId: string;
    roleId: string | null;
}

export interface IRawModmailSnippet {
    guildId: string;
    trigger: string;
    body: string;
    createdBy: string;
    createdAt: number;
}

/** A user blocked from opening new Modmail threads in a guild — reason is staff-only, never shown to the blocked user. */
export interface IRawModmailBlock {
    guildId: string;
    userId: string;
    blockedBy: string;
    reason: string | null;
    createdAt: number;
}
