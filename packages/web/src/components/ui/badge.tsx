import type { ReactNode } from 'react';

const colorMap: Record<string, string> = {
	gray: 'bg-bg-muted text-text-muted',
	blue: 'bg-info/15 text-info',
	green: 'bg-success/15 text-success',
	yellow: 'bg-warning/15 text-warning',
	red: 'bg-danger/15 text-danger',
	purple: 'bg-primary/15 text-primary',
};

interface BadgeProps {
	color?: keyof typeof colorMap;
	children: ReactNode;
	className?: string;
}

export function Badge({ color = 'gray', children, className = '' }: BadgeProps) {
	return (
		<span
			className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colorMap[color]} ${className}`}
		>
			{children}
		</span>
	);
}
