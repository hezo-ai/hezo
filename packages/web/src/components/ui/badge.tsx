import type { ReactNode } from 'react';

/** The semantic tones the design system defines. */
type Tone =
	| 'neutral'
	| 'accent'
	| 'success'
	| 'warning'
	| 'danger'
	| 'info'
	| 'live'
	| 'purple'
	| 'pink';

/** Back-compat colour aliases callers still pass. */
const aliasToTone = {
	gray: 'neutral',
	blue: 'info',
	green: 'success',
	yellow: 'warning',
	amber: 'warning',
	red: 'danger',
} as const;

export type BadgeColor = Tone | keyof typeof aliasToTone;

/** Variant A "quiet tint" — soft bg + soft fg. The default. */
const tintMap: Record<Tone, string> = {
	neutral: 'bg-neutral-soft text-neutral-soft-fg',
	accent: 'bg-accent-soft text-accent-soft-fg',
	success: 'bg-success-soft text-success-soft-fg',
	warning: 'bg-warning-soft text-warning-soft-fg',
	danger: 'bg-danger-soft text-danger-soft-fg',
	info: 'bg-info-soft text-info-soft-fg',
	live: 'bg-live-soft text-live-soft-fg',
	purple: 'bg-purple-soft text-purple-soft-fg',
	pink: 'bg-pink-soft text-pink-soft-fg',
};

/** Variant B "solid signal" — solid bg + on-solid fg. */
const solidMap: Record<Tone, string> = {
	neutral: 'bg-inverse text-inverse-fg',
	accent: 'bg-accent-solid text-accent-solid-fg',
	success: 'bg-success text-success-solid-fg',
	warning: 'bg-warning text-warning-solid-fg',
	danger: 'bg-danger text-danger-solid-fg',
	info: 'bg-info text-info-solid-fg',
	live: 'bg-live text-live-solid-fg',
	purple: 'bg-purple-soft text-purple-soft-fg',
	pink: 'bg-pink text-pink-fg',
};

/** Dot colour for the "dot + label" variant (the inbox type tag). */
const dotMap: Record<Tone, string> = {
	neutral: 'bg-text-3',
	accent: 'bg-accent',
	success: 'bg-success',
	warning: 'bg-warning',
	danger: 'bg-danger',
	info: 'bg-info',
	live: 'bg-live',
	purple: 'bg-purple-soft-fg',
	pink: 'bg-pink',
};

function resolveTone(color: BadgeColor): Tone {
	return (aliasToTone as Record<string, Tone>)[color] ?? (color as Tone);
}

interface BadgeProps {
	color?: BadgeColor;
	/** tint (default) · solid · dot (dot + label) · outline. */
	variant?: 'tint' | 'solid' | 'dot' | 'outline';
	mono?: boolean;
	children: ReactNode;
	className?: string;
}

export function Badge({
	color = 'neutral',
	variant = 'tint',
	mono = false,
	children,
	className = '',
}: BadgeProps) {
	const tone = resolveTone(color);
	const base =
		'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full h-5 px-2 text-[11.5px] font-medium';
	const fontCls = mono ? 'font-mono text-[11px]' : '';

	if (variant === 'dot') {
		return (
			<span className={`${base} bg-transparent px-0.5 text-text-2 ${fontCls} ${className}`}>
				<span className={`h-[7px] w-[7px] shrink-0 rounded-full ${dotMap[tone]}`} />
				{children}
			</span>
		);
	}
	if (variant === 'outline') {
		return (
			<span
				className={`${base} border border-border-strong bg-transparent text-text-2 ${fontCls} ${className}`}
			>
				{children}
			</span>
		);
	}
	const toneCls = variant === 'solid' ? solidMap[tone] : tintMap[tone];
	return <span className={`${base} ${toneCls} ${fontCls} ${className}`}>{children}</span>;
}
