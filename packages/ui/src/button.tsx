import { type ButtonHTMLAttributes, type Ref, useRef } from 'react';
import { touchMinHeightClassName } from './density.js';
import { kbdSizeClass, ShortcutKbd } from './shortcut-kbd.js';
import { ariaKeyshortcuts, isMacPlatform } from './shortcuts.js';
import { useShortcut } from './use-shortcut.js';

// Mirrors the Wire spec's `.hz-btn`: neutral `primary` (inverse), red `accent`
// CTA, quiet `secondary`/`ghost`/`outline`, and `danger` variants. Focus shows
// the 3px accent ring (`--color-ring` + accent border).
const variants = {
	primary: 'bg-inverse text-inverse-fg border-transparent hover:opacity-90',
	accent: 'bg-accent-solid text-accent-solid-fg border-transparent hover:bg-accent-hover',
	secondary: 'bg-surface text-text-1 border-border-strong shadow-xs hover:bg-surface-2',
	outline: 'bg-transparent text-text-1 border-border-strong hover:bg-surface-2',
	ghost: 'bg-transparent text-text-2 border-transparent hover:bg-surface-3 hover:text-text-1',
	destructive: 'bg-danger text-danger-solid-fg border-transparent hover:opacity-90',
	approve: 'bg-success text-success-solid-fg border-transparent hover:opacity-90',
	'danger-text': 'bg-transparent text-danger border-transparent hover:bg-danger-soft',
	link: 'bg-transparent text-accent border-none hover:underline',
} as const;

// Each row carries the touch floor rather than `shape`, so the `link` variant -
// which skips the rows - stays an inline text control that a 44px box would
// break the line around.
const sizes = {
	sm: `h-[26px] px-2.5 text-[12.5px] rounded-sm gap-1.5 ${touchMinHeightClassName}`,
	md: `h-[30px] px-3 text-[13px] rounded-md gap-1.5 ${touchMinHeightClassName}`,
	lg: `h-[38px] px-4 text-sm rounded-md gap-2 ${touchMinHeightClassName}`,
} as const;

const shape =
	'inline-flex items-center justify-center whitespace-nowrap border font-medium transition-colors cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring focus-visible:border-accent disabled:opacity-45 disabled:pointer-events-none';

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export interface ButtonClassNameOptions {
	variant?: ButtonVariant;
	size?: ButtonSize;
	className?: string;
}

/**
 * The class string behind `Button`, for the rare control that must render as an
 * `<a>` rather than a `<button>` — an external link that has to be a real
 * anchor (middle-click, "open in new tab", never pop-up blocked) while reading
 * as the surface's primary action. Everything else uses `Button`.
 */
export function buttonClassName({
	variant = 'primary',
	size = 'md',
	className = '',
}: ButtonClassNameOptions = {}): string {
	const sizeCls = variant === 'link' ? 'gap-1.5' : sizes[size];
	return `${shape} ${variants[variant]} ${sizeCls} ${className}`;
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	/**
	 * Keyboard shortcut spec (e.g. `"mod+Enter"`, `"mod+k"`, `"Escape"`). Renders
	 * an inset keycap chip after the label. Unless `shortcutFire` is false, it
	 * also registers a guarded document-level binding that clicks the button.
	 */
	shortcut?: string;
	/**
	 * When false, the chip is shown but the button does NOT self-register the
	 * key — for shortcuts already owned elsewhere (a global listener, Radix's
	 * native Escape, a scoped textarea handler). Defaults to true.
	 */
	shortcutFire?: boolean;
	/**
	 * Forwarded to the underlying element, and composed with the internal one
	 * the shortcut binding clicks through - a caller's ref never displaces it.
	 */
	ref?: Ref<HTMLButtonElement>;
}

export function Button({
	variant = 'primary',
	size = 'md',
	className = '',
	// Destructured rather than written on the element, so a caller's `type` still
	// wins over it. Without a default a button inside a form submits it, which is
	// never what an action button rendered next to a field means.
	type = 'button',
	shortcut,
	shortcutFire = true,
	children,
	ref: forwardedRef,
	...props
}: ButtonProps) {
	const ref = useRef<HTMLButtonElement>(null);
	// The shortcut clicks through the internal ref, so the caller's is attached
	// alongside rather than in place of it.
	const attachRef = (node: HTMLButtonElement | null) => {
		ref.current = node;
		if (typeof forwardedRef === 'function') forwardedRef(node);
		else if (forwardedRef) forwardedRef.current = node;
	};
	const kbdCls = variant === 'link' ? kbdSizeClass.md : kbdSizeClass[size];

	useShortcut(shortcut && shortcutFire ? shortcut : undefined, () => ref.current?.click(), {
		enabled: !props.disabled,
	});

	return (
		<button
			ref={attachRef}
			type={type}
			aria-keyshortcuts={shortcut ? ariaKeyshortcuts(shortcut, isMacPlatform()) : undefined}
			className={buttonClassName({ variant, size, className })}
			{...props}
		>
			{children}
			{shortcut && <ShortcutKbd shortcut={shortcut} sizeClassName={kbdCls} />}
		</button>
	);
}
