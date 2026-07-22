import { QueryClientProvider } from '@tanstack/react-query';
import {
	createRootRoute,
	Outlet,
	useLocation,
	useMatches,
	useNavigate,
} from '@tanstack/react-router';
import { ChevronsRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppHeader } from '../components/app-header';
import { ChatWidget } from '../components/chat/chat-widget';
import { GlobalSearchDialog } from '../components/global-search-dialog';
import { MasterKeyGate } from '../components/master-key-gate';
import { PasswordLogin } from '../components/password-login';
import { ProjectRail } from '../components/project-rail';
import { ProjectSidebar } from '../components/project-sidebar';
import { PwaInstallPrompt } from '../components/pwa-install-prompt';
import { ReloadPromptBanner } from '../components/reload-prompt-banner';
import { ScrollToBottomButton } from '../components/scroll-to-bottom-button';
import { ScrollToTopButton } from '../components/scroll-to-top-button';
import { CreatePasswordFlow, SetupGate } from '../components/setup/setup-wizard';
import { StartingScreen } from '../components/starting-screen';
import { Tooltip } from '../components/ui/tooltip';
import { UpdateBanner } from '../components/update-banner';
import { ScrollContentContext } from '../contexts/scroll-content-context';
import { SocketProvider } from '../contexts/socket-context';
import { useActiveProject } from '../hooks/use-active-project';
import { useMe } from '../hooks/use-me';
import { useProjectMenuCollapsed } from '../hooks/use-project-menu-collapsed';
import { useProjectsIndex } from '../hooks/use-projects';
import { useScrollToBottom } from '../hooks/use-scroll-to-bottom';
import { useScrollToTop } from '../hooks/use-scroll-to-top';
import { useStatus } from '../hooks/use-status';
import { useShellWebSockets } from '../hooks/use-websocket';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

function RootLayout() {
	return (
		<QueryClientProvider client={queryClient}>
			<AppShell />
		</QueryClientProvider>
	);
}

function Spinner() {
	return (
		<div className="flex items-center justify-center h-screen">
			<div className="w-6 h-6 border-2 border-inverse border-t-transparent rounded-full animate-spin" />
		</div>
	);
}

function AppShell() {
	const { data: status, isPending, isError, error, refetch } = useStatus();
	const navigate = useNavigate();
	// Session probe: only meaningful (and only fired) once the instance is unlocked.
	// A 401 here means "unlocked but no valid session → show the password login".
	const me = useMe({ enabled: status?.masterKeyState === 'unlocked', retry: false });

	useEffect(() => {
		if (status?.masterKeyState === 'unset' && window.location.pathname !== '/') {
			navigate({ to: '/', replace: true });
		}
	}, [status?.masterKeyState, navigate]);

	// The server is still booting (compiled binary serves the SPA shell during
	// startup). Show the boot phase and keep polling rather than the bare spinner.
	if (status?.starting) {
		return <StartingScreen phase={status.phase} message={status.message} detail={status.detail} />;
	}

	// Only the FIRST load (no status yet) shows the full-screen spinner. Background
	// refetches — notably React Query's refetch-on-reconnect, which fires on every
	// mobile network blip (radio waking on app-switch, cell↔wifi handoffs, signal
	// dips) — must NOT unmount the shell, or the whole app blanks to a spinner and
	// remounts, which reads as a spontaneous full-page refresh. `isPending` already
	// covers the initial load and the retry-while-no-data window.
	if (isPending) return <Spinner />;

	if (isError || !status || !status.masterKeyState) {
		const raw = (error as { message?: string } | null)?.message;
		// A bare `fetch` network failure surfaces as the browser's technical
		// "Failed to fetch" / "Load failed" / "NetworkError". Show friendly copy for
		// that (the query keeps auto-retrying every 2s, so it self-heals when the
		// server returns); pass through any real server-sent message unchanged.
		const isNetwork = !raw || /failed to fetch|load failed|networkerror/i.test(raw);
		const message = isNetwork ? "Can't reach the server. Retrying…" : raw;
		return (
			<div className="flex flex-col items-center justify-center h-screen gap-4 px-4 text-center">
				<div className="flex items-center gap-2 text-danger">
					{isNetwork && (
						<div className="w-3.5 h-3.5 border-2 border-danger border-t-transparent rounded-full animate-spin" />
					)}
					<p className="text-[13px] max-w-md">{message}</p>
				</div>
				<button
					type="button"
					onClick={() => refetch()}
					className="text-[13px] font-medium text-text-1 hover:underline"
				>
					Retry
				</button>
			</div>
		);
	}

	if (status.masterKeyState !== 'unlocked') {
		api.clearToken();
		// Pre-active vault gate. Both first-run setup (unset) and post-restart unlock
		// (locked) share the same full-screen "vault" treatment to signal the
		// instance isn't live yet; the master key only unlocks — it never grants a
		// session. After the unlock reveal, the gate re-evaluates below.
		return <MasterKeyGate state={status.masterKeyState} />;
	}

	// Unlocked. A session is now required (no anonymous access). A valid session is
	// only ever minted by the password, so it's proof enough to enter the app.
	if (me.isPending) return <Spinner />;
	if (!me.isError) {
		return (
			<SocketProvider token={api.getToken()}>
				<SetupGate>
					<ShellLayout />
				</SetupGate>
			</SocketProvider>
		);
	}

	// No valid session. `passwordSet` decides how to get one:
	if (!status.passwordSet) {
		// Brand-new instance (or recovery): create the first password, which mints
		// the first session.
		return <CreatePasswordFlow />;
	}
	// A password exists but this browser has no session → sign in.
	return <PasswordLogin />;
}

