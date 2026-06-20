import { QueryClientProvider } from '@tanstack/react-query';
import {
	createRootRoute,
	Outlet,
	useLocation,
	useMatches,
	useNavigate,
} from '@tanstack/react-router';
import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppHeader } from '../components/app-header';
import { CeoChatWidget } from '../components/ceo-chat/ceo-chat-widget';
import { MasterKeyGate } from '../components/master-key-gate';
import { ProjectRail } from '../components/project-rail';
import { ProjectSidebar } from '../components/project-sidebar';
import { MasterKeyStep, SetupGate } from '../components/setup/setup-wizard';
import { UpdateBanner } from '../components/update-banner';
import { SocketProvider } from '../contexts/socket-context';
import { useActiveProject } from '../hooks/use-active-project';
import { useProjectsIndex } from '../hooks/use-projects';
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
	const { data: status, isPending, isFetching, isError, error, refetch } = useStatus();
	const navigate = useNavigate();

	useEffect(() => {
		if (status?.masterKeyState === 'unset' && window.location.pathname !== '/') {
			navigate({ to: '/', replace: true });
		}
	}, [status?.masterKeyState, navigate]);

	if (isPending || isFetching) return <Spinner />;

	if (isError || !status) {
		const message =
			(error as { message?: string } | null)?.message ??
			'Could not reach the server. If you just reset the database, wait a few seconds and retry.';
		return (
			<div className="flex flex-col items-center justify-center h-screen gap-4 px-4 text-center">
				<p className="text-[13px] text-danger max-w-md">{message}</p>
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
		// Initial setup: render the master-key step inside the wizard chrome so the
		// stepper makes the two-step flow obvious. On server restart (locked state),
		// the modal unlock dialog is the right primitive — there's no setup to flow into.
		if (status.masterKeyState === 'unset') {
			return <MasterKeyStep state={status.masterKeyState} />;
		}
		return <MasterKeyGate state={status.masterKeyState} />;
	}

	return (
		<SocketProvider token={api.getToken()}>
			<SetupGate>
				<ShellLayout />
			</SetupGate>
		</SocketProvider>
	);
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

	// Bare routes (e.g. the standalone document preview) render full-viewport
	// without the header, project rail, or mobile drawer.
	if (bare) return <Outlet />;

	return (
		<>
			<ShellChrome />
			<CeoChatWidget />
		</>
	);
}

function ShellChrome() {
	const [drawerOpen, setDrawerOpen] = useState(false);
	const active = useActiveProject();
	const mainRef = useRef<HTMLElement>(null);
	const pathname = useLocation({ select: (l) => l.pathname });
	const hash = useLocation({ select: (l) => l.hash });
	const lastPathnameRef = useRef(pathname);

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

	return (
		<div className="h-screen flex flex-col overflow-hidden">
			<AppHeader onOpenDrawer={() => setDrawerOpen(true)} />
			<div className="flex flex-row flex-1 overflow-hidden w-full">
				{/* Rail + project sidebar + scrollable main span the full viewport so
				    the main-panel scrollbar sits on the browser edge, not mid-screen. */}
				<div
					className="flex flex-row flex-1 min-w-0 w-full overflow-hidden"
					data-testid="content-well"
				>
					<div className="hidden md:flex h-full">
						<ProjectRail />
					</div>
					{active && (
						<div className="hidden lg:block w-[208px] shrink-0 h-full overflow-y-auto border-r border-border bg-surface py-2">
							<ProjectSidebar />
						</div>
					)}
					<main ref={mainRef} className="flex-1 min-w-0 overflow-auto relative">
						<UpdateBanner />
						<Outlet />
					</main>
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
						<ProjectRail />
						{active && (
							<div className="w-[208px] h-full overflow-y-auto py-2 border-r border-border bg-surface">
								<ProjectSidebar />
							</div>
						)}
						<button
							type="button"
							aria-label="Close navigation"
							onClick={() => setDrawerOpen(false)}
							data-testid="mobile-nav-close"
							className="absolute top-2 -right-10 w-9 h-9 rounded-md bg-surface border border-border flex items-center justify-center text-text-2 hover:text-text-1 shadow-sm"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
