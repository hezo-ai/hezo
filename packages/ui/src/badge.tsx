import type { ReactNode } from 'react';
import { type Tone, toneDotClassName, toneSolidClassName, toneTintClassName } from './tone.js';

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

function resolveTone(color: BadgeColor): Tone {
	return (aliasToTone as Record<string, Tone>)[color] ?? (color as Tone);
}

export interface BadgeProps {
	color?: BadgeColor;
	/** tint (default) · solid · dot (dot + label) · outline. */
	variant?: 'tint' | 'solid' | 'dot' | 'outline';
	mono?: boolean;
	children: ReactNode;
	className?: string;
	/** Rendered as `data-testid` so callers can target the pill in tests. */
	testId?: string;
}

export function Badge({
	color = 'neutral',
	variant = 'tint',
	mono = false,
	children,
	className = '',
	testId,
}: BadgeProps) {
	const tone = resolveTone(color);
	const base =
		'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full h-5 px-2 text-[11.5px] font-medium';
	const fontCls = mono ? 'font-mono text-[11px]' : '';

	if (variant === 'dot') {
		return (
			<span
				className={`${base} bg-transparent px-0.5 text-text-2 ${fontCls} ${className}`}
				data-testid={testId}
			>
				<span className={`h-[7px] w-[7px] shrink-0 rounded-full ${toneDotClassName[tone]}`} />
				{children}
			</span>
		);
	}
	if (variant === 'outline') {
		return (
			<span
				className={`${base} border border-border-strong bg-transparent text-text-2 ${fontCls} ${className}`}
				data-testid={testId}
			>
				{children}
			</span>
		);
	}
	const toneCls = variant === 'solid' ? toneSolidClassName[tone] : toneTintClassName[tone];
	return (
		<span className={`${base} ${toneCls} ${fontCls} ${className}`} data-testid={testId}>
			{children}
		</span>
	);
}
