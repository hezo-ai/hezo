import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';

interface BreadcrumbItem {
	key?: string;
	label: ReactNode;
	to?: string;
	params?: Record<string, string>;
}

interface BreadcrumbProps {
	items: BreadcrumbItem[];
}

export function Breadcrumb({ items }: BreadcrumbProps) {
	return (
		<nav className="flex items-center gap-2 pb-4 text-[13px] text-text-muted">
			{items.map((item, i) => {
				const isLast = i === items.length - 1;
				return (
					<span key={item.key ?? item.to ?? String(item.label)} className="flex items-center gap-2">
						{i > 0 && <span className="opacity-40">/</span>}
						{item.to && !isLast ? (
							<Link to={item.to} params={item.params ?? {}} className="hover:text-text">
								{item.label}
							</Link>
						) : (
							<span className={isLast ? 'text-text font-medium' : ''}>{item.label}</span>
						)}
					</span>
				);
			})}
		</nav>
	);
}
