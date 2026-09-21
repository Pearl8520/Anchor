import { Attachment, AttachmentBuilder, Collection, ColorResolvable, EmbedBuilder, FileBuilder, Guild, MediaGalleryBuilder, MediaGalleryItemBuilder, MessageFlags, PermissionFlagsBits, Sticker, StickerFormatType, TextChannel, TextDisplayBuilder, Webhook } from "discord.js";
import convert from "heic-convert";
import { IModmailCategory } from "../../types/database.js";
import { Colors } from "../../utils/util.js";

/** A consistent embed shell for Modmail's system notices (thread opened/closed/reopened/claimed, etc.), replacing what used to be bare content strings. Kept here (not modmail-relay.ts/modmail-intake.ts) for the same circular-import reason as relayAttachmentsToLogChannel below — both files need it. */
export function modmailNoticeEmbed(description: string, color: ColorResolvable = Colors.EmiliaPurple): EmbedBuilder {
    return new EmbedBuilder().setColor(color).setDescription(description);
}

const RELAY_WEBHOOK_NAME = 'Modmail Relay';
const relayWebhookCache = new Map<string, Webhook>();

/** One webhook per modmail category's parent channel, reused across restarts (looked up by name, not
 * just held in memory) so repeated calls don't pile up duplicate webhooks against Discord's 15-per-channel
 * cap. Used to post an incoming user message as the user themselves (real username + avatar) — both for
 * a new thread's first message and every follow-up — so it looks and behaves exactly like a message they
 * posted directly (links/GIFs auto-unfurl natively). Kept here rather than modmail-relay.ts so
 * modmail-intake.ts can use the exact same webhook without a circular import (modmail-relay.ts already
 * imports from modmail-intake.ts one-directionally). */
export async function getOrCreateRelayWebhook(parentChannel: TextChannel): Promise<Webhook | null> {
    const cached = relayWebhookCache.get(parentChannel.id);
    if (cached) return cached;

    const botPermissions = parentChannel.guild.members.me?.permissionsIn(parentChannel);
    if (!botPermissions?.has(PermissionFlagsBits.ManageWebhooks)) return null;

    try {
        const existing = await parentChannel.fetchWebhooks();
        // Discord only returns a token for webhooks the CURRENT bot application created — a same-named
        // webhook owned by a different bot (e.g. stable vs. beta sharing a test server, or a stale one
        // from before a token rotation) shows up with no token and throws WebhookTokenUnavailable the
        // moment something tries to send with it, so it must be excluded from the match, not just
        // matched by name.
        const webhook = existing.find(w => w.name === RELAY_WEBHOOK_NAME && w.token) ?? await parentChannel.createWebhook({ name: RELAY_WEBHOOK_NAME });
        relayWebhookCache.set(parentChannel.id, webhook);
        return webhook;
    } catch {
        return null;
    }
}

/**
 * Pure, dependency-free helpers for turning a DM or staff message's attachments/stickers into a
 * Components V2 relay payload. Split out from modmail-relay.ts (rather than just exported from there)
 * so modmail-intake.ts can use the exact same logic for a brand-new thread's first message without a
 * circular import — modmail-relay.ts already imports from modmail-intake.ts one-directionally.
 */

export interface StickerRelayResult { mediaUrls: string[]; note?: string; }

/**
 * Builds what to relay for a message's stickers. Discord.js's own Sticker#url maps APNG-format
 * stickers to a .png extension, which loses the animation when shown via an image — this requests the
 * media-proxy's .gif-converted version instead so animated stickers actually stay animated.
 * Lottie-format stickers are vector JSON, not a raster image at all, so they can't be previewed as an
 * image here — a text note is returned for those instead of silently dropping them.
 */
export function buildStickerRelay(stickers: Collection<string, Sticker>): StickerRelayResult {
    const mediaUrls: string[] = [];
    const notes: string[] = [];

    for (const sticker of stickers.values()) {
        if (sticker.format === StickerFormatType.Lottie) {
            notes.push(`🎨 *(animated sticker "${sticker.name}" — can't be previewed here)*`);
            continue;
        }

        const url = sticker.format === StickerFormatType.APNG
            ? `https://media.discordapp.net/stickers/${sticker.id}.gif`
            : sticker.url;
        mediaUrls.push(url);
    }

    return { mediaUrls, note: notes.length ? notes.join('\n') : undefined };
}

