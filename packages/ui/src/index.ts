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
 * classes name — `bg`, `surface`, `border`, `text-1`/`2`/`3`, `accent*`,
 * `danger*`, `success*`, `warning*`, `info*`, `live*`, `neutral-soft*`,
 * `pink*`, `purple-soft*`, `inverse*`, `ring` and `overlay` — plus the
 * `text-eyebrow` and `scrollbar-none` utilities and the `.breadcrumb-row`
 * overflow masks the breadcrumb reads. A colour it does not define renders as
 * nothing rather than as an error.
 *
 * **A component belongs here when any Hezo site could draw it.** One that names
 * a Hezo concept — an actor, a budget, an archived asset — stays in the app,
 * and so does one whose copy is a paragraph rather than a word: a sentence with
 * a node in it goes through the catalog whole, which a label prop cannot do.
 */
export { Avatar, type AvatarProps, type AvatarSize, getInitials } from './avatar.js';
export { BackLink, type BackLinkProps } from './back-link.js';
export { Badge, type BadgeColor, type BadgeProps, type Tone } from './badge.js';
export {
	Breadcrumb,
	type BreadcrumbProps,
	BreadcrumbRow,
	type BreadcrumbRowProps,
	type BreadcrumbSegment,
	type EdgeState,
} from './breadcrumb.js';
export {
	Button,
	type ButtonClassNameOptions,
	type ButtonProps,
	type ButtonSize,
	type ButtonVariant,
	buttonClassName,
} from './button.js';
export { Card, type CardProps } from './card.js';
export { copyToClipboard } from './clipboard.js';
export { Code, type CodeProps } from './code.js';
export { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog.js';
export { CountOverlayBadge, type CountOverlayBadgeProps } from './count-overlay-badge.js';
export {
	type Column,
	DataTable,
	type DataTableProps,
	type DataTableSort,
} from './data-table.js';
export {
	CONTENT_Z,
	DialogContent,
	type DialogContentProps,
	type DialogSize,
	dialogContentClassName,
	dialogOverlayClassName,
	fullscreenContentClassName,
	OVERLAY_Z,
} from './dialog.js';
export { EmptyState, type EmptyStateProps } from './empty-state.js';
export { FilterPills, type FilterPillsProps } from './filter-pills.js';
export { type HeadingLevel, headingTag } from './heading.js';
export { HelpDialog, type HelpDialogProps } from './help-dialog.js';
export { InPlaceForm, type InPlaceFormProps } from './in-place-form.js';
export { InfoTooltip, type InfoTooltipProps } from './info-tooltip.js';
export { Input, type InputProps } from './input.js';
export { Kbd, type KbdProps } from './kbd.js';
export { Logo, type LogoProps, type LogoSize } from './logo.js';
export {
	MultiSelect,
	type MultiSelectOption,
	type MultiSelectProps,
} from './multi-select.js';
export { NameSwitcherButton, type NameSwitcherButtonProps } from './name-switcher-button.js';
export { PageLogo, type PageLogoProps } from './page-logo.js';
export { PasswordInput, type PasswordInputProps } from './password-input.js';
export { Progress, type ProgressProps } from './progress.js';
export { readStored, removeStored, writeStored } from './safe-storage.js';
export {
	SearchableSelect,
	type SearchableSelectOption,
	type SearchableSelectProps,
} from './searchable-select.js';
export { SectionHeader, type SectionHeaderProps } from './section-header.js';
export {
	SegmentedControl,
	type SegmentedControlProps,
	type SegmentedOption,
} from './segmented-control.js';
export { SEGMENTED_FIT_TOLERANCE_PX, segmentedLabelsFit } from './segmented-fit.js';
export { kbdSizeClass, ShortcutKbd, type ShortcutKbdProps } from './shortcut-kbd.js';
export {
	ariaKeyshortcuts,
	formatShortcut,
	isEditableTarget,
	isMacPlatform,
	type KeyEventLike,
	matchesShortcut,
	type ParsedShortcut,
	parseShortcut,
	shortcutBypassesInput,
} from './shortcuts.js';
export { StatusDot, type StatusDotProps } from './status-dot.js';
export { Textarea, type TextareaProps } from './textarea.js';
export {
	type ResolvedTheme,
	type ThemeContextValue,
	type ThemePreference,
	ThemeProvider,
	type ThemeProviderProps,
	useTheme,
} from './theme.js';
export { THEME_OPTIONS, ThemeSwitcher, type ThemeSwitcherProps } from './theme-switcher.js';
export { Toggle, type ToggleProps } from './toggle.js';
export {
	TOOLTIP_Z,
	Tooltip,
	type TooltipProps,
	TooltipProvider,
	type TooltipProviderProps,
} from './tooltip.js';
export { type UseShortcutOptions, useShortcut } from './use-shortcut.js';
