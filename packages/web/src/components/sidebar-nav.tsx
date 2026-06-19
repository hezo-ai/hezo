import { Link, useMatchRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Tooltip } from './ui/tooltip';

interface SidebarNavItem {
	to: string;
	params?: Record<string, string>;
	label: React.ReactNode;
	count?: number;
	subItems?: SidebarNavItem[];
	testId?: string;
}

function CountBadge({ value }: { value: number | undefined }) {
	if (!value) return null;
	return <span className="ml-auto pl-2 font-mono text-[11px] text-text-3">{value}</span>;
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

const TITLE_TEXT_CLASSES = 'uppercase text-[11px] text-text-3 font-medium tracking-wide';

export function SidebarNav({ sections }: SidebarNavProps) {
	const matchRoute = useMatchRoute();

	return (
		<nav aria-label="Sidebar" className="flex flex-col gap-0.5">
			{sections.map((section) => (
				<div key={section.title ?? `section-${sections.indexOf(section)}`}>
					{section.title && <SectionHeader section={section} />}
					{(!section.collapsible || !section.collapsed) &&
						section.items.map((item) => {
							const isActive = matchRoute({ to: item.to, params: item.params, fuzzy: true });
							const paddingClass = section.title ? 'pl-4 pr-2 py-0.5' : 'px-2.5 py-1';
							return (
								<Link
									key={`${item.to}-${JSON.stringify(item.params)}`}
									to={item.to}
									params={item.params ?? {}}
									data-testid={item.testId}
									className={`flex items-center text-left text-[12px] ${paddingClass} rounded-md transition-colors ${
										isActive
											? 'text-text-1 font-medium bg-surface-2'
											: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
									}`}
								>
									{item.label}
									<CountBadge value={item.count} />
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
										className={`flex items-center text-left text-[12px] pl-4 pr-2 py-0.5 rounded-md transition-colors ${
											isActive
												? 'text-text-1 font-medium bg-surface-2'
												: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
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
													data-testid={subItem.testId}
													className={`flex items-center text-left text-[12px] pl-7 pr-2 py-0.5 rounded-md transition-colors ${
														isSubActive
															? 'text-text-1 font-medium bg-surface-2'
															: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
													}`}
												>
													{subItem.label}
													<CountBadge value={subItem.count} />
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
		return <div className={`${TITLE_TEXT_CLASSES} px-2.5 pt-2.5 pb-0.5`}>{section.title}</div>;
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
		<Tooltip content={section.addLabel ?? 'Add'} side="right">
			<button
				type="button"
				onClick={section.onAdd}
				className="text-text-3 hover:text-text-1 transition-colors p-0.5 -m-0.5 cursor-pointer shrink-0"
				aria-label={section.addLabel ?? 'Add'}
			>
				<Plus className="w-3.5 h-3.5" />
			</button>
		</Tooltip>
	);

	const titleNode = section.titleTo ? (
		<Link
			to={section.titleTo}
			params={section.titleParams ?? {}}
			className={`${TITLE_TEXT_CLASSES} flex-1 text-left hover:text-text-1 transition-colors`}
		>
			{section.title}
		</Link>
	) : section.collapsible ? (
		<button
			type="button"
			onClick={section.onToggle}
			className={`${TITLE_TEXT_CLASSES} flex items-center justify-between flex-1 text-left hover:text-text-1 transition-colors cursor-pointer gap-2`}
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
			className="text-text-3 hover:text-text-1 transition-colors p-0.5 -m-0.5 cursor-pointer"
			aria-label={section.collapsed ? 'Expand' : 'Collapse'}
		>
			{chevron}
		</button>
	);

	return (
		<div className="flex items-center justify-between px-2.5 pt-2.5 pb-0.5 gap-2">
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