function ShellLayout() {
	// Subscribe to every team room (incl. HQ) by deriving rooms from the project
	// index — teams are reached through their projects.
	const { data: projects } = useProjectsIndex();
	const teamRooms = useMemo(
		() => projects?.map((p) => ({ id: p.team_id, slug: p.team_slug })),
		[projects],
	);
	useShellWebSockets(teamRooms);
	const matches = useMatches();
	const bare = matches.some((m) => m.staticData?.bare);

	const [drawerOpen, setDrawerOpen] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);

	// Bare routes (e.g. the standalone document preview) render full-viewport
	// without the header, project rail, or mobile drawer.
	if (bare) return <Outlet />;

	return (
		<>
			<ShellChrome drawerOpen={drawerOpen} setDrawerOpen={setDrawerOpen} />
			<ChatWidget open={chatOpen} onOpenChange={setChatOpen} />
			<PwaInstallPrompt />
		</>
	);
}

interface ShellChromeProps {
	drawerOpen: boolean;
	setDrawerOpen: (open: boolean) => void;
}

function ShellChrome({ drawerOpen, setDrawerOpen }: ShellChromeProps) {
	const [searchOpen, setSearchOpen] = useState(false);
	const active = useActiveProject();
	const [menuCollapsed, setMenuCollapsed] = useProjectMenuCollapsed();
	const mainRef = useRef<HTMLElement>(null);
	// The scroll-to-bottom hook needs the <main> element as state (a ref never
	// re-runs its effect), so a stable callback ref feeds both. Stable identity
	// matters: an inline ref would be re-invoked (null, then el) on every render
	// and thrash the state.
	const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
	const attachMain = useCallback((el: HTMLElement | null) => {
		mainRef.current = el;
		setMainEl(el);
	}, []);
	const { visible: bottomVisible, scrollToBottom } = useScrollToBottom(mainEl);
	const { visible: topVisible, scrollToTop } = useScrollToTop(mainEl);
	const pathname = useLocation({ select: (l) => l.pathname });
	const hash = useLocation({ select: (l) => l.hash });
	const lastPathnameRef = useRef(pathname);

	// A route with a non-scrolling side panel inside <main> (the task detail meta
	// rail) registers its scrollable content column here, so the scroll pills
	// centre over that column rather than over the full <main> width (which would
	// drift them right, over the panel). The pill anchor is the pills' positioned
	// ancestor, so the measured centre is relative to it.
	const pillAnchorRef = useRef<HTMLDivElement>(null);
	const [contentEl, setContentEl] = useState<HTMLElement | null>(null);
	const registerScrollContent = useCallback((el: HTMLElement | null) => setContentEl(el), []);

	// Global Cmd/Ctrl+K toggles the search palette from any route.
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
				e.preventDefault();
				setSearchOpen((v) => !v);
			}
		};
		window.addEventListener('keydown', onKeyDown);
		return () => window.removeEventListener('keydown', onKeyDown);
	}, []);

	// Reset the main scroll container to the top on every page change. <main> is the
	// only scroller here and it never unmounts across navigations (just the <Outlet>
	// content swaps), so its scrollTop otherwise persists and a freshly-opened page
	// shows scrolled down to wherever the previous page left off. `behavior: 'instant'`
	// overrides the global `html { scroll-behavior: smooth }` so the reset is
	// immediate, not animated. Two guards keep this from stealing the viewport:
	//   - Only reset when the PATHNAME actually changed. A hash-only change is an
	//     in-page jump, not a page change — notably the deep-link executor strips
	//     `#comment-…` once it settles (TanStack patches replaceState, so `hash`
	//     here flips to ''); resetting on that would yank the reader to the top.
	//   - Skip when the new URL carries a hash: that navigation targets an in-page
	//     anchor whose own scroll logic should win.
	useEffect(() => {
		const pathnameChanged = lastPathnameRef.current !== pathname;
		lastPathnameRef.current = pathname;
		if (!pathnameChanged) return;
		if (hash) return;
		mainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
	}, [pathname, hash]);

	// Expose the horizontal centre of the registered content column (relative to
	// the pill anchor) as `--pill-center-x`, so the pills sit over the content the
	// reader scrolls, not over content + a non-scrolling side panel. Unregistered
	// routes leave the var unset and the pills fall back to `left: 50%` (centred
	// over <main>). Re-measures on any layout change — resizable-panel drag,
	// breakpoint switch, preview open/close, window resize — via a ResizeObserver
	// on both the anchor and the content column.
	useEffect(() => {
		const anchor = pillAnchorRef.current;
		if (!anchor) return;
		if (!contentEl) {
			anchor.style.removeProperty('--pill-center-x');
			return;
		}
		const measure = () => {
			const a = anchor.getBoundingClientRect();
			const c = contentEl.getBoundingClientRect();
			anchor.style.setProperty('--pill-center-x', `${c.left - a.left + c.width / 2}px`);
		};
		measure();
		if (typeof ResizeObserver === 'undefined') return;
		const ro = new ResizeObserver(measure);
		ro.observe(anchor);
		ro.observe(contentEl);
		window.addEventListener('resize', measure);
		return () => {
			ro.disconnect();
			window.removeEventListener('resize', measure);
		};
	}, [contentEl]);

	return (
		// dvh, not vh: on mobile, 100vh is the LARGE viewport (URL bar collapsed).
		// With the URL bar expanded the shell then overflows the visual viewport,
		// giving the root scroller ~56px of real scroll range — over-scrolling past
		// the bottom of <main> chains to the root and pushes the app header
		// off-screen, and it stays hidden until <main> is scrolled back to its very
		// top. 100dvh tracks the URL bar, so the root never has overflow and the
		// header can't leave the screen.
		//
		// The on-screen keyboard is a separate axis: dvh does NOT shrink for it
		// unless the viewport meta opts in with interactive-widget=resizes-content
		// (set in index.html). That opt-in makes this h-dvh shell shrink to the space
		// above the keyboard, so <main> shrinks with it and a focused bottom-of-page
		// input (the comment composer) sits flush on the keyboard instead of leaving
		// dead space beneath it.
		<div className="h-dvh flex flex-col overflow-hidden">
			<AppHeader
				onOpenDrawer={() => setDrawerOpen(true)}
				onOpenSearch={() => setSearchOpen(true)}
			/>
			<GlobalSearchDialog open={searchOpen} onOpenChange={setSearchOpen} />
			<UpdateBanner />
			<ReloadPromptBanner />
			<div className="flex flex-row flex-1 overflow-hidden w-full">
				{/* Rail + project sidebar + scrollable main span the full viewport so
				    the main-panel scrollbar sits on the browser edge, not mid-screen. */}
				<div
					className="relative flex flex-row flex-1 min-w-0 w-full overflow-hidden"
					data-testid="content-well"
				>
					<div className="hidden md:flex h-full">
						<ProjectRail />
					</div>
					{active && !menuCollapsed && (
						<div
							data-testid="project-menu"
							className="hidden lg:block w-[208px] shrink-0 h-full overflow-y-auto border-r border-border bg-surface pb-2"
						>
							<ProjectSidebar onCollapse={() => setMenuCollapsed(true)} />
						</div>
					)}
					{/* Collapsed: a slim expand tab docked to the project rail's right
					    edge, flush under the app header. Desktop-only — below lg the
					    project menu is a drawer, so there is nothing to collapse. */}
					{active && menuCollapsed && (
						<Tooltip content="Expand menu" side="right">
							<button
								type="button"
								aria-label="Expand menu"
								data-testid="project-sidebar-expand"
								onClick={() => setMenuCollapsed(false)}
								className="absolute left-[60px] top-0 z-20 hidden h-[22px] w-7 items-center justify-center rounded-br-[9px] border border-l-0 border-t-0 border-border bg-surface text-text-2 shadow-sm transition-colors hover:text-text-1 lg:flex"
							>
								<ChevronsRight className="h-4 w-4" aria-hidden="true" />
							</button>
						</Tooltip>
					)}
					{/* The relative wrapper hosts the scroll-to-bottom pill as a sibling
					    of the scroller, so the pill stays pinned over the content area
					    (never scrolling with it) on ANY page whose long-form content
					    overflows <main> — task threads, documents, settings, etc. It is
					    also the pills' positioning anchor: `--pill-center-x` (set above
					    from a route's registered content column) is measured relative to
					    it. */}
					<div
						ref={pillAnchorRef}
						className="relative flex flex-col flex-1 min-w-0 overflow-hidden"
					>
						<main ref={attachMain} className="flex-1 min-w-0 overflow-auto relative">
							<ScrollContentContext.Provider value={registerScrollContent}>
								<Outlet />
							</ScrollContentContext.Provider>
						</main>
						{/* Top-centre of the scrolled content column, just below the app
						    header. `--pill-center-x` centres over the reader's content pane
						    on pages with a side panel; unset elsewhere → falls back to 50%. */}
						<ScrollToTopButton
							onClick={scrollToTop}
							visible={topVisible}
							testId="scroll-to-top"
							positionClassName="absolute top-4 left-[var(--pill-center-x,50%)] -translate-x-1/2 z-30"
						/>
						{/* Bottom-centre of the scrolled content column: clear of the CEO
						    chat launcher (bottom-right) at every breakpoint. */}
						<ScrollToBottomButton
							onClick={scrollToBottom}
							visible={bottomVisible}
							testId="scroll-to-bottom"
							positionClassName="absolute bottom-4 left-[var(--pill-center-x,50%)] -translate-x-1/2 z-30"
						/>
					</div>
				</div>
			</div>
			{drawerOpen && (
				<div className="lg:hidden fixed inset-0 z-50 flex" data-testid="mobile-nav-drawer">
					<button
						type="button"
						aria-label="Close navigation"
						onClick={() => setDrawerOpen(false)}
						className="absolute inset-0 bg-[var(--overlay)] cursor-default"
					/>
					<div className="relative flex h-full bg-surface shadow-xl">
						<ProjectRail showHome />
						{active && (
							<div className="w-[208px] h-full overflow-y-auto py-2 border-r border-border bg-surface">
								<ProjectSidebar />
							</div>
						)}
					</div>
				</div>
			)}
		</div>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
