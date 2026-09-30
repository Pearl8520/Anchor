import {
    ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelSelectMenuInteraction, ChannelType, EmbedBuilder,
    ModalBuilder, ModalSubmitInteraction, RoleSelectMenuBuilder, RoleSelectMenuInteraction, StringSelectMenuBuilder, StringSelectMenuInteraction,
    TextInputBuilder, TextInputStyle, UserSelectMenuBuilder, UserSelectMenuInteraction, ButtonInteraction
} from "discord.js";
import { Colors } from "../utils/util.js";

/**
 * Small, single-category version of Nihility's /guild-settings wizard engine (see that repo's
 * src/structures/settings-panel/*) — same buttons→modal/select→apply UX, but built just for this bot's
 * one Modmail settings menu instead of a generic multi-category registry. Ported rather than
 * re-invented since the modal-per-field-kind mechanics (Discord modals can only hold text inputs;
 * channel/role/user/choice fields need their own select-component round-trip) are the same regardless
 * of how many categories end up using it.
 */

export type PanelInteraction = ButtonInteraction<'cached'> | StringSelectMenuInteraction<'cached'> | ChannelSelectMenuInteraction<'cached'> | RoleSelectMenuInteraction<'cached'> | UserSelectMenuInteraction<'cached'> | ModalSubmitInteraction<'cached'>;

interface BaseWizardField {
    key: string;
    label: string;
    /** Defaults to true. An optional non-text field gets a Skip button next to its select prompt. */
    required?: boolean;
}

export interface TextWizardField extends BaseWizardField {
    kind: 'text';
    style?: 'short' | 'paragraph';
    placeholder?: string;
}

export interface ChannelWizardField extends BaseWizardField {
    kind: 'channel';
    channelTypes?: ChannelType[];
}

export interface UserWizardField extends BaseWizardField {
    kind: 'user';
}

export interface RoleWizardField extends BaseWizardField {
    kind: 'role';
}

export interface ChoiceWizardField extends BaseWizardField {
    kind: 'choice';
    choices: { label: string; value: string }[];
}

export type WizardField = TextWizardField | ChannelWizardField | UserWizardField | RoleWizardField | ChoiceWizardField;

export type ActionResult = string | { content?: string | null; embeds?: EmbedBuilder[] };

export interface ActionConfig {
    /** Unique across the whole menu — used as the select-menu option value and in the customId grammar. */
    key: string;
    label: string;
    description?: string;
    fields: WizardField[];
    onRun: (interaction: PanelInteraction, values: Record<string, string>) => Promise<ActionResult>;
}

// ─── Session storage (in-memory, short-lived — losing one on a restart just means starting over) ───

interface WizardSession { values: Record<string, string>; startedAt: number; }
const sessions = new Map<string, WizardSession>();
const SESSION_TTL_MS = 10 * 60 * 1000;

function sweepStaleSessions(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [key, session] of sessions) if (session.startedAt < cutoff) sessions.delete(key);
}

function sessionKey(userId: string, actionKey: string): string {
    return `${userId}:${actionKey}`;
}

// ─── Field grouping — consecutive text fields share one modal (Discord caps a modal at 5 inputs); every channel/user/role/choice field gets its own select step ───

export type FieldGroup = { kind: 'text'; fields: TextWizardField[] } | { kind: 'select'; field: ChannelWizardField | UserWizardField | RoleWizardField | ChoiceWizardField };
const MAX_MODAL_INPUTS = 5;

function groupFields(fields: WizardField[]): FieldGroup[] {
    const groups: FieldGroup[] = [];
    for (const f of fields) {
        if (f.kind === 'text') {
            const last = groups[groups.length - 1];
            if (last?.kind === 'text' && last.fields.length < MAX_MODAL_INPUTS) last.fields.push(f);
            else groups.push({ kind: 'text', fields: [f] });
        } else {
            groups.push({ kind: 'select', field: f });
        }
    }
    return groups;
}

function canShowModal(interaction: PanelInteraction): interaction is Exclude<PanelInteraction, ModalSubmitInteraction<'cached'>> {
    return !interaction.isModalSubmit();
}

