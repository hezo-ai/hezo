import { Link } from '@tanstack/react-router';
import { BookOpen, FolderKanban, House, Inbox, Menu, Settings } from 'lucide-react';
import { useGlobalInboxUnreadCount } from '../hooks/use-inbox-count';
import { useMe } from '../hooks/use-me';
import { ThemeSwitcher } from './ui/theme-switcher';

const iconLinkClass =
	'w-8 h-8 rounded-radius-md flex items-center justify-center text-text-muted hover:text-text hover:bg-bg-subtle transition-colors';

/**
 * The global top header: instance-wide navigation. Only Home sits at the
 * top-left; everything else (Inbox, All Tasks, the Admin-only Skills
 * shortcut, Settings, and the theme switcher) lives in the top-right group.
 * Connectors and Credentials are reached through the Settings sidebar.
 * On mobile a hamburger opens the project drawer.
 */
export function AppHeader({ onOpenDrawer }: { onOpenDrawer: () => void }) {
	const { data: me } = useMe();
	const inboxUnread = useGlobalInboxUnreadCount();

	return (
		<header
			className="h-10 shrink-0 border-b border-border bg-bg-muted flex items-center justify-between px-1.5 gap-1"
			data-testid="app-header"
		>
			<div className="flex items-center gap-0.5">
				<button
					type="button"
					onClick={onOpenDrawer}
					aria-label="Open navigation"
					data-testid="mobile-nav-toggle"
					className={`lg:hidden ${iconLinkClass}`}
				>
					<Menu className="w-4 h-4" />
				</button>
				<Link
					to="/home"
					aria-label="Home"
					title="Home"
					data-testid="app-header-home"
					className={iconLinkClass}
				>
					<House className="w-4 h-4" />
				</Link>
			</div>

			<div className="flex items-center gap-0.5">
				<Link
					to="/home/inbox"
					aria-label="Inbox"
					title="Inbox"
					data-testid="app-header-inbox"
					className={iconLinkClass}
				>
					<span className="relative inline-flex">
						<Inbox className="w-4 h-4" />
						{inboxUnread > 0 && (
							<span
								data-testid="app-header-inbox-badge"
								className="absolute -top-1.5 -right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-accent-red text-white text-[9px] leading-none font-medium flex items-center justify-center"
							>
								{inboxUnread > 99 ? '99+' : inboxUnread}
							</span>
						)}
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
