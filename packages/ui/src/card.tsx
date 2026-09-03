import type { HTMLAttributes, ReactNode } from 'react';

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
}

// Wire's `.hz-card`: surface + hairline border + xs elevation, lg radius.
export function Card({ className = '', children, ...props }: CardProps) {
	return (
		<div
			className={`rounded-lg border border-border bg-surface p-4 shadow-xs transition-[border-color] duration-150 hover:border-border-strong ${className}`}
			{...props}
		>
			{children}
		</div>
	);
}
