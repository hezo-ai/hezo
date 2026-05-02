import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Outlet, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { AiProviderSetupModal } from '../components/ai-provider-setup-modal';
import { CompanyRail } from '../components/company-rail';
import { CompanySidebar } from '../components/company-sidebar';
import { MasterKeyGate } from '../components/master-key-gate';
import { SocketProvider } from '../contexts/socket-context';
import { useAiProviderStatus } from '../hooks/use-ai-providers';
import { useStatus } from '../hooks/use-status';
import { useUiState, useUpdateUiState } from '../hooks/use-ui-state';
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
	const { data: status, isLoading } = useStatus();
	const navigate = useNavigate();
	const params = useParams({ strict: false }) as Record<string, string>;
	const companyId = params.companyId;
	const unlocked = status?.masterKeyState === 'unlocked';
	const hasToken = !!api.getToken();

	const { data: providerStatus, isLoading: providersLoading } = useAiProviderStatus({
		enabled: unlocked && hasToken,
	});

	useEffect(() => {
		if (status?.masterKeyState === 'unset' && window.location.pathname !== '/') {
			navigate({ to: '/', replace: true });
		}
	}, [status?.masterKeyState, navigate]);

	if (isLoading) return <Spinner />;

	if (status?.masterKeyState === 'unset' || status?.masterKeyState === 'locked') {
		api.clearToken();
		return <MasterKeyGate state={status.masterKeyState} />;
	}

	if (providersLoading || !providerStatus) return <Spinner />;

	if (!providerStatus.configured) {
		return <AiProviderSetupModal />;
	}

	return (
		<SocketProvider token={api.getToken()}>
			<ShellLayout companyId={companyId} />
		</SocketProvider>
	);
}

function ShellLayout({ companyId }: { companyId: string | undefined }) {
	const [drawerOpen, setDrawerOpen] = useState(false);

	return (
		<div className="h-screen flex flex-row overflow-hidden">
			<div className="hidden md:flex">
				<CompanyRail />
			</div>
			{companyId && (
				<div className="hidden lg:block">
					<CompanySidebarShell companyId={companyId} />
				</div>
			)}
			<main className="flex-1 overflow-auto relative">
				<button
					type="button"
					onClick={() => setDrawerOpen(true)}
					aria-label="Open navigation"
					data-testid="mobile-nav-toggle"
					className="lg:hidden fixed top-3 left-3 md:left-[72px] z-40 w-9 h-9 rounded-radius-md bg-bg-elevated border border-border flex items-center justify-center text-text-muted hover:text-text shadow-sm"
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
						<div className="md:hidden">
							<CompanyRail />
						</div>
						{companyId && (
							<div className="w-[260px] h-full overflow-y-auto py-2 border-r border-border bg-bg">
								<CompanySidebar companyId={companyId} />
							</div>
						)}
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

function CompanySidebarShell({ companyId }: { companyId: string }) {
	const { data: uiState } = useUiState(companyId);
	const updateUiState = useUpdateUiState(companyId);
	const collapsed = uiState?.sidebar?.collapsed ?? false;

	return (
		<div className="relative shrink-0 flex">
			<div
				className={`overflow-hidden border-r border-border bg-bg transition-[width] duration-150 ${
					collapsed ? 'w-0' : 'w-[260px]'
				}`}
			>
				<div
					className={`w-[260px] h-full overflow-y-auto py-2 ${collapsed ? 'invisible' : ''}`}
					aria-hidden={collapsed}
				>
					<CompanySidebar companyId={companyId} />
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
