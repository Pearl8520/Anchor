import { Client, ThreadChannel } from "discord.js";
import { database } from "../core/database.js";
import { ErrorHandler } from "../structures/error-handler.js";
import { resolveEffectiveStaffRoleIds } from "../services/modmail/modmail-intake.js";

const CHECK_INTERVAL_MS = 15 * 60 * 1000; // the threshold is hours-scale — 15 minutes is precise enough without being wasteful
const INITIAL_RUN_DELAY_MS = 5 * 60 * 1000; // let other boot-time work (stats, guild seeding) clear first

let timer: NodeJS.Timeout | null = null;

async function checkUnansweredThreads(client: Client): Promise<void> {
    // Opt-in and per-guild-configurable threshold (default 24h once turned on) — this used to be one
    // hardcoded 4h cutoff applied to every guild's threads at once with no way to turn it off.
    const enabledSettings = await database.modmailSettings.fetchAllEnabled();
    const remindersEnabledSettings = enabledSettings.filter(s => s.reminderEnabled);

    for (const settings of remindersEnabledSettings) {
        const thresholdMs = (settings.reminderThresholdHours ?? 24) * 60 * 60 * 1000;
        const threads = await database.modmailThreads.fetchUnansweredOpenThreads(settings.guildId, Date.now() - thresholdMs);

        for (const thread of threads) {
            try {
                const guild = client.guilds.cache.get(thread.guildId);
                if (!guild) continue;

                const threadChannel = await guild.channels.fetch(thread.channelId).catch(() => null);
                if (!threadChannel || !(threadChannel instanceof ThreadChannel)) continue;

                const effectiveStaffRoleIds = resolveEffectiveStaffRoleIds(settings, thread.categoryKey);
                const pingContent = effectiveStaffRoleIds.map(id => `<@&${id}>`).join(' ');

                const hoursWaiting = Math.round((Date.now() - (thread.lastMessageAt ?? thread.createdAt)) / (60 * 60 * 1000));
                // The client sets allowedMentions: { parse: [] } globally, so without this override the role
                // mention above would render as plain text and never actually notify/highlight anyone.
                await threadChannel.send({ content: `${pingContent ? pingContent + ' ' : ''}⏰ This thread has been waiting ${hoursWaiting} hour(s) for a reply.`, allowedMentions: { roles: effectiveStaffRoleIds } }).catch(() => null);

                await database.modmailThreads.update(thread.id, { reminderSentAt: Date.now() });
            } catch (err) {
                ErrorHandler.handle(err, { context: `modmail-reminder-task (thread ${thread.id})`, emitAlert: false });
            }
        }
    }
}

/** Periodically pings staff again on Modmail threads that have gone unanswered too long, for guilds that have opted in (`reminderEnabled`) — see ModmailThreadManager.fetchUnansweredOpenThreads for the exact eligibility criteria (fires once per pending message, resets whenever a new user message or staff reply lands). */
export function startModmailReminderTask(client: Client): void {
    if (timer) return;
    setTimeout(() => {
        checkUnansweredThreads(client).catch(err => ErrorHandler.handle(err, { context: 'modmail-reminder-task', emitAlert: false }));
    }, INITIAL_RUN_DELAY_MS);
    timer = setInterval(() => {
        checkUnansweredThreads(client).catch(err => ErrorHandler.handle(err, { context: 'modmail-reminder-task', emitAlert: false }));
    }, CHECK_INTERVAL_MS);
}
