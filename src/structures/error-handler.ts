import { Colors, DiscordAPIError, DiscordjsError, EmbedBuilder, MessageFlags, TextChannel } from "discord.js";
import { Logger } from "./logger.js";
import client from "../core/client.js";
import { config } from "../config.js";
import { InGuildChatInputInteraction } from "../types/discord.js";

interface HandlerOptions {
    context?: string;
    emitAlert?: boolean;
    killProcess?: boolean;
}

export class ErrorHandler {
    static async handle(err: DiscordAPIError | DiscordjsError | Error | unknown, data: HandlerOptions = {}) {
        if (!(err instanceof Error)) {
            return Logger.warn(
                data.context || 'Uncaught',
                'Non-Error thrown: ' + (typeof err === 'object' ? JSON.stringify(err) : String(err))
            );
        }

        Logger.error(
            data.context || 'Uncaught',
            `${err.message}`,
            err
        );

        if (data.emitAlert) await this.emitAlert(err);
        if (data.killProcess) {
            await Logger.stopLogger();
            process.exit();
        }
    }

    /** Defers the reply, runs `handler`, and on failure logs the error and edits the reply with a generic message. */
    static async wrap(interaction: InGuildChatInputInteraction, context: string, handler: () => Promise<unknown>, options: { ephemeral?: boolean } = {}): Promise<void> {
        await interaction.deferReply(options.ephemeral ? { flags: MessageFlags.Ephemeral } : undefined);
        try {
            await handler();
        } catch (err) {
            await this.handle(err, { context, emitAlert: true });
            await interaction.editReply({ content: 'An error has occurred.' });
        }
    }

    private static async emitAlert(err: Error) {
        if (!config.alertChannelId) return Logger.warn('Alert failed', 'Alert channel has not been configured.');

        const alertChannel = client.channels.cache.get(config.alertChannelId);
        if (!alertChannel?.isTextBased()) {
            return Logger.warn('Alert failed', 'Alert channel missing or not text-based.');
        }

        const embed = new EmbedBuilder()
            .setTitle('Alert')
            .setColor(Colors.DarkRed)
            .setDescription(
                `[${err.name}] - ${err.message}`);
        (alertChannel as TextChannel).send({ embeds: [embed] }).catch(err => Logger.error('Alert failed', err.message, err));
    }
}