import { Interaction, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder, SlashCommandSubcommandsOnlyBuilder } from "discord.js";

export type ISlashCommandOptions = {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
    position?: number;
    execute(this: InteractionCommand, interaction: Interaction): void;
}

export class InteractionCommand {
    data: SlashCommandBuilder | SlashCommandOptionsOnlyBuilder | SlashCommandSubcommandsOnlyBuilder;
    category: string | null = null;
    position: number = 9999;
    private _execute: ((this: InteractionCommand, interaction: Interaction) => void);

    constructor({ data, position, execute }: ISlashCommandOptions) {
        this.data = data;
        this.position = position || this.position;
        this._execute = execute
    }

    public execute(interaction: Interaction<'cached' | 'raw'>) {
        this._execute(interaction);
    }

    /**
 * Get the name of the command capitalized
 * @returns 
 */
    capitalizeName() {
        return this.data.name[0].toUpperCase() + this.data.name.slice(1);
    }
    /**
     * Set the category of this command
     * @param name 
     */
    setCategory(name: string) {
        this.category = name;
    }

    /**
     * Get the command usage in a code block format
     * @returns 
     */
    formatUsage(): string {
        return `\`${this.data.description}\``;
    }
}