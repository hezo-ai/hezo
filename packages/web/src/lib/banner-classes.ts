/**
 * Shared class strings for the project-scoped sticky banners that render at the
 * very top of `<main>` (container status, budget).
 *
 * They need a common home for one reason beyond deduplication: when the project
 * menu is collapsed, `<main>` starts at the project rail's right edge, which is
 * exactly where the expand tab docks (`__root.tsx`). The tab is drawn above the
 * banners so it can never be buried, so without an inset it would sit on top of
 * a banner's leading icon. Both banners therefore shift their content past the
 * tab whenever the menu is collapsed.
 */

/** Width of the expand tab (28px) plus the banners' usual 16px gutter. */
const EXPAND_TAB_CLEARANCE = 'lg:pl-11';

/**
 * Left inset that clears the collapsed-menu expand tab. Empty when the menu is
 * expanded (no tab is rendered, so the default `px-4` gutter is correct), and
 * `lg:`-gated because the tab itself is desktop-only.
 */
export function bannerInsetClass(menuCollapsed: boolean): string {
	return menuCollapsed ? EXPAND_TAB_CLEARANCE : '';
}

/** The standard single-row banner body, inset past the expand tab when collapsed. */
export function bannerInnerClass(menuCollapsed: boolean): string {
	return `flex items-center gap-2 px-4 py-2 text-[13px] font-medium ${bannerInsetClass(menuCollapsed)}`;
}
