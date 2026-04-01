import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Outlet } from '@tanstack/react-router';
import { Inbox } from 'lucide-react';
import { useState } from 'react';
import { BoardInboxDrawer } from '../components/board-inbox-drawer';
import { MasterKeyGate } from '../components/master-key-gate';
import { Button } from '../components/ui/button';
import { useAllPendingApprovals } from '../hooks/use-approvals';
import { useCompanies } from '../hooks/use-companies';
import { useStatus } from '../hooks/use-status';
import { api } from '../lib/api';
import { queryClient } from '../lib/query-client';

function RootLayout() {
	return (
		<QueryClientProvider client={queryClient}>
			<AppShell />
		</QueryClientProvider>
	);
}

function AppShell() {
	const { data: status, isLoading } = useStatus();

	if (isLoading) {
		return (
			<div className="flex items-center justify-center h-screen">
				<div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
			</div>
		);
	}

	if (status?.masterKeyState === 'unset' || status?.masterKeyState === 'locked') {
		api.clearToken();
		return <MasterKeyGate state={status.masterKeyState} />;
	}

	return (
		<div className="flex flex-col h-screen">
			<Header />
			<Outlet />
		</div>
	);
}

function Header() {
	const [inboxOpen, setInboxOpen] = useState(false);
	const { data: companies } = useCompanies();
	const companyIds = companies?.map((c) => c.id) ?? [];
	const { data: approvals } = useAllPendingApprovals(companyIds);
	const pendingCount = approvals?.length ?? 0;

	return (
		<>
			<header className="flex items-center justify-between border-b border-border px-4 py-2.5 bg-bg-subtle shrink-0">
				<a href="/companies" className="text-sm font-semibold text-text tracking-tight">
					hezo
				</a>
				<Button variant="ghost" size="sm" onClick={() => setInboxOpen(true)} className="relative">
					<Inbox className="w-4 h-4" />
					{pendingCount > 0 && (
						<span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-danger text-white text-[10px] font-bold">
							{pendingCount}
						</span>
					)}
				</Button>
			</header>
			<BoardInboxDrawer open={inboxOpen} onOpenChange={setInboxOpen} approvals={approvals ?? []} />
		</>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