const MEDIA_CONTENT_TYPE_PREFIXES = ['image/', 'video/'];
const HEIC_CONTENT_TYPES = ['image/heic', 'image/heif'];

/**
 * Images/videos get referenced directly via URL (see buildRelayPayload) — no reupload needed for
 * these. Uses `proxyURL` (Discord's media-proxy domain, media.discordapp.net) rather than `url` (the
 * raw cdn.discordapp.com link) — the same distinction already used for stickers below, and media-proxy
 * links are what Discord's client actually expects for inline preview/embed rendering.
 *
 * HEIC/HEIF is excluded here — Discord's own client (confirmed via Discord's own support forums) can't
 * decode that format at all, whether referenced by URL or freshly uploaded, so those go through
 * convertHeicAttachments below instead rather than being referenced directly.
 *
 * Only safe when the source message these attachments belong to is going to keep existing — a
 * URL/proxyURL reference is tied to that original message, and Discord doesn't keep the underlying CDN
 * resource resolvable once it's deleted, even for other messages (like the ones built from this
 * function's output) that only ever pointed at it rather than holding their own copy. The incoming-DM
 * relay is fine (a user's own DM is never deleted by the bot); replyToModmailThread uses
 * fetchMediaForReupload below instead, re-uploading each file as its own independent copy rather than
 * relying on a reference at all.
 */
export function getMediaAttachmentUrls(attachments: Collection<string, Attachment>): string[] {
    return [...attachments.values()]
        .filter(a => MEDIA_CONTENT_TYPE_PREFIXES.some(prefix => a.contentType?.startsWith(prefix)))
        .filter(a => !HEIC_CONTENT_TYPES.some(t => a.contentType?.startsWith(t)))
        .map(a => a.proxyURL);
}

export interface ConvertedImageFile { name: string; buffer: Buffer; spoiler: boolean; }

/**
 * Downloads image/video attachments (excluding HEIC/HEIF, which convertHeicAttachments already
 * downloads+converts) as genuine bytes for re-upload, instead of referencing their Discord CDN URL like
 * getMediaAttachmentUrls does. This is what replyToModmailThread uses for every staff reply, re-uploading
 * each file as its own independent, permanent copy rather than a URL reference.
 */
export async function fetchMediaForReupload(attachments: Collection<string, Attachment>): Promise<ConvertedImageFile[]> {
    const media = [...attachments.values()]
        .filter(a => MEDIA_CONTENT_TYPE_PREFIXES.some(prefix => a.contentType?.startsWith(prefix)))
        .filter(a => !HEIC_CONTENT_TYPES.some(t => a.contentType?.startsWith(t)));
    const files: ConvertedImageFile[] = [];

    for (const attachment of media) {
        try {
            const res = await fetch(attachment.url);
            const buffer = Buffer.from(await res.arrayBuffer());
            files.push({ name: attachment.name, buffer, spoiler: attachment.spoiler });
        } catch (err) {
            console.error('[modmail-relay-content] Re-upload fetch failed:', err);
        }
    }

    return files;
}

/**
 * HEIC/HEIF (the default format for iPhone Camera Roll photos) can't be decoded by Discord's own
 * desktop/web client at all — confirmed directly against Discord's own support forums, not something a
 * media-proxy URL parameter can work around, since Discord's preview pipeline never recognizes the
 * source format in the first place regardless of how it's referenced. Downloaded and converted here
 * instead, then relayed as a genuine freshly-uploaded attachment (see buildRelayPayload), which renders
 * identically on every client since it's no longer HEIC by the time Discord sees it.
 *
 * Output format is PNG, not JPEG — heic-convert's JPEG path goes through jpeg-js, a pure-JS encoder with
 * real pixel-corruption bugs on some real-world photos (confirmed directly: a converted JPEG came out
 * visibly broken/garbled in production despite decoding without error). PNG goes through pngjs instead,
 * which sidesteps jpeg-js entirely; verified clean against a real sample HEIC file. Lossless PNG is also
 * simply larger than a JPEG would be, an accepted trade-off for correctness.
 */
