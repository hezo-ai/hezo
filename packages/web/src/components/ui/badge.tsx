import type { ReactNode } from 'react';

const colorMap: Record<string, string> = {
	neutral: 'bg-bg-subtle text-text-muted',
	gray: 'bg-bg-subtle text-text-muted',
	blue: 'bg-accent-blue-bg text-accent-blue-text',
	info: 'bg-accent-blue-bg text-accent-blue-text',
	green: 'bg-accent-green-bg text-accent-green-text',
	success: 'bg-accent-green-bg text-accent-green-text',
	yellow: 'bg-accent-amber-bg text-accent-amber-text',
	warning: 'bg-accent-amber-bg text-accent-amber-text',
	red: 'bg-accent-red-bg text-accent-red-text',
	danger: 'bg-accent-red-bg text-accent-red-text',
	purple: 'bg-accent-purple-bg text-accent-purple-text',
	pink: 'bg-accent-pink-bg text-accent-pink-text',
};

interface BadgeProps {
	color?: keyof typeof colorMap;
	children: ReactNode;
	className?: string;
}

export function Badge({ color = 'neutral', children, className = '' }: BadgeProps) {
	return (
		<span
			className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${colorMap[color] ?? colorMap.neutral} ${className}`}
		>
			{children}
		</span>
	);
}
