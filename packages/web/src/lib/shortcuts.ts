/**
 * Shortcut parsing and formatting, which now lives beside the controls using it.
 *
 * Re-exported from its old path so the surfaces that bind keys keep the import
 * they had. New code reaches for `@hezo/ui` directly.
 */
export {
	ariaKeyshortcuts,
	formatShortcut,
	isEditableTarget,
	isMacPlatform,
	matchesShortcut,
	type ParsedShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from '@hezo/ui';
