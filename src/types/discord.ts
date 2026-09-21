import { ChatInputCommandInteraction } from "discord.js";

/** A slash command interaction guaranteed to be in a cached guild (member/guild data available). */
export type InGuildChatInputInteraction = ChatInputCommandInteraction<'cached'>;
