import { z } from "zod";

export const ModmailBlockSchema = z.object({
    userId: z.string().min(17),
    reason: z.string().nullable().optional()
}).strict();

export const ModmailSettingsPatchSchema = z.object({
    enabled: z.boolean(),
    staffRoleIds: z.array(z.string().min(17)),
    linkedGuildId: z.string().min(17).nullable(),
    pingOnUserReply: z.boolean(),
    reminderEnabled: z.boolean(),
    reminderThresholdHours: z.number().min(1).max(720)
}).partial().strict();

export const ModmailCategoryCreateSchema = z.object({
    name: z.string().min(1).max(100),
    parentChannelId: z.string().min(17)
}).strict();

export const ModmailCategoryPatchSchema = z.object({
    label: z.string().min(1).max(100),
    transcriptChannelId: z.string().min(17).nullable(),
    attachmentLogChannelId: z.string().min(17).nullable(),
    staffRoleIds: z.array(z.string().min(17))
}).partial().strict();
