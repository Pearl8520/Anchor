import { IModmailCategory } from "../../types/database.js";

/** Used in "no category found" errors so the user can immediately see the exact names to use, instead of guessing. Also used by modmail-settings.ts. */
export function listCategoryNames(categories: IModmailCategory[]): string {
    return categories.length > 0
        ? categories.map(c => `**${c.label}**`).join(', ')
        : '*(none configured yet — add one first with **Add Category**)*';
}

export function slugify(name: string): string {
    return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

/** Matches a user-typed category name against either its display label or its slugified key — used by /modmail-thread's move action and /modmail-settings' category management. */
export function findMatchingCategory(categories: IModmailCategory[], name: string): IModmailCategory | undefined {
    const normalized = name.toLowerCase().trim();
    return categories.find(c => c.label.toLowerCase() === normalized || c.key === normalized || c.key === slugify(name));
}

/** Normalizes a user-typed hex color (`#RRGGBB` or `RRGGBB`) to the `#RRGGBB` form stored in settings — returns null for blank/invalid input. */
export function parseHexColor(input: string | undefined): string | null {
    const match = input?.trim().match(/^#?([0-9a-fA-F]{6})$/);
    return match ? `#${match[1]}` : null;
}
