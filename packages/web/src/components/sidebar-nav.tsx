import { Link, useMatchRoute } from '@tanstack/react-router';

interface SidebarNavItem {
	to: string;
	params?: Record<string, string>;
	label: React.ReactNode;
	count?: number;
}

export interface SidebarNavSection {
	title?: string;
	items: SidebarNavItem[];
	collapsible?: boolean;
	collapsed?: boolean;
	onToggle?: () => void;
	children?: SidebarNavItem[];
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
					{section.title &&
						(section.collapsible ? (
							<button
								type="button"
								onClick={section.onToggle}
								className="flex items-center justify-between w-full uppercase text-[11px] text-text-subtle font-medium tracking-wide px-3 pt-3 pb-1 hover:text-text transition-colors"
							>
								<span>{section.title}</span>
								<svg
									aria-hidden="true"
									className={`w-3 h-3 transition-transform ${section.collapsed ? '' : 'rotate-90'}`}
									viewBox="0 0 16 16"
									fill="currentColor"
								>
									<path d="M6 3l5 5-5 5V3z" />
								</svg>
							</button>
						) : (
							<div className="uppercase text-[11px] text-text-subtle font-medium tracking-wide px-3 pt-3 pb-1">
								{section.title}
							</div>
						))}
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
					{section.collapsible &&
						!section.collapsed &&
						section.children?.map((item) => {
							const isActive = matchRoute({ to: item.to, params: item.params, fuzzy: true });
							return (
								<Link
									key={`${item.to}-${JSON.stringify(item.params)}`}
									to={item.to}
									params={item.params ?? {}}
									className={`block text-left text-[13px] pl-5 pr-3 py-1 rounded-radius-md transition-colors ${
										isActive
											? 'text-text font-medium bg-bg-subtle'
											: 'text-text-muted hover:text-text hover:bg-bg-subtle'
									}`}
								>
									{item.label}
								</Link>
							);
						})}
				</div>
			))}
		</nav>
	);
}
