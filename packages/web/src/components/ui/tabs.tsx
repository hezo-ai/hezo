import { Link, useMatchRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

interface TabItem {
	to: string;
	params?: Record<string, string>;
	label: string;
	count?: number;
	badge?: ReactNode;
}

interface TabsProps {
	items: TabItem[];
}

// Wire's `.hz-tab`: underline tabs, neutral active (text-1 + bottom border),
// counts rendered in Geist Mono.
export function Tabs({ items }: TabsProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav className="mb-5 flex gap-5 border-b border-border">
			{items.map((item) => {
				const isActive = matchRoute({ to: item.to, params: item.params, fuzzy: true });
				return (
					<Link
						key={item.to}
						to={item.to}
						params={item.params ?? {}}
						className={`-mb-px border-b-2 py-2 text-[13.5px] font-medium transition-colors ${
							isActive
								? 'border-text-1 text-text-1'
								: 'border-transparent text-text-2 hover:text-text-1'
						}`}
					>
						{item.label}
						{item.count != null && (
							<span className="ml-1.5 font-mono text-[11px] text-text-3">{item.count}</span>
						)}
						{item.badge}
					</Link>
				);
			})}
		</nav>
	);
}
