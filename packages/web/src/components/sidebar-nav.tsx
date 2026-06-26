import { Link, useMatchRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Fragment } from 'react';
import { Tooltip } from './ui/tooltip';

interface SidebarNavItemAction {
	onClick: () => void;
	label: string;
	testId?: string;
}

interface SidebarNavItem {
	to: string;
	params?: Record<string, string>;
	label: React.ReactNode;
	count?: number;
	subItems?: SidebarNavItem[];
	testId?: string;
	/** An inline "+" affordance rendered to the right of the row (e.g. create a
	 *  task next to the Tasks link). Clicking it never follows the row's link. */
	action?: SidebarNavItemAction;
}

function ItemAction({ action }: { action: SidebarNavItemAction }) {
	return (
		<Tooltip content={action.label} side="right">
			<button
				type="button"
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					action.onClick();
				}}
				data-testid={action.testId}
				aria-label={action.label}
				className="mr-1 shrink-0 rounded-sm p-0.5 text-text-3 transition-colors hover:bg-surface-2 hover:text-text-1 cursor-pointer"
			>
				<Plus className="w-3.5 h-3.5" />
			</button>
		</Tooltip>
	);
}

function CountBadge({ value }: { value: number | undefined }) {
	if (!value) return null;
	return <span className="ml-auto pl-2 font-mono text-[11px] text-text-3">{value}</span>;
}

/**
 * Renders an item's nested sub-items, indented a level beyond the parent. The
 * caller decides whether to mount this (a sub-item disclosure opens when the
 * parent — or one of these sub-items — is the active route).
 */
function SubItemList({
	subItems,
	matchRoute,
}: {
	subItems: SidebarNavItem[];
	matchRoute: ReturnType<typeof useMatchRoute>;
}) {
	return (
		<>
			{subItems.map((subItem) => {
				const isSubActive = matchRoute({ to: subItem.to, params: subItem.params });
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
		</>
	);
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
							// A sub-item disclosure also stays open while the user is on one of the
							// sub-item routes (which don't fuzzy-match the parent's own route).
							const subActive =
								item.subItems?.some((s) =>
									matchRoute({ to: s.to, params: s.params, fuzzy: true }),
								) ?? false;
							const paddingClass = section.title ? 'pl-4 pr-2 py-0.5' : 'px-2.5 py-1';
							const key = `${item.to}-${JSON.stringify(item.params)}`;
							const link = (
								<Link
									to={item.to}
									params={item.params ?? {}}
									data-testid={item.testId}
									className={`flex items-center text-left text-[12px] ${paddingClass} rounded-md transition-colors ${
										item.action ? 'flex-1 min-w-0' : ''
									} ${
										isActive
											? 'text-text-1 font-medium bg-surface-2'
											: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
									}`}
								>
									{item.label}
									<CountBadge value={item.count} />
								</Link>
							);
							// Plain items render exactly as before (no wrapper). An item with an
							// inline action sits beside its "+" on one row; items with sub-items
							// wrap so the disclosure can sit beneath the parent.
							if (!item.subItems?.length) {
								if (item.action) {
									return (
										<div key={key} className="flex items-center">
											{link}
											<ItemAction action={item.action} />
										</div>
									);
								}
								return <Fragment key={key}>{link}</Fragment>;
							}
							return (
								<div key={key}>
									{link}
									{(isActive || subActive) && (
										<SubItemList subItems={item.subItems} matchRoute={matchRoute} />
									)}
								</div>
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
									{isActive && item.subItems && (
										<SubItemList subItems={item.subItems} matchRoute={matchRoute} />
									)}
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
