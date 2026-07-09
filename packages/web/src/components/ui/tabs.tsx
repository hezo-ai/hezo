import { Link, useMatchRoute } from '@tanstack/react-router';
import type { ReactNode } from 'react';

export interface TabItem {
	/** Stable identity + controlled-mode value. Defaults to `to` when omitted. */
	key?: string;
	label: ReactNode;
	/** Route-mode target. Used when the component is not in controlled mode. */
	to?: string;
	params?: Record<string, string>;
	/** Optional leading icon. */
	icon?: ReactNode;
	/** Optional trailing count, rendered as "(n)". */
	count?: number;
	badge?: ReactNode;
	testId?: string;
}

interface TabsProps {
	items: TabItem[];
	/** Controlled mode: when `onValueChange` is provided, tabs render as buttons driven by `value`. */
	value?: string;
	onValueChange?: (key: string) => void;
	/**
	 * Background utility for the active ("in front") tab. It must match the panel
	 * directly below the tab strip so the selected tab visually merges into it —
	 * the browser/folder-tab look. Defaults to the page background `bg-bg`; pass
	 * `bg-surface` when the tabs sit above a surface panel (e.g. inside a modal).
	 */
	activeSurface?: string;
	'aria-label'?: string;
	/** Extra classes for the tab-strip container (e.g. margins). */
	className?: string;
}

// Folder ("browser tab") styling, defined once. The active tab gets top + side
// borders and a rounded top, then pulls itself down 1px (`-mb-px`) and paints an
// opaque bottom border the same colour as the panel below (`border-b-<surface>`)
// so it covers the strip's baseline border and reads as raised in front of the
// others, merging into that panel. A *transparent* bottom border wouldn't do it:
// the strip's baseline shows straight through, so the active tab reads as a
// closed box with a bottom border. Inactive tabs stay recessed on the baseline.
const BASE_TAB =
	'relative flex items-center gap-1.5 rounded-t-md border px-3 py-2 text-[13px] font-medium transition-colors';

// Maps each supported active-surface fill to the matching bottom-border colour.
// Kept as literal class strings (not derived at runtime) so Tailwind's scanner
// emits the utilities. Falls back to `border-b-bg` for any unlisted surface.
const SURFACE_BOTTOM_BORDER: Record<string, string> = {
	'bg-bg': 'border-b-bg',
	'bg-surface': 'border-b-surface',
};

function tabClass(isActive: boolean, activeSurface: string): string {
	if (!isActive) {
		return `${BASE_TAB} border-transparent bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-text-1`;
	}
	const bottomBorder = SURFACE_BOTTOM_BORDER[activeSurface] ?? 'border-b-bg';
	return `${BASE_TAB} z-10 -mb-px border-border ${bottomBorder} ${activeSurface} text-text-1`;
}

function TabInner({ item }: { item: TabItem }) {
	return (
		<>
			{item.icon}
			{item.label}
			{item.count != null && <span className="ml-0.5 text-text-3">({item.count})</span>}
			{item.badge}
		</>
	);
}

function tabStripClass(className?: string): string {
	return `flex items-end gap-1 border-b border-border${className ? ` ${className}` : ''}`;
}

/**
 * Route-mode tab strip: active state is derived from the current URL, tabs are
 * `<Link>`s. Isolated in its own component so the router hook is only called
 * when actually in route mode.
 */
function RouteTabs({
	items,
	activeSurface = 'bg-bg',
	className,
	'aria-label': ariaLabel,
}: TabsProps) {
	const matchRoute = useMatchRoute();
	return (
		<nav aria-label={ariaLabel} className={tabStripClass(className)}>
			{items.map((item) => {
				if (!item.to) return null;
				const isActive = !!matchRoute({ to: item.to, params: item.params, fuzzy: true });
				return (
					<Link
						key={item.key ?? item.to}
						to={item.to}
						params={item.params ?? {}}
						data-testid={item.testId}
						className={tabClass(isActive, activeSurface)}
					>
						<TabInner item={item} />
					</Link>
				);
			})}
		</nav>
	);
}

/** Controlled-mode tab strip: active state is driven by `value`, tabs are buttons. */
function ControlledTabs({
	items,
	value,
	onValueChange,
	activeSurface = 'bg-bg',
	className,
	'aria-label': ariaLabel,
}: TabsProps) {
	return (
		<div role="tablist" aria-label={ariaLabel} className={tabStripClass(className)}>
			{items.map((item) => {
				const key = item.key ?? item.to ?? '';
				const isActive = key === value;
				return (
					<button
						key={key}
						type="button"
						role="tab"
						aria-selected={isActive}
						data-testid={item.testId}
						onClick={() => onValueChange?.(key)}
						className={tabClass(isActive, activeSurface)}
					>
						<TabInner item={item} />
					</button>
				);
			})}
		</div>
	);
}

export function Tabs(props: TabsProps) {
	return props.onValueChange != null ? <ControlledTabs {...props} /> : <RouteTabs {...props} />;
}
