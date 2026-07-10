import { Link, useLocation } from '@tanstack/react-router';
import { ChevronDown, LogOut } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../hooks/use-me';
import { logout } from '../lib/auth';
import { queryClient } from '../lib/query-client';

interface NavItem {
	to: string;
	label: string;
}

// General (instance settings) and AI providers are visible to everyone; the
// instance-level resources below are Admin (superuser) only.
const PUBLIC_ITEMS: NavItem[] = [
	{ to: '/settings', label: 'General' },
	{ to: '/settings/ai-providers', label: 'AI providers' },
];

const ADMIN_ITEMS: NavItem[] = [
	{ to: '/settings/admin-password', label: 'Admin password' },
	{ to: '/settings/chatbox', label: 'Chatbox' },
	{ to: '/settings/skills', label: 'Skills' },
	{ to: '/settings/connectors', label: 'Connectors' },
	{ to: '/settings/credentials', label: 'Credentials' },
	{ to: '/settings/api-keys', label: 'API keys' },
	{ to: '/settings/audit-log', label: 'Activity' },
];

/** Exact-match the route against a nav item (every settings path is a distinct leaf). */
function isActive(itemTo: string, pathname: string): boolean {
	return (pathname.replace(/\/$/, '') || '/settings') === itemTo;
}

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
	return (
		<button
			type="button"
			onClick={onClick}
			data-testid="settings-logout"
			className={`flex items-center gap-2 text-left text-[13px] px-3 py-1.5 rounded-md transition-colors cursor-pointer text-text-2 hover:text-text-1 hover:bg-surface-2 ${className ?? ''}`}
		>
			<LogOut className="w-4 h-4 shrink-0" />
			<span>Log out</span>
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
export function SettingsSidebar() {
	const { data: me } = useMe();
	const pathname = useLocation({ select: (l) => l.pathname });
	const [open, setOpen] = useState(false);

	const items = me?.is_superuser ? [...PUBLIC_ITEMS, ...ADMIN_ITEMS] : PUBLIC_ITEMS;
	const current = items.find((i) => isActive(i.to, pathname)) ?? items[0];

	// Collapse the mobile dropdown on any route change.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the deliberate trigger
	useEffect(() => {
		setOpen(false);
	}, [pathname]);

	const handleLogout = useCallback(() => {
		setOpen(false);
		logout();
		// Reset every query: drops each back to its initial (data-less) state so no
		// authenticated response lingers behind the sign-in screen, and refetches
		// the active ones. Crucially, the top-level gate's `me` probe re-runs and —
		// with the token now cleared — 401s, flipping the app to the admin-password
		// sign-in screen. (A plain `invalidateQueries`/`clear` won't do this: an
		// invalidated query keeps its last data on a failed refetch, and a cleared
		// query's mounted observer doesn't reliably re-probe.)
		queryClient.resetQueries();
	}, []);

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
					<span>{current.label}</span>
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
							{items.map((item) => (
								<Link
									key={item.to}
									to={item.to}
									onClick={() => setOpen(false)}
									className={itemClass(isActive(item.to, pathname))}
								>
									{item.label}
								</Link>
							))}
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
				{items.map((item) => (
					<Link key={item.to} to={item.to} className={itemClass(isActive(item.to, pathname))}>
						{item.label}
					</Link>
				))}
				<LogoutButton onClick={handleLogout} className="mt-4" />
			</nav>
		</>
	);
}
