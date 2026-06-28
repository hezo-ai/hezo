import { Link } from '@tanstack/react-router';
import { BookOpen, FolderKanban, Inbox, Search, Settings } from 'lucide-react';
import { useGlobalInboxUnreadCount } from '../hooks/use-inbox-count';
import { useMe } from '../hooks/use-me';
import { CountOverlayBadge } from './ui/count-overlay-badge';
import { Logo } from './ui/logo';
import { ThemeSwitcher } from './ui/theme-switcher';

const iconLinkClass =
	'w-8 h-8 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface-2 transition-colors';

/**
 * The global top header: instance-wide navigation. Only Home sits at the
 * top-left; everything else (Inbox, All Tasks, the Admin-only Skills
 * shortcut, Settings, and the theme switcher) lives in the top-right group.
 * Connectors and Credentials are reached through the Settings sidebar.
 * Below `lg` the navigation is a side drawer, so the logo doubles as the drawer
 * toggle; at `lg`+ the rail/sidebar are persistent and the logo links home.
 */
export function AppHeader({
	onOpenDrawer,
	onOpenSearch,
}: {
	onOpenDrawer: () => void;
	onOpenSearch: () => void;
}) {
	const { data: me } = useMe();
	const inboxUnread = useGlobalInboxUnreadCount();

	return (
		<header
			className="h-12 shrink-0 border-b border-border bg-surface flex items-center justify-between px-2 gap-1"
			data-testid="app-header"
		>
			<div className="flex items-center gap-0.5">
				{/* Below lg the menu is a side drawer — the logo opens it. */}
				<button
					type="button"
					onClick={onOpenDrawer}
					aria-label="Open navigation"
					title="Open navigation"
					data-testid="mobile-nav-toggle"
					className="lg:hidden flex items-center justify-center w-8 h-8"
				>
					<Logo size="sm" />
				</button>
				{/* At lg+ the rail/sidebar are persistent — the logo links home. */}
				<Link
					to="/home"
					aria-label="Home"
					title="Home"
					data-testid="app-header-home"
					className="hidden lg:flex items-center justify-center w-8 h-8"
				>
					<Logo size="sm" />
				</Link>
			</div>

			<div className="flex items-center gap-0.5">
				<button
					type="button"
					onClick={onOpenSearch}
					aria-label="Search"
					title="Search (⌘K)"
					data-testid="app-header-search"
					className={iconLinkClass}
				>
					<Search className="w-4 h-4" />
				</button>
				<Link
					to="/home/inbox"
					aria-label="Inbox"
					title="Inbox"
					data-testid="app-header-inbox"
					className={iconLinkClass}
				>
					<span className="relative inline-flex">
						<Inbox className="w-4 h-4" />
						<CountOverlayBadge count={inboxUnread} testId="app-header-inbox-badge" />
					</span>
				</Link>
				<Link
					to="/home/tasks"
					aria-label="All Tasks"
					title="All Tasks"
					data-testid="app-header-all-tasks"
					className={iconLinkClass}
				>
					<FolderKanban className="w-4 h-4" />
				</Link>
				{me?.is_superuser && (
					<Link
						to="/settings/skills"
						aria-label="Skills"
						title="Skills"
						data-testid="app-header-skills"
						className={iconLinkClass}
					>
						<BookOpen className="w-4 h-4" />
					</Link>
				)}
				<Link
					to="/settings"
					aria-label="Settings"
					title="Settings"
					data-testid="app-header-settings"
					className={iconLinkClass}
				>
					<Settings className="w-4 h-4" />
				</Link>
				<ThemeSwitcher />
			</div>
		</header>
	);
}
