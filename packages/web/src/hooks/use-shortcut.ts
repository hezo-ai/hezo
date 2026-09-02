/**
 * The document-level key binding, which now lives beside the controls using it.
 *
 * Re-exported from its old path so the surfaces that bind keys keep the import
 * they had. New code reaches for `@hezo/ui` directly.
 */
export { useShortcut } from '@hezo/ui';
