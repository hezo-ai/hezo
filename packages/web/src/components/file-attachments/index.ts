import { ATTACHMENT_EXTENSIONS, type AttachmentExtension } from '@hezo/shared';
import type { MessageKey } from '../../lib/i18n';

export { AttachmentChips } from './attachment-chips';
export { FileDropZone } from './file-drop-zone';
export { UploadButton } from './upload-button';

/**
 * Comma-separated `accept` value for a file picker, derived from the shared
 * attachment allowlist so the OS dialog pre-filters to supported extensions.
 * (The real gate is still `handleFiles` — `accept` is only a UX hint.)
 */
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_EXTENSIONS)
	.map((ext) => `.${ext}`)
	.join(',');

/**
 * How the composer's "supported types" tooltip groups the allowlist for a human.
 * Presentation only — the allowlist itself is `ATTACHMENT_EXTENSIONS`.
 *
 * Every extension must appear in exactly one bucket; a test asserts it, so a new
 * entry in the shared map can't silently vanish from the tooltip. Only the
 * category *label* is translated (`labelKey`) — the extension list is derived
 * here, so adding a format is never a twelve-language edit.
 */
interface AttachmentCategory {
	labelKey: MessageKey;
	extensions: readonly AttachmentExtension[];
}

export const ATTACHMENT_CATEGORIES: readonly AttachmentCategory[] = [
	{
		labelKey: 'attachments.category.images',
		extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
	},
	{ labelKey: 'attachments.category.documents', extensions: ['pdf', 'txt', 'md', 'html'] },
	{ labelKey: 'attachments.category.audio', extensions: ['mp3', 'wav', 'aac', 'opus'] },
	{ labelKey: 'attachments.category.video', extensions: ['mp4', 'webm', 'mov'] },
	{
		labelKey: 'attachments.category.archives',
		extensions: ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'],
	},
	{
		labelKey: 'attachments.category.scripts',
		extensions: ['sh', 'py', 'js', 'ts', 'json', 'csv', 'yaml', 'yml'],
	},
];

/** The category's extensions as a human-readable list ("PNG, JPG, GIF"). */
export function formatCategoryExtensions(category: AttachmentCategory): string {
	return category.extensions.map((ext) => ext.toUpperCase()).join(', ');
}
