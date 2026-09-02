/**
 * The primitives more than one app draws with.
 *
 * **A library, not an application's folder** — an `exports` map, source
 * exported for the consumer to transpile, and no dependency on a router, a
 * store or a translation context. The web app imports its own primitives from
 * here, so there is one implementation rather than a copy that drifts within a
 * release.
 *
 * Two rules keep it importable, and both are easy to break:
 *
 * - **No copy is resolved here.** Every user-visible string is a prop with an
 *   English default. A `useI18n()` inside a primitive makes the app's provider
 *   a requirement for rendering at all.
 * - **No raw custom property in a class string.** `bg-overlay`, never
 *   `bg-[var(--overlay)]` — the utility reads the theme key that `@theme`
 *   publishes, and the raw property is not defined wherever a consumer
 *   namespaces its own.
 *
 * What a consumer's stylesheet must define is the `@theme` colour surface these
 * classes name — `surface`, `border`, `text-1`/`2`/`3`, `accent*`, `danger*`,
 * `success*`, `inverse*`, `ring` and `overlay` — plus the `text-eyebrow`
 * utility.
 */
export { Button, buttonClassName } from './button.js';
export { ConfirmDialog } from './confirm-dialog.js';
export {
	CONTENT_Z,
	DialogContent,
	type DialogSize,
	dialogContentClassName,
	dialogOverlayClassName,
	fullscreenContentClassName,
	OVERLAY_Z,
} from './dialog.js';
export { Input } from './input.js';
export { kbdSizeClass, ShortcutKbd } from './shortcut-kbd.js';
export {
	ariaKeyshortcuts,
	formatShortcut,
	isEditableTarget,
	isMacPlatform,
	matchesShortcut,
	type ParsedShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from './shortcuts.js';
export { useShortcut } from './use-shortcut.js';
