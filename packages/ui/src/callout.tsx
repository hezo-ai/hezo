import type { HTMLAttributes, ReactNode } from 'react';
import { type Tone, toneTintClassName } from './tone.js';

/**
 * How loudly each tone announces itself. `danger` interrupts; everything else
 * waits its turn. A table rather than a branch, so a new tone is one row and an
 * unhandled one is a compile error.
 */
const toneRole: Record<Tone, 'alert' | 'status'> = {
	neutral: 'status',
	accent: 'status',
	success: 'status',
	warning: 'status',
	danger: 'alert',
	info: 'status',
	live: 'status',
	purple: 'status',
	pink: 'status',
};

// `title` is taken for the emphasised first line, so the native tooltip
// attribute is not reachable here; `role` is derived and overridden below.
export interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'role' | 'title'> {
	/** Drawn with the same tint `Badge` uses for this tone. Defaults to `info`. */
	tone?: Tone;
	/** Optional glyph, pinned to the first line of the prose. */
	icon?: ReactNode;
	/** An emphasised first line. Not a heading - a callout sits inside a section, it does not open one. */
	title?: string;
	children: ReactNode;
	/**
	 * Overrides the role the tone implies.
	 *
	 * **`'none'` for a block that is on screen at first paint.** A live region
	 * announces what appears in it, so a permanent explanatory note declared as
	 * one is read out on every arrival with nothing having happened.
	 */
	role?: 'alert' | 'status' | 'none';
}

/**
 * A tone drawn as a block of prose - a notice, a callout, an inline alert.
 *
 * The counterpart to `Badge`: same tones, same colours, a paragraph rather than
 * a word. The ARIA is the reason this belongs in the package rather than in each
 * app, since a hand-rolled tinted `<div>` carries none.
 */
export function Callout({
	tone = 'info',
	icon,
	title,
	children,
	role,
	className = '',
	...props
}: CalloutProps) {
	const resolvedRole = role ?? toneRole[tone];
	return (
		<div
			// `undefined` rather than `role="none"`: the ARIA role of that name
			// strips an element's semantics, and a `<div>` has none to strip.
			role={resolvedRole === 'none' ? undefined : resolvedRole}
			className={`flex items-start gap-2.5 rounded-md p-3 text-[12.5px] leading-relaxed ${toneTintClassName[tone]} ${className}`}
			{...props}
		>
			{icon && <span className="mt-px shrink-0">{icon}</span>}
			<span className="min-w-0 flex-1">
				{title && <span className="block font-semibold">{title}</span>}
				{children}
			</span>
		</div>
	);
}
