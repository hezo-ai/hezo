import { Link, useLocation } from '@tanstack/react-router';
import { ChevronDown, ExternalLink, LogOut } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useCloseOnRouteChange } from '../hooks/use-close-on-route-change';
import { useInstanceSettings } from '../hooks/use-instance-settings';
import { useMe } from '../hooks/use-me';
import { useStatus } from '../hooks/use-status';
import { logout } from '../lib/auth';
import { type MessageKey, useI18n } from '../lib/i18n';
import { queryClient } from '../lib/query-client';

interface NavItem {
	to: string;
	/** Catalog key; resolved through `t()` so the menu follows the instance language. */
	labelKey: MessageKey;
	/** Superuser-only. Its page refuses non-admins too; this keeps the menu honest. */
	admin?: boolean;
}

interface NavGroup {
	titleKey: MessageKey;
	items: NavItem[];
}

/**
 * The menu, grouped by what a page is *about*. There is deliberately no
 * "public" / "admin" split any more: each page already refuses a non-admin on
 * its own, and a seam that only some readers can see past told them nothing.
 * Admin-only leaves are simply filtered out for everyone else.
 */
const NAV_GROUPS: NavGroup[] = [
	{
		titleKey: 'settings.groups.general',
		items: [
			{ to: '/settings', labelKey: 'settings.instance' },
			{ to: '/settings/appearance', labelKey: 'settings.appearance' },
			{ to: '/settings/locale', labelKey: 'locale.settings.title' },
		],
	},
	{
		titleKey: 'settings.groups.agents',
		items: [
			{ to: '/settings/ai-providers', labelKey: 'settings.aiProviders' },
			{ to: '/settings/containers', labelKey: 'settings.concurrency', admin: true },
			{ to: '/settings/skills', labelKey: 'settings.skills', admin: true },
		],
	},
	{
		titleKey: 'settings.groups.integrations',
		items: [
			{ to: '/settings/connectors', labelKey: 'settings.connectors', admin: true },
			{ to: '/settings/chat-channels', labelKey: 'settings.chat', admin: true },
			{ to: '/settings/credentials', labelKey: 'settings.credentials', admin: true },
		],
	},
	{
		titleKey: 'settings.groups.access',
		items: [
			{ to: '/settings/users', labelKey: 'settings.usersAccess', admin: true },
			{ to: '/settings/api-keys', labelKey: 'settings.apiKeys', admin: true },
		],
	},
	{
		titleKey: 'settings.groups.maintenance',
		items: [
			{ to: '/settings/storage', labelKey: 'settings.storage', admin: true },
			{ to: '/settings/audit-log', labelKey: 'settings.auditLog', admin: true },
			{ to: '/settings/archived-projects', labelKey: 'settings.archivedProjects', admin: true },
		],
	},
];

/** Exact-match the route against a nav item (every settings path is a distinct leaf). */
function isActive(itemTo: string, pathname: string): boolean {
	return (pathname.replace(/\/$/, '') || '/settings') === itemTo;
}

/**
 * Group heading: a label for what follows, not a target. Three things keep it
 * from reading as another link in the same column - it is set as an eyebrow
 * (small, uppercase and letter-spaced against the 13px items), it is bolder and
 * darker than anything it labels, and a hairline runs off it to the menu's edge,
 * which no link ever does. `font-bold` overrides the eyebrow's own 500: the
 * utility is declared earlier in the sheet, so the later class wins. Spacing
 * binds the label to its own items: open above the group, tight below.
 */
function GroupHeading({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 px-3 pb-1.5">
			<span className="text-eyebrow font-bold text-text-1">{label}</span>
			<span className="h-px flex-1 bg-border" />
		</div>
	);
}

/** Groups after the first are pushed apart; the rule alone is too quiet to separate them. */
const groupClass = 'flex flex-col gap-0.5 mt-4 first:mt-0';

function itemClass(active: boolean): string {
	return `text-left text-[13px] px-3 py-1.5 rounded-md transition-colors cursor-pointer ${
		active
			? 'text-text-1 font-medium bg-surface-2'
			: 'text-text-2 hover:text-text-1 hover:bg-surface-2'
	}`;
}

/**
 * "Log out" action pinned to the bottom of the menu, separated from the nav
 * items by a gap. Clears the session token and wipes the cached, authenticated
 * data, then re-evaluates the top-level gate — with no session the `me` probe
 * 401s and the app falls back to the admin-password sign-in screen.
 */
function LogoutButton({ onClick, className }: { onClick: () => void; className?: string }) {
	const { t } = useI18n();
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid="settings-logout"
			className={`flex items-center gap-2 text-left text-[13px] px-3 py-1.5 rounded-md transition-colors cursor-pointer text-text-2 hover:text-text-1 hover:bg-surface-2 ${className ?? ''}`}
		>
			<LogOut className="w-4 h-4 shrink-0" />
			<span>{t('settings.logOut')}</span>
		</button>
	);
}

/**
 * Navigation for the Settings section, shared across the main page and every
 * subpage so the menu is always present.
 *  - Desktop (md+): a persistent left sidebar, sticky to the top of the scroll
 *    area.
 *  - Mobile (<md): a collapsed button pinned (sticky) to the top of the scroll
 *    area, showing the current subpage; tapping expands a dropdown panel with a
 *    solid background and backdrop so it never bleeds the content scrolling
 *    beneath it.
 */
