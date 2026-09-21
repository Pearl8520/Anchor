import { Client, Events, GatewayIntentBits, Partials, REST, Routes } from "discord.js";
import { readdir } from "fs/promises";
import { database } from "./database.js";
import { InteractionCommand } from "../structures/command.js";
import path from 'path';
import { pathToFileURL } from 'url';
import { Logger } from "../structures/logger.js";
import { ErrorHandler } from "../structures/error-handler.js";
import { CommandManager } from "../structures/command-manager.js";
import { ClientEvent } from "../structures/event.js";
import { startModmailReminderTask } from "../tasks/modmail-reminder-task.js";


export class ConnectionClient extends Client<true> {
    commands = new CommandManager();

    constructor() {
        super({
            intents: [
                GatewayIntentBits.Guilds,
                GatewayIntentBits.GuildMessages,
                GatewayIntentBits.MessageContent,
                GatewayIntentBits.GuildMembers,
                GatewayIntentBits.DirectMessages,
                GatewayIntentBits.DirectMessageReactions,
                GatewayIntentBits.GuildMessageTyping,
                GatewayIntentBits.DirectMessageTyping
            ],
            partials: [
                Partials.Message,
                Partials.Channel,
                Partials.User,
                Partials.GuildMember
            ],
            allowedMentions: { parse: [], repliedUser: true },
        });

        this.on(Events.ClientReady, async () => {
            Logger.log('Connected to Discord.');

            await database.connect();
            Logger.log('Connected to the database.');

            await this.registerCommands(path.resolve(process.cwd(), 'dist', 'commands'));
            Logger.log('Loaded commands.');

            await this.registerEvents(path.resolve(process.cwd(), 'dist', 'events'));
            Logger.log('Loaded events.');

            startModmailReminderTask(this);
            Logger.log('Ready!');
        })
    }

    async connect() {
        await this.login(process.env.CLIENT_TOKEN);
    };

    async importFile(filePath: string) {
        try {
            const module = await import(pathToFileURL(filePath).href);
            return module.default?.default || module.default || null;
        }
        catch (err) {
            ErrorHandler.handle(err, { context: 'client importFile', emitAlert: true });
        }
    }

    private async registerCommands(dirPath: string): Promise<void> {
        await this._registerCommands(dirPath);

        const interactionCommands = Array.from(this.commands.getCommands().values(), (command) => command.data.toJSON());
        const rest = new REST().setToken(this.token);

        await rest.put(Routes.applicationCommands(this.user.id), { body: interactionCommands })
            .catch(err => ErrorHandler.handle(err, { context: 'client' }));
    }

    private async _registerCommands(dirPath: string): Promise<void> {
        const commandDir = await readdir(dirPath, { withFileTypes: true });

        for (const file of commandDir) {
            const fullPath = path.join(dirPath, file.name);

            if (file.isDirectory()) {
                await this._registerCommands(fullPath)
            }
            else {
                const command = await this.importFile(fullPath);
                if (!command) continue;
                if (!(command instanceof InteractionCommand)) continue;

                command.setCategory(path.basename(path.dirname(fullPath)));
                this.commands.addCommand(command);
            }
        }
    }

    private async registerEvents(dirPath: string): Promise<void> {
        const eventsDir = await readdir(dirPath, { withFileTypes: true });

        for (const file of eventsDir) {
            const fullPath = path.join(dirPath, file.name);

            if (file.isDirectory()) {
                await this.registerEvents(fullPath)
            }
            else {
                const event = await this.importFile(fullPath);
                if (!event) continue;
                if (!(event instanceof ClientEvent)) continue;

                this.on(event.event, event.run);
            }
        }
    }
};

const client = new ConnectionClient();
export default client;