/** Discord requires a first response within 3 seconds or the interaction token dies — called before any slow work (DB writes, Discord API calls). */
async function deferForWork(interaction: PanelInteraction): Promise<void> {
    if (interaction.deferred || interaction.replied) return;
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
        await interaction.deferReply();
    } else {
        await interaction.deferUpdate();
    }
}

export async function updateOrReply(interaction: PanelInteraction, payload: { content?: string | null; embeds?: EmbedBuilder[]; components?: ActionRowBuilder<any>[] }): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
        return;
    }
    if (interaction.isModalSubmit() && !interaction.isFromMessage()) {
        await interaction.reply({ embeds: payload.embeds, components: payload.components, content: payload.content ?? undefined });
        return;
    }
    await interaction.update(payload);
}

const TIMED_OUT_MESSAGE = 'This wizard timed out — start again from `/modmail-settings`.';

async function showWizardStep(interaction: PanelInteraction, title: string, groups: FieldGroup[], index: number, stepId: (i: number) => string, skipId: (i: number) => string): Promise<void> {
    const group = groups[index];

    if (group.kind === 'text') {
        if (!canShowModal(interaction)) return;
        const modal = new ModalBuilder()
            .setCustomId(`${stepId(index)}-modal`)
            .setTitle(title.slice(0, 45))
            .addComponents(group.fields.map(f => new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId(f.key)
                    .setLabel(f.label.slice(0, 45))
                    .setStyle(f.style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
                    .setRequired(f.required ?? true)
                    .setPlaceholder(f.placeholder ?? '')
            )));
        return void (await interaction.showModal(modal));
    }

    const field = group.field;
    const stepSelectId = `${stepId(index)}-select`;
    const components: ActionRowBuilder<any>[] = [];

    if (field.kind === 'channel') {
        components.push(new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
            new ChannelSelectMenuBuilder().setCustomId(stepSelectId).setPlaceholder(`Select ${field.label}`).addChannelTypes(...(field.channelTypes ?? [ChannelType.GuildText]))
        ));
    } else if (field.kind === 'user') {
        components.push(new ActionRowBuilder<UserSelectMenuBuilder>().addComponents(
            new UserSelectMenuBuilder().setCustomId(stepSelectId).setPlaceholder(`Select ${field.label}`)
        ));
    } else if (field.kind === 'role') {
        components.push(new ActionRowBuilder<RoleSelectMenuBuilder>().addComponents(
            new RoleSelectMenuBuilder().setCustomId(stepSelectId).setPlaceholder(`Select ${field.label}`)
        ));
    } else {
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
            new StringSelectMenuBuilder().setCustomId(stepSelectId).setPlaceholder(`Select ${field.label}`).addOptions(field.choices)
        ));
    }

    const controlButtons: ButtonBuilder[] = [];
    if (field.required === false) controlButtons.push(new ButtonBuilder().setCustomId(skipId(index)).setLabel(`Skip ${field.label}`).setStyle(ButtonStyle.Secondary));
    controlButtons.push(new ButtonBuilder().setCustomId('modmail-settings_back').setLabel('← Back').setStyle(ButtonStyle.Danger));
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(controlButtons));

    const embed = new EmbedBuilder().setColor(Colors.EmiliaPurple).setTitle(title).setDescription(`Step ${index + 1}/${groups.length}: **${field.label}**`);
    await updateOrReply(interaction, { content: null, embeds: [embed], components });
}

function readTextGroupValues(interaction: ModalSubmitInteraction<'cached'>, group: Extract<FieldGroup, { kind: 'text' }>): Record<string, string> {
    const values: Record<string, string> = {};
    for (const f of group.fields) values[f.key] = interaction.fields.getTextInputValue(f.key);
    return values;
}

function readSelectGroupValue(interaction: PanelInteraction, group: Extract<FieldGroup, { kind: 'select' }>): string | undefined {
    if (group.field.kind === 'channel' && interaction.isChannelSelectMenu()) return interaction.channels.first()?.id;
    if (group.field.kind === 'user' && interaction.isUserSelectMenu()) return interaction.users.first()?.id;
    if (group.field.kind === 'role' && interaction.isRoleSelectMenu()) return interaction.roles.first()?.id;
    if (group.field.kind === 'choice' && interaction.isStringSelectMenu()) return interaction.values[0];
    return undefined;
}

