import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
}

export function Card({ className = '', children, ...props }: CardProps) {
	return (
		<div className={`rounded-lg border border-border bg-bg-subtle p-4 ${className}`} {...props}>
			{children}
		</div>
	);
}
