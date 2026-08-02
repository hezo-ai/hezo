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

// A small bordered "+" chip, used both as an inline suffix to a row label (Tasks)
// and a section title (Team). Round border with padding so it reads as a button.
// Hidden on mobile (`<md`): the drawer's tap targets are too easy to hit by
// accident, so the "+" only appears from tablet up. Mobile users create tasks via
// the app header's "New task" button and hire from the Team page's "Hire agent" button.
const ADD_CHIP_CLASSES =
	'hidden md:inline-flex shrink-0 items-center rounded-md border border-border p-0.5 text-text-3 transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-text-1 cursor-pointer';

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
				className={`ml-2 ${ADD_CHIP_CLASSES}`}
			>
				<Plus className="w-3 h-3" />
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
					{section.items.map((item) => {
						// A sub-item disclosure also stays open while the user is on one of the
						// sub-item routes. Those routes come in two shapes: siblings that don't
						// fuzzy-match the parent at all (Settings → /git, /connectors), and children
						// nested under it (Progress → /progress/goals).
						const subActive =
							item.subItems?.some((s) => matchRoute({ to: s.to, params: s.params, fuzzy: true })) ??
							false;
						// A nested sub-item fuzzy-matches its parent's route, which would light up
						// both rows at once. Highlight the parent on an exact match in that case, so
						// only the row the user is actually on reads as active.
						const isActive = subActive
							? !!matchRoute({ to: item.to, params: item.params })
							: !!matchRoute({ to: item.to, params: item.params, fuzzy: true });
						const paddingClass = section.title ? 'pl-4 pr-2 py-0.5' : 'px-2.5 py-1';
						const key = `${item.to}-${JSON.stringify(item.params)}`;
						const link = (
							<Link
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
						// Plain items render exactly as before (no wrapper). An item with an
						// inline action makes the whole row navigate, with its bordered "+"
						// sitting right after the label (the count, if any, stays pinned to the
						// far right); the "+" stops propagation so clicking it never follows the
						// row's link. Items with sub-items wrap so the disclosure can sit beneath
						// the parent.
						if (!item.subItems?.length) {
							if (item.action) {
								return (
									<Link
										key={key}
										to={item.to}
										params={item.params ?? {}}
										data-testid={item.testId}
										className={`group flex items-center text-left text-[12px] ${paddingClass} rounded-md transition-colors ${
											isActive
												? 'text-text-1 font-medium bg-surface-2'
												: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
										}`}
									>
										{item.label}
										<ItemAction action={item.action} />
										<CountBadge value={item.count} />
									</Link>
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
				</div>
			))}
		</nav>
	);
}

function SectionHeader({ section }: { section: SidebarNavSection }) {
	if (!section.onAdd && !section.titleTo) {
		return <div className={`${TITLE_TEXT_CLASSES} px-2.5 pt-2.5 pb-0.5`}>{section.title}</div>;
	}

	const addButton = section.onAdd && (
		<Tooltip content={section.addLabel ?? 'Add'} side="right">
			<button
				type="button"
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					section.onAdd?.();
				}}
				className={`ml-2 ${ADD_CHIP_CLASSES}`}
				aria-label={section.addLabel ?? 'Add'}
			>
				<Plus className="w-3 h-3" />
			</button>
		</Tooltip>
	);

	// With a destination the whole header row navigates there; the "+" suffix sits
	// right after the title and stops propagation so it never follows the link.
	if (section.titleTo) {
		return (
			<Link
				to={section.titleTo}
				params={section.titleParams ?? {}}
				// The "+" nests inside the row link, so pin the link's accessible name to
				// the title (otherwise it would absorb the add button's label).
				aria-label={section.title}
				className={`${TITLE_TEXT_CLASSES} flex items-center px-2.5 pt-2.5 pb-0.5 hover:text-text-1 transition-colors`}
			>
				{section.title}
				{addButton}
			</Link>
		);
	}

	return (
		<div className={`${TITLE_TEXT_CLASSES} flex items-center px-2.5 pt-2.5 pb-0.5`}>
			<span>{section.title}</span>
			{addButton}
		</div>
	);
}
