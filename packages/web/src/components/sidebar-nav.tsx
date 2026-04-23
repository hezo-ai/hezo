import { Link, useMatchRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';

interface SidebarNavItem {
	to: string;
	params?: Record<string, string>;
	label: React.ReactNode;
	count?: number;
	subItems?: SidebarNavItem[];
}

export interface SidebarNavSection {
	title?: string;
	titleTo?: string;
	titleParams?: Record<string, string>;
	items: SidebarNavItem[];
	collapsible?: boolean;
	collapsed?: boolean;
	onToggle?: () => void;
	children?: SidebarNavItem[];
	onAdd?: () => void;
	addLabel?: string;
}

interface SidebarNavProps {
	sections: SidebarNavSection[];
}

const TITLE_TEXT_CLASSES = 'uppercase text-[11px] text-text-subtle font-medium tracking-wide';

export function SidebarNav({ sections }: SidebarNavProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav className="flex flex-col gap-0.5 sticky top-0">
			{sections.map((section) => (
				<div key={section.title ?? `section-${sections.indexOf(section)}`}>
					{section.title && <SectionHeader section={section} />}
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
								<div key={`${item.to}-${JSON.stringify(item.params)}`}>
									<Link
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
									{isActive &&
										item.subItems?.map((subItem) => {
											const isSubActive = matchRoute({
												to: subItem.to,
												params: subItem.params,
											});
											return (
												<Link
													key={`${subItem.to}-${JSON.stringify(subItem.params)}`}
													to={subItem.to}
													params={subItem.params ?? {}}
													className={`block text-left text-[13px] pl-8 pr-3 py-1 rounded-radius-md transition-colors ${
														isSubActive
															? 'text-text font-medium bg-bg-subtle'
															: 'text-text-muted hover:text-text hover:bg-bg-subtle'
													}`}
												>
													{subItem.label}
												</Link>
											);
										})}
								</div>
							);
						})}
				</div>
			))}
		</nav>
	);
}

function SectionHeader({ section }: { section: SidebarNavSection }) {
	if (!section.collapsible && !section.onAdd && !section.titleTo) {
		return <div className={`${TITLE_TEXT_CLASSES} px-3 pt-3 pb-1`}>{section.title}</div>;
	}

	const chevron = section.collapsible && (
		<svg
			aria-hidden="true"
			className={`w-3 h-3 transition-transform shrink-0 ${section.collapsed ? '' : 'rotate-90'}`}
			viewBox="0 0 16 16"
			fill="currentColor"
		>
			<path d="M6 3l5 5-5 5V3z" />
		</svg>
	);

	const addButton = section.onAdd && (
		<button
			type="button"
			onClick={section.onAdd}
			className="text-text-subtle hover:text-text transition-colors p-0.5 -m-0.5 cursor-pointer shrink-0"
			title={section.addLabel ?? 'Add'}
			aria-label={section.addLabel ?? 'Add'}
		>
			<Plus className="w-3.5 h-3.5" />
		</button>
	);

	const titleNode = section.titleTo ? (
		<Link
			to={section.titleTo}
			params={section.titleParams ?? {}}
			className={`${TITLE_TEXT_CLASSES} flex-1 text-left hover:text-text transition-colors`}
		>
			{section.title}
		</Link>
	) : section.collapsible ? (
		<button
			type="button"
			onClick={section.onToggle}
			className={`${TITLE_TEXT_CLASSES} flex items-center justify-between flex-1 text-left hover:text-text transition-colors cursor-pointer gap-2`}
		>
			<span>{section.title}</span>
			{chevron}
		</button>
	) : (
		<span className={`${TITLE_TEXT_CLASSES} flex-1`}>{section.title}</span>
	);

	const trailingChevron = section.titleTo && section.collapsible && (
		<button
			type="button"
			onClick={section.onToggle}
			className="text-text-subtle hover:text-text transition-colors p-0.5 -m-0.5 cursor-pointer"
			aria-label={section.collapsed ? 'Expand' : 'Collapse'}
		>
			{chevron}
		</button>
	);

	return (
		<div className="flex items-center justify-between px-3 pt-3 pb-1 gap-2">
			{titleNode}
			{(addButton || trailingChevron) && (
				<div className="flex items-center gap-1.5">
					{addButton}
					{trailingChevron}
				</div>
			)}
		</div>
	);
}
