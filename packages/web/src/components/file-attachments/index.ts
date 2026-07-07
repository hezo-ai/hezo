import { ATTACHMENT_EXTENSIONS } from '@hezo/shared';

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
