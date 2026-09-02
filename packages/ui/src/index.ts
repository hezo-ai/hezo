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
 *   a requirement for rendering at all, which is what kept these unshared.
 * - **No raw custom property in a class string.** `bg-overlay`, never
 *   `bg-[var(--overlay)]` — the utility reads the theme key that `@theme`
 *   publishes, and the raw property is not defined wherever a consumer
 *   namespaces its own.
 *
 * **A consumer's stylesheet must also scan this package's source.** Tailwind
 * generates a utility only where it reads the class string, and its default
 * root stops at the app's own package. Without an `@source` naming this
 * directory every utility used only by a primitive is absent from the
 * stylesheet, and the component renders unstyled with nothing in the markup to
 * say so.
 *
 * What a consumer's stylesheet must define is the `@theme` colour surface these
 * classes name — `surface`, `border`, `text-1`/`2`/`3`, `accent*`, `danger*`,
 * `success*`, `warning*`, `info*`, `live*`, `neutral-soft*`, `pink*`,
 * `inverse*`, `ring` and `overlay` — plus the `text-eyebrow` utility.
 *
 * **A component belongs here when any Hezo site could draw it.** One that names
 * a Hezo concept — an actor, a budget, an archived asset — stays in the app,
 * and so does one whose copy is a paragraph rather than a word: a sentence with
 * a node in it goes through the catalog whole, which a label prop cannot do.
 */
export { Avatar, type AvatarColor, avatarColorFromString, getInitials } from './avatar.js';
export { BackLink } from './back-link.js';
export { Badge, type BadgeColor } from './badge.js';
export { Breadcrumb, BreadcrumbRow, type BreadcrumbSegment } from './breadcrumb.js';
export { Button, buttonClassName } from './button.js';
export { Card } from './card.js';
export { copyToClipboard } from './clipboard.js';
export { Code } from './code.js';
export { ConfirmDialog } from './confirm-dialog.js';
export { CountOverlayBadge } from './count-overlay-badge.js';
export { type Column, DataTable, type DataTableSort } from './data-table.js';
export {
	CONTENT_Z,
	DialogContent,
	type DialogSize,
	dialogContentClassName,
	dialogOverlayClassName,
	fullscreenContentClassName,
	OVERLAY_Z,
} from './dialog.js';
export { EmptyState } from './empty-state.js';
export { FilterPills } from './filter-pills.js';
export { HelpDialog } from './help-dialog.js';
export { InPlaceForm } from './in-place-form.js';
export { InfoTooltip } from './info-tooltip.js';
export { Input } from './input.js';
export { Kbd } from './kbd.js';
export { Logo } from './logo.js';
export { MultiSelect, type MultiSelectOption } from './multi-select.js';
export { NameSwitcherButton } from './name-switcher-button.js';
export { PageLogo } from './page-logo.js';
export { PasswordInput } from './password-input.js';
export { Progress } from './progress.js';
export { readStored, removeStored, writeStored } from './safe-storage.js';
export { SearchableSelect, type SearchableSelectOption } from './searchable-select.js';
export { SectionHeader } from './section-header.js';
export { SegmentedControl, type SegmentedOption } from './segmented-control.js';
export { SEGMENTED_FIT_TOLERANCE_PX, segmentedLabelsFit } from './segmented-fit.js';
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
export { StatusDot } from './status-dot.js';
export { Textarea } from './textarea.js';
export { type ResolvedTheme, type ThemePreference, ThemeProvider, useTheme } from './theme.js';
export { THEME_OPTIONS, ThemeSwitcher } from './theme-switcher.js';
export { Toggle } from './toggle.js';
export { Tooltip } from './tooltip.js';
export { useShortcut } from './use-shortcut.js';
