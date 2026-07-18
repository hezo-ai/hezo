import { formatShortcut, isMacPlatform } from '../../lib/shortcuts';

// The inset shortcut keycap shared by <Button shortcut> and any surface that
// renders its own controls (e.g. ConfirmDialog's AlertDialog buttons). Its
// color derives from the parent's text (`currentColor`), so one treatment
// adapts to every button variant — light on the dark/red grounds, a soft tint
// on the quiet ones. Sized just under the label via `sizeClassName`.
const KBD_STYLE = {
	backgroundColor: 'color-mix(in oklab, currentColor 15%, transparent)',
	borderColor: 'color-mix(in oklab, currentColor 22%, transparent)',
} as const;

export const kbdSizeClass = {
	sm: 'text-[10px] px-1 py-px -mr-0.5',
	md: 'text-[11px] px-1.5 py-0.5 -mr-0.5',
	lg: 'text-[11.5px] px-1.5 py-0.5 -mr-1',
} as const;

export function ShortcutKbd({
	shortcut,
	sizeClassName = kbdSizeClass.md,
}: {
	shortcut: string;
	sizeClassName?: string;
}) {
	return (
		// biome-ignore lint/a11y/noAriaHiddenOnFocusable: a <kbd> is not focusable; the shortcut is exposed to assistive tech via aria-keyshortcuts on the owning button, and hiding the visual keycap avoids a duplicate, oddly-verbalized accessible name.
		<kbd
			aria-hidden="true"
			style={KBD_STYLE}
			className={`inline-flex items-center justify-center rounded-[4px] border font-mono font-medium leading-none tracking-tight ${sizeClassName}`}
		>
			{formatShortcut(shortcut, isMacPlatform())}
		</kbd>
	);
}
