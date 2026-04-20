import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Outlet, useParams } from '@tanstack/react-router';
import { ChevronsLeft, ChevronsRight } from 'lucide-react';
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
	const params = useParams({ strict: false }) as Record<string, string>;
	const companyId = params.companyId;
	const unlocked = status?.masterKeyState === 'unlocked';
	const hasToken = !!api.getToken();

	const { data: providerStatus, isLoading: providersLoading } = useAiProviderStatus({
		enabled: unlocked && hasToken,
	});

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
			<div className="h-screen flex flex-row overflow-hidden">
				<CompanyRail />
				{companyId && <CompanySidebarShell companyId={companyId} />}
				<main className="flex-1 overflow-auto">
					<Outlet />
				</main>
			</div>
		</SocketProvider>
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
					collapsed ? 'w-0' : 'w-[200px]'
				}`}
			>
				<div
					className={`w-[200px] h-full overflow-y-auto py-2 ${collapsed ? 'invisible' : ''}`}
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
				className="absolute top-3 -right-3 z-10 w-6 h-6 rounded-full border border-border bg-bg text-text-muted hover:text-text hover:bg-bg-subtle flex items-center justify-center shadow-sm transition-colors"
			>
				{collapsed ? <ChevronsRight className="w-3 h-3" /> : <ChevronsLeft className="w-3 h-3" />}
			</button>
		</div>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
