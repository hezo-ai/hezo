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

export function Tabs({ items }: TabsProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav className="flex border-b border-border mb-5">
			{items.map((item) => {
				const isActive = matchRoute({ to: item.to, params: item.params, fuzzy: true });
				return (
					<Link
						key={item.to}
						to={item.to}
						params={item.params ?? {}}
						className={`px-4 py-2 text-[13px] border-b-2 transition-colors ${
							isActive
								? 'text-text font-medium border-text'
								: 'text-text-muted border-transparent hover:text-text'
						}`}
					>
						{item.label}
						{item.count != null && (
							<span className="ml-1.5 bg-bg-subtle px-[7px] py-px rounded-full text-[11px] font-normal">
								{item.count}
							</span>
						)}
						{item.badge}
					</Link>
				);
			})}
		</nav>
	);
}