export async function convertHeicAttachments(attachments: Collection<string, Attachment>): Promise<ConvertedImageFile[]> {
    const heicAttachments = [...attachments.values()].filter(a => HEIC_CONTENT_TYPES.some(t => a.contentType?.startsWith(t)));
    const converted: ConvertedImageFile[] = [];

    for (const attachment of heicAttachments) {
        try {
            const res = await fetch(attachment.url);
            const inputBuffer = Buffer.from(await res.arrayBuffer());
            const outputBuffer = await convert({ buffer: inputBuffer, format: 'PNG' });
            const name = attachment.name.replace(/\.(heic|heif)$/i, '.png');
            converted.push({ name, buffer: Buffer.from(outputBuffer), spoiler: attachment.spoiler });
        } catch (err) {
            console.error('[modmail-relay-content] HEIC conversion failed:', err);
        }
    }

    return converted;
}

export interface FetchedRelayFile { name: string; buffer: Buffer; spoiler: boolean; }

/**
 * Downloads only the attachments that aren't images/videos — those have no CDN-reference equivalent
 * for a *new* message (unlike MediaGalleryBuilder, FileBuilder's URL only accepts an `attachment://`
 * reference to a file actually included in the same message's own `files`), so their bytes have to be
 * fetched once and re-sent. Split out from buildRelayPayload so a reply going to two destinations
 * (the user's DM and the thread copy) only downloads each file once, not once per destination.
 */
export async function fetchNonMediaFiles(attachments: Collection<string, Attachment>): Promise<FetchedRelayFile[]> {
    const nonMedia = [...attachments.values()].filter(a => !MEDIA_CONTENT_TYPE_PREFIXES.some(prefix => a.contentType?.startsWith(prefix)));
    const files: FetchedRelayFile[] = [];
    for (const attachment of nonMedia) {
        const res = await fetch(attachment.url);
        const buffer = Buffer.from(await res.arrayBuffer());
        files.push({ name: attachment.name, buffer, spoiler: attachment.spoiler });
    }
    return files;
}

export interface RelayPayload {
    content?: string;
    embeds?: EmbedBuilder[];
    flags?: MessageFlags.IsComponentsV2;
    components?: (TextDisplayBuilder | MediaGalleryBuilder | FileBuilder)[];
    files?: AttachmentBuilder[];
}

export interface RelayAuthor { name: string; iconURL?: string; footer?: string; }

/**
 * Builds what to send for a relayed message (DM<->thread, either direction, including a new thread's
 * first message). When there's no actual media/file to relay (a plain-text message), this sends as a
 * single embed with the sender's name as its author — matching the old Dragory/modmailbot look every
 * relayed message used to have, and nothing is sent outside that embed, including a bare link — Discord's
 * native auto-unfurl/GIF-preview only ever fires on plain `content`, never on an embed's description, so
 * a link relayed this way loses that preview as an accepted trade-off for never showing text twice or
 * outside the embed. No `author` provided at all (e.g. a ping-only send elsewhere) falls back to plain
 * content instead.
 *
 * When there IS media/files, images/videos are referenced directly via their Discord CDN URL through a
 * MediaGalleryBuilder — no re-upload at all, which is what used to burn the bot's own bandwidth, hit
 * Discord's ~10MB combined-attachment cap on the receiving channel regardless of what the sender could
 * freely attach in a DM (e.g. a Nitro user's 200MB video, which would just fail to relay outright), and
 * was simply slow for anything large. Non-media files still need their bytes re-sent (see
 * fetchNonMediaFiles) since there's no CDN-reference equivalent for them. Components V2 messages can't
 * carry a legacy embed at all, so a provided author's name/footer is rendered as a bold/subtext line at
 * the top of the plain TextDisplay content instead — still shown, just not in an embed widget.
 */
/** Discord can reject a whole send with UNFURLED_MEDIA_ITEM_REFERENCED_ATTACHMENT_NOT_FOUND if an
 * attachment://name reference doesn't exactly match how the file actually got stored — which real-world
 * filenames (spaces, unicode, emoji — common on GIFs saved/shared from Tenor/Giphy with a descriptive
 * name, less common on a camera's generic IMG_1234.jpg) can silently break. Building the same
 * Discord-safe name for both the upload and its reference here, in one place, guarantees they can never
 * drift apart — confirmed as the cause of staff-sent GIFs specifically failing to relay to the user
 * (their filenames are far more likely to carry the characters that trigger this than a photo's). */
