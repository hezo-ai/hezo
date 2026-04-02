import type { HTMLAttributes, ReactNode } from 'react';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
	children: ReactNode;
}

export function Card({ className = '', children, ...props }: CardProps) {
	return (
		<div
			className={`rounded-radius-lg border border-border bg-bg p-4 transition-[border-color] duration-150 hover:border-border-hover ${className}`}
			{...props}
		>
			{children}
		</div>
	);
}