// ─── Action dispatch — customId grammar: modmail-settings_menu (main select) | modmail-settings_back | modmail-settings_action.<key>.run | .step.<i>-modal | .step.<i>-select | .skip.<i> ───

function idPrefix(action: ActionConfig): string {
    return `modmail-settings_action.${action.key}`;
}

function backRow(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('modmail-settings_back').setLabel('← Back to Menu').setStyle(ButtonStyle.Secondary)
    );
}

async function finishAction(interaction: PanelInteraction, action: ActionConfig, values: Record<string, string>): Promise<void> {
    sessions.delete(sessionKey(interaction.user.id, action.key));
    await deferForWork(interaction);
    const result = await action.onRun(interaction, values);
    const payload = typeof result === 'string' ? { content: result, embeds: [] } : { content: result.content ?? null, embeds: result.embeds ?? [] };
    await updateOrReply(interaction, { ...payload, components: [backRow()] });
}

async function advance(interaction: PanelInteraction, action: ActionConfig, groups: FieldGroup[], nextIndex: number, values: Record<string, string>): Promise<void> {
    if (nextIndex >= groups.length) return finishAction(interaction, action, values);
    return showWizardStep(interaction, action.label, groups, nextIndex, i => `${idPrefix(action)}.step.${i}`, i => `${idPrefix(action)}.skip.${i}`);
}

export async function startAction(interaction: PanelInteraction, action: ActionConfig): Promise<void> {
    sweepStaleSessions();
    sessions.set(sessionKey(interaction.user.id, action.key), { values: {}, startedAt: Date.now() });

    const groups = groupFields(action.fields);
    if (!groups.length) return finishAction(interaction, action, {});
    return advance(interaction, action, groups, 0, {});
}

/** Dispatch entry for every `modmail-settings_action.<key>.<rest>` interaction — `rest` is `<verb>` with `action.<key>.` already stripped by the caller. */
export async function handleActionInteraction(interaction: PanelInteraction, actions: ActionConfig[], actionKey: string, rest: string): Promise<void> {
    const action = actions.find(a => a.key === actionKey);
    if (!action) return;

    const stepModalMatch = rest.match(/^step\.(\d+)-modal$/);
    if (stepModalMatch) {
        if (!interaction.isModalSubmit()) return;
        const session = sessions.get(sessionKey(interaction.user.id, action.key));
        if (!session) return void updateOrReply(interaction, { content: TIMED_OUT_MESSAGE, embeds: [], components: [] });
        const stepIndex = Number(stepModalMatch[1]);
        const groups = groupFields(action.fields);
        const group = groups[stepIndex];
        if (!group || group.kind !== 'text') return;
        Object.assign(session.values, readTextGroupValues(interaction, group));
        return advance(interaction, action, groups, stepIndex + 1, session.values);
    }

    const stepSelectMatch = rest.match(/^step\.(\d+)-select$/);
    if (stepSelectMatch) {
        const session = sessions.get(sessionKey(interaction.user.id, action.key));
        if (!session) return void updateOrReply(interaction, { content: TIMED_OUT_MESSAGE, embeds: [], components: [] });
        const stepIndex = Number(stepSelectMatch[1]);
        const groups = groupFields(action.fields);
        const group = groups[stepIndex];
        if (!group || group.kind !== 'select') return;
        const value = readSelectGroupValue(interaction, group);
        if (!value) return;
        session.values[group.field.key] = value;
        return advance(interaction, action, groups, stepIndex + 1, session.values);
    }

    const skipMatch = rest.match(/^skip\.(\d+)$/);
    if (skipMatch) {
        const session = sessions.get(sessionKey(interaction.user.id, action.key));
        if (!session) return void updateOrReply(interaction, { content: TIMED_OUT_MESSAGE, embeds: [], components: [] });
        const stepIndex = Number(skipMatch[1]);
        const groups = groupFields(action.fields);
        return advance(interaction, action, groups, stepIndex + 1, session.values);
    }
}
