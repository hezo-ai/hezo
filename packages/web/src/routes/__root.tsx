import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Outlet, useNavigate } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { MasterKeyGate } from '../components/master-key-gate';
import { MasterKeyStep, SetupGate } from '../components/setup/setup-wizard';
import { TeamSidebar } from '../components/team-sidebar';
import { SocketProvider } from '../contexts/socket-context';
import { useRouteTeamId } from '../hooks/use-route-team-id';
import { useStatus } from '../hooks/use-status';
import { useTeams } from '../hooks/use-teams';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
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
			<div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
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
				<p className="text-[13px] text-accent-red max-w-md">{message}</p>
				<button
					type="button"
					onClick={() => refetch()}
					className="text-[13px] font-medium text-primary hover:underline"
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
	const [drawerOpen, setDrawerOpen] = useState(false);
	const { data: teams } = useTeams();
	useShellWebSockets(teams);

	return (
		<div className="h-screen flex flex-row overflow-hidden">
			<div className="hidden lg:block">
				<TeamSidebarShell />
			</div>
			<main className="flex-1 overflow-auto relative">
				<button
					type="button"
					onClick={() => setDrawerOpen(true)}
					aria-label="Open navigation"
					data-testid="mobile-nav-toggle"
					className="lg:hidden fixed top-3 left-3 z-40 w-9 h-9 rounded-radius-md bg-bg-elevated border border-border flex items-center justify-center text-text-muted hover:text-text shadow-sm"
				>
					<Menu className="w-4 h-4" />
				</button>
				<Outlet />
			</main>
			{drawerOpen && (
				<div className="lg:hidden fixed inset-0 z-50 flex" data-testid="mobile-nav-drawer">
					<button
						type="button"
						aria-label="Close navigation"
						onClick={() => setDrawerOpen(false)}
						className="absolute inset-0 bg-black/50 cursor-default"
					/>
					<div className="relative flex h-full bg-bg shadow-xl">
						<div className="w-[260px] h-full overflow-y-auto py-2 border-r border-border bg-bg">
							<TeamSidebar />
						</div>
						<button
							type="button"
							aria-label="Close navigation"
							onClick={() => setDrawerOpen(false)}
							data-testid="mobile-nav-close"
							className="absolute top-2 -right-10 w-9 h-9 rounded-radius-md bg-bg-elevated border border-border flex items-center justify-center text-text-muted hover:text-text shadow-sm"
						>
							<X className="w-4 h-4" />
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function TeamSidebarShell() {
	const teamId = useRouteTeamId();
	const { data: uiState } = useUiState(teamId);
	const updateUiState = useUpdateUiState(teamId);
	const collapsed = uiState?.sidebar?.collapsed ?? false;

	return (
		<div className="relative shrink-0 flex h-full">
			<div
				className={`overflow-hidden border-r border-border bg-bg transition-[width] duration-150 ${
					collapsed ? 'w-0' : 'w-[260px]'
				}`}
			>
				<div
					className={`w-[260px] h-full overflow-y-auto py-2 ${collapsed ? 'invisible' : ''}`}
					aria-hidden={collapsed}
				>
					<TeamSidebar />
				</div>
			</div>
			<button
				type="button"
				onClick={() => updateUiState.mutate({ sidebar: { collapsed: !collapsed } })}
				aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
				data-testid="sidebar-toggle"
				className="absolute top-3 -right-3 z-50 w-6 h-6 rounded-full border border-border bg-bg text-text-muted hover:text-text hover:bg-bg-subtle flex items-center justify-center shadow-sm transition-colors"
			>
				{collapsed ? <ChevronsRight className="w-3 h-3" /> : <ChevronsLeft className="w-3 h-3" />}
			</button>
		</div>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
