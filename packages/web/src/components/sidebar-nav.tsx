import { Link, useMatchRoute } from '@tanstack/react-router';

interface SidebarNavItem {
	to: string;
	params?: Record<string, string>;
	label: string;
	count?: number;
}

export interface SidebarNavSection {
	title?: string;
	items: SidebarNavItem[];
}

interface SidebarNavProps {
	sections: SidebarNavSection[];
}

export function SidebarNav({ sections }: SidebarNavProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav className="flex flex-col gap-0.5 sticky top-0">
			{sections.map((section) => (
				<div key={section.title ?? `section-${sections.indexOf(section)}`}>
					{section.title && (
						<div className="uppercase text-[11px] text-text-subtle font-medium tracking-wide px-3 pt-3 pb-1">
							{section.title}
						</div>
					)}
					{section.items.map((item) => {
						const isActive = matchRoute({ to: item.to, params: item.params, fuzzy: true });
						return (
							<Link
								key={item.to}
								to={item.to}
								params={item.params ?? {}}
								className={`block text-left text-[13px] px-3 py-1.5 rounded-radius-md transition-colors ${
									isActive
										? 'text-text font-medium bg-bg-subtle'
										: 'text-text-muted hover:text-text hover:bg-bg-subtle'
								}`}
							>
								{item.label}
								{item.count != null && (
									<span className="ml-1.5 bg-bg-muted px-[7px] py-px rounded-full text-[11px] font-normal">
										{item.count}
									</span>
								)}
							</Link>
						);
					})}
				</div>
			))}
		</nav>
	);
}