function safeAttachmentName(originalName: string, index: number): string {
    const dotIndex = originalName.lastIndexOf('.');
    const ext = dotIndex > 0 ? originalName.slice(dotIndex).replace(/[^a-zA-Z0-9.]/g, '') : '';
    const base = (dotIndex > 0 ? originalName.slice(0, dotIndex) : originalName)
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 60);
    return `${base || 'file'}_${index}${ext}`;
}

export function buildRelayPayload(text: string | undefined, mediaUrls: string[], nonMediaFiles: FetchedRelayFile[], author?: RelayAuthor, color: ColorResolvable = Colors.EmiliaPurple, convertedImages: ConvertedImageFile[] = []): RelayPayload {
    if (mediaUrls.length === 0 && nonMediaFiles.length === 0 && convertedImages.length === 0) {
        if (text && author) {
            const embed = new EmbedBuilder().setColor(color).setAuthor({ name: author.name, iconURL: author.iconURL }).setDescription(text);
            if (author.footer) embed.setFooter({ text: author.footer });
            return { embeds: [embed] };
        }
        return { content: text };
    }

    const components: (TextDisplayBuilder | MediaGalleryBuilder | FileBuilder)[] = [];
    const bodyText = author
        ? [`**${author.name}**`, text, author.footer ? `-# ${author.footer}` : null].filter(Boolean).join('\n')
        : text;
    if (bodyText) components.push(new TextDisplayBuilder().setContent(bodyText));

    const files: AttachmentBuilder[] = [];

    // Converted (formerly-HEIC) images join the same gallery as the directly-referenced media, just via
    // an attachment:// reference to a file actually included in this message's own `files` instead of an
    // external URL — MediaGalleryItemBuilder accepts either.
    const galleryItems = mediaUrls.map(url => new MediaGalleryItemBuilder().setURL(url));
    convertedImages.forEach((image, index) => {
        const name = safeAttachmentName(image.name, index);
        files.push(new AttachmentBuilder(image.buffer, { name }));
        galleryItems.push(new MediaGalleryItemBuilder().setURL(`attachment://${name}`));
    });
    if (galleryItems.length > 0) components.push(new MediaGalleryBuilder().addItems(galleryItems));

    nonMediaFiles.forEach((file, index) => {
        const name = safeAttachmentName(file.name, index);
        files.push(new AttachmentBuilder(file.buffer, { name }));
        components.push(new FileBuilder().setURL(`attachment://${name}`).setSpoiler(file.spoiler));
    });

    return { flags: MessageFlags.IsComponentsV2, components, files };
}

/**
 * Forwards a relayed message's attachments to that category's attachment log channel, if set — mirrors
 * the old Dragory/modmailbot behavior of centralizing every thread's shared files in one place for
 * moderation/audit purposes. Takes `category` pre-resolved rather than fetching it itself, and touches
 * the Discord API directly (unlike every other function in this file) specifically so both
 * modmail-relay.ts and modmail-intake.ts can call it without a circular import between those two.
 * Never blocks the actual relay if it fails — a missing/deleted log channel or a send error just
 * silently no-ops here.
 */
export async function relayAttachmentsToLogChannel(guild: Guild, category: IModmailCategory | undefined, threadNumber: number, uploaderTag: string, mediaUrls: string[], nonMediaFiles: FetchedRelayFile[], convertedImages: ConvertedImageFile[] = []): Promise<void> {
    if (!category?.attachmentLogChannelId) return;
    if (mediaUrls.length === 0 && nonMediaFiles.length === 0 && convertedImages.length === 0) return;

    const logChannel = await guild.channels.fetch(category.attachmentLogChannelId).catch(() => null);
    if (!logChannel || !(logChannel instanceof TextChannel)) return;

    const payload = buildRelayPayload(`Thread #${threadNumber} (${uploaderTag})`, mediaUrls, nonMediaFiles, undefined, undefined, convertedImages);
    await logChannel.send(payload).catch(() => null);
}
