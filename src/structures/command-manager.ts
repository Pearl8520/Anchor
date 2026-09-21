import { Collection } from "discord.js";
import { InteractionCommand } from "./command.js";
import { Emotes } from "../utils/util.js";

/**
 * Used to filter categories displayed based on the user's authority
 */
export enum CategoryPermission {
    misc = 0,
    moderator,
    admin,
}

enum CategoryOrder {
    misc,
    moderator,
    admin,
}

export const EmoteToCategoryMap: Record<string, string> = {
    admin: Emotes.Woke,
    moderator: Emotes.Cool,
    misc: Emotes.Wat
};

export class CommandManager {
    private categories: Collection<string, Set<string>> = new Collection();
    private commands: Collection<string, InteractionCommand> = new Collection();

    /**
     * Add a command to the manager
     * @param command 
     */
    addCommand(command: InteractionCommand) {
        this.commands.set(command.data.name, command);

        if (command.category) {
            if (!this.categories.has(command.category)) {
                this.categories.set(command.category, new Set([command.data.name]));
            } else {
                this.categories.get(command.category)!.add(command.data.name);
            }
        }
    }

    /**
     * Retrieve a command by its name
     * @param name 
     * @returns 
     */
    getCommand(name: string) {
        return this.commands.get(name);
    }

    /**
     * Retrieve all the commands
     * @returns 
     */
    getCommands() {
        return this.commands;
    }

    /**
     * Whether the command exists
     * @param name 
     * @returns 
     */
    resolveCommand(name: string) {
        return !!this.getCommand(name);
    }

    /**
     * Get a list of this manager's categories
     * @returns 
     */
    getCategories() {
        return this.categories.sort((_, __, a, b) =>
            CategoryOrder[a as keyof typeof CategoryOrder] -
            CategoryOrder[b as keyof typeof CategoryOrder]
        );
    }

    /**
     * Get the name the categories in a format
     * @param format 
     * @returns 
     */
    getCategoriesName(format?: 'original' | 'capitalized' | 'upper' | 'lower'): string[] {
        const keys = [...this.categories.keys()];
        switch (format) {
            case 'capitalized': return keys.map(c => c[0].toUpperCase() + c.slice(1));
            case 'upper': return keys.map(c => c.toUpperCase());
            case 'lower': return keys.map(c => c.toLowerCase());
            default: return keys;
        }
    }

    /**
     * Get all the commands of a category
     * @param category the target category
     * @param filter optional filter to apply
     * @returns 
     */
    getCategoryCommands(category: string, filter?: (command: InteractionCommand) => boolean): InteractionCommand[] | null {
        const targetCategory = this.categories.get(category.toLowerCase());
        if (!targetCategory) return null;

        const commands = [...targetCategory.values()].map(c => this.commands.get(c)!);
        return (filter ? commands.filter(filter) : commands).sort((cmdOne, cmdTwo) => cmdOne.position - cmdTwo.position);
    }

    /**
     * Get a list of the categories and the number of commands they have
     * @returns 
     */
    getCategoriesCommandCount() {
        return this.categories.map((commands, category) => [category, commands.size])
    }

}