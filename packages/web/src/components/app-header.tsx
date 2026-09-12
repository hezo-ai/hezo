import { Link } from '@tanstack/react-router';
import { Inbox, Plus, Search, Settings, Store } from 'lucide-react';
import { useState } from 'react';
import { useActiveProject } from '../hooks/use-active-project';
import { useCeoUnread } from '../hooks/use-chat';
import { useGlobalInboxUnreadCount } from '../hooks/use-inbox-count';
import { useI18n } from '../lib/i18n';
import { CreateTaskDialog } from './create-task-dialog';
import { CountOverlayBadge } from './ui/count-overlay-badge';
import { Logo } from './ui/logo';
import { ThemeSwitcher } from './ui/theme-switcher';

const iconLinkClass =
	'w-8 h-8 rounded-md flex items-center justify-center text-text-2 hover:text-text-1 hover:bg-surface-2 transition-colors';

/**
 * The global top header: instance-wide navigation. Only Home sits at the
 * top-left; everything else (New task below lg, the CEO chat monogram, Inbox,
 * Search, Settings, and the theme switcher) lives in the top-right group.
 * Skills, Connectors, and Credentials are reached through the Settings sidebar.
 * Below `lg` the navigation is a side drawer, so the logo doubles as the drawer
 * toggle; at `lg`+ the rail/sidebar are persistent and the logo links home.
 */
export function AppHeader({
	onOpenDrawer,
	onOpenSearch,
	chatOpen,
	onToggleChat,
}: {
	onOpenDrawer: () => void;
	onOpenSearch: () => void;
	chatOpen: boolean;
	onToggleChat: () => void;
}) {
	const { t } = useI18n();
	const inboxUnread = useGlobalInboxUnreadCount();
	// HQ-scope unread only: replies landing in the CEO stream while the dock is
	// closed. Project DMs badge their own cards in the project menu instead.
	const ceoUnread = useCeoUnread(chatOpen);
	// The mobile "New task" entry point: a create-task dialog with a project
	// picker defaulting to the currently viewed project. Scoped `lg:hidden`
	// because at lg+ the persistent project menu carries its own "+" next to
	// the Tasks link.
	const active = useActiveProject();
	const [newTaskOpen, setNewTaskOpen] = useState(false);

	return (
		<header
			className="h-12 shrink-0 border-b border-border bg-surface flex items-center justify-between px-2 gap-1"
			data-testid="app-header"
		>
			<div className="flex items-center gap-0.5">
				{/* Below lg the menu is a side drawer - the logo opens it. */}
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
				{/* At lg+ the rail/sidebar are persistent - the logo links home. */}
				<Link
					to="/home"
					aria-label={t('nav.home')}
					title={t('nav.home')}
					data-testid="app-header-home"
					className="hidden lg:flex items-center justify-center w-8 h-8"
				>
					<Logo size="sm" />
				</Link>
			</div>

			<div className="flex items-center gap-0.5">
				{/* Leftmost of the action group. Styled as a quiet outlined button -
				    transparent fill, primary-red border and "+" - so it sits with the
				    other nav icons while the accent still marks it as the create action.
				    The 32px tap target matches its neighbours; the bordered box inside is
				    a compact 22px with an edge-to-edge plus. */}
				<button
					type="button"
					onClick={() => setNewTaskOpen(true)}
					aria-label="New task"
					title="New task"
					data-testid="app-header-new-task"
					className={`${iconLinkClass} lg:hidden`}
				>
					<span className="flex h-[22px] w-[22px] items-center justify-center rounded-md border border-accent text-accent">
						<Plus className="h-[22px] w-[22px]" />
					</span>
				</button>
				<CreateTaskDialog
					selectProject
					projectId={active?.slug}
					open={newTaskOpen}
					onOpenChange={setNewTaskOpen}
				/>
				{/* The CEO chat launcher: a monogram, not an icon - chat is a person.
				    Toggles the dock; unread CEO replies overlay it while it's closed. */}
				<button
					type="button"
					onClick={onToggleChat}
					aria-label={t('chat.launcher.label')}
					title={t('chat.launcher.label')}
					data-testid="app-header-chat"
					className={iconLinkClass}
				>
					<span className="relative inline-flex">
						<span
							className={`flex h-[22px] w-[22px] items-center justify-center rounded-full border text-[7px] font-semibold tracking-wide ${
								chatOpen
									? 'border-text-1 bg-surface-3 text-text-1'
									: 'border-border bg-surface-3 text-text-2'
							}`}
						>
							CEO
						</span>
						<CountOverlayBadge count={ceoUnread} testId="app-header-chat-badge" />
					</span>
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
					to="/marketplace"
					aria-label="Marketplace"
					title="Team marketplace"
					data-testid="app-header-marketplace"
					className={iconLinkClass}
				>
					<Store className="w-4 h-4" />
				</Link>
				<Link
					to="/settings"
					aria-label={t('nav.settings')}
					title={t('nav.settings')}
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