/**
 * The one row that leaves Hezo: where a deployment fixed some settings, this is
 * where an operator goes to change them.
 *
 * Rendered only when a policy carries a link - a group labelled after the
 * deployer with nothing under it would be worse than no group. Core ships the
 * row; the label and the destination are config, so nothing here names any
 * particular deployment.
 *
 * Validated as `https:` at parse and again here: React does not reliably block a
 * `javascript:` href, and the string is operator-authored. No query params and
 * no token - the URL lands in access logs and in browser history, and a
 * top-level navigation already carries whatever session the destination uses.
 */
function PolicyGroup() {
	const { t } = useI18n();
	const { data: settings } = useInstanceSettings();
	const policy = settings?.policy;
	if (!policy?.manage_url?.startsWith('https://')) return null;

	return (
		<div className={groupClass} data-testid="settings-policy-group">
			<GroupHeading label={policy.managed_by} />
			<a
				href={policy.manage_url}
				target="_blank"
				rel="noopener noreferrer"
				className={`${itemClass(false)} flex items-center gap-2`}
				data-testid="settings-policy-link"
			>
				<span className="flex-1">{t('settings.managed.planAndLimits')}</span>
				<ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
			</a>
		</div>
	);
}

export function SettingsSidebar() {
	const { t } = useI18n();
	const { data: me } = useMe();
	const pathname = useLocation({ select: (l) => l.pathname });
	const [open, setOpen] = useState(false);

	const groups = NAV_GROUPS.map((g) => ({
		...g,
		items: g.items.filter((i) => me?.is_superuser || !i.admin),
	})).filter((g) => g.items.length > 0);
	const items = groups.flatMap((g) => g.items);
	const current = items.find((i) => isActive(i.to, pathname)) ?? items[0];

	// Collapse the mobile dropdown on any route change — every item in it is a nav
	// link, and the panel covers the page one just opened.
	useCloseOnRouteChange(open, () => setOpen(false));

	const { data: status } = useStatus();
	// With an issuer, signing out has to end its session too: clearing only the
	// local one leaves the issuer ready to sign the person straight back in, so
	// the button would read as broken.
	const issuerLogoutUrl = status?.sso?.logout_url;
	const handleLogout = useCallback(() => {
		setOpen(false);
		logout(issuerLogoutUrl);
		// Reset every query: drops each back to its initial (data-less) state so no
		// authenticated response lingers behind the sign-in screen, and refetches
		// the active ones. Crucially, the top-level gate's `me` probe re-runs and —
		// with the token now cleared — 401s, flipping the app to the admin-password
		// sign-in screen. (A plain `invalidateQueries`/`clear` won't do this: an
		// invalidated query keeps its last data on a failed refetch, and a cleared
		// query's mounted observer doesn't reliably re-probe.)
		queryClient.resetQueries();
	}, [issuerLogoutUrl]);

	return (
		<>
			{/* Mobile: collapsed menu pinned to the top of the scroll area. */}
			<div
				className="md:hidden sticky top-0 z-30 -mx-4 px-4 pb-2 bg-bg"
				data-testid="settings-nav-mobile"
			>
				<button
					type="button"
					onClick={() => setOpen((v) => !v)}
					aria-expanded={open}
					aria-label="Settings menu"
					data-testid="settings-nav-toggle"
					className="w-full flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-3 py-2 text-[13px] font-medium text-text-1"
				>
					<span>{t(current.labelKey)}</span>
					<ChevronDown
						className={`w-4 h-4 shrink-0 text-text-2 transition-transform ${open ? 'rotate-180' : ''}`}
					/>
				</button>
				{open && (
					<>
						<button
							type="button"
							aria-label="Close menu"
							onClick={() => setOpen(false)}
							className="fixed inset-0 z-20 cursor-default"
						/>
						<nav className="absolute left-4 right-4 z-30 mt-1 flex flex-col gap-0.5 rounded-md border border-border bg-surface p-1 shadow-lg">
							{groups.map((group) => (
								<div key={group.titleKey} className={groupClass}>
									<GroupHeading label={t(group.titleKey)} />
									{group.items.map((item) => (
										<Link
											key={item.to}
											to={item.to}
											onClick={() => setOpen(false)}
											className={itemClass(isActive(item.to, pathname))}
										>
											{t(item.labelKey)}
										</Link>
									))}
								</div>
							))}
							<PolicyGroup />
							<LogoutButton onClick={handleLogout} className="mt-3" />
						</nav>
					</>
				)}
			</div>

			{/* Desktop: persistent sidebar. */}
			<nav
				className="hidden md:flex flex-col gap-0.5 sticky top-0 self-start"
				data-testid="settings-nav-desktop"
			>
				{groups.map((group) => (
					<div key={group.titleKey} className={groupClass}>
						<GroupHeading label={t(group.titleKey)} />
						{group.items.map((item) => (
							<Link key={item.to} to={item.to} className={itemClass(isActive(item.to, pathname))}>
								{t(item.labelKey)}
							</Link>
						))}
					</div>
				))}
				<PolicyGroup />
				<LogoutButton onClick={handleLogout} className="mt-4" />
			</nav>
		</>
	);
}
