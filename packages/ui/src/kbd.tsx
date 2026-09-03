import type { ReactNode } from 'react';

export interface KbdProps {
	children: ReactNode;
	className?: string;
}

// Wire's `.hz-kbd`: a small mono keycap for shortcut hints (e.g. "j / k").
export function Kbd({ children, className = '' }: KbdProps) {
	return (
		<kbd
			className={`inline-flex items-center rounded border border-border-strong border-b-2 bg-surface px-1.5 py-px font-mono text-[11px] text-text-2 ${className}`}
		>
			{children}
		</kbd>
	);
}
