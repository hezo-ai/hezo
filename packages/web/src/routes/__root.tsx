import { QueryClientProvider } from '@tanstack/react-query';
import { createRootRoute, Link, Outlet, useParams } from '@tanstack/react-router';
import { ChevronRight, Home, Inbox } from 'lucide-react';
import { useState } from 'react';
import { BoardInboxDrawer } from '../components/board-inbox-drawer';
import { MasterKeyGate } from '../components/master-key-gate';
import { ProjectRail } from '../components/project-rail';
import { Button } from '../components/ui/button';
import { ThemeSwitcher } from '../components/ui/theme-switcher';
import { useApprovals } from '../hooks/use-approvals';
import { useCompany } from '../hooks/use-companies';
import { useProject } from '../hooks/use-projects';
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
	const params = useParams({ strict: false }) as Record<string, string>;
	const companyId = params.companyId;

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
		<div className="h-screen flex flex-col">
			<Header />
			<div className="flex flex-1 overflow-hidden">
				{companyId && <ProjectRail companyId={companyId} />}
				<main className="flex-1 overflow-auto">
					<Outlet />
				</main>
			</div>
		</div>
	);
}

function Header() {
	const [inboxOpen, setInboxOpen] = useState(false);
	const params = useParams({ strict: false }) as Record<string, string>;
	const companyId = params.companyId;
	const projectId = params.projectId;

	const companyQuery = useCompany(companyId ?? '', !!companyId);
	const projectQuery = useProject(companyId ?? '', projectId ?? '', !!projectId);
	const approvalsQuery = useApprovals(companyId ?? '', undefined, !!companyId);
	const company = companyQuery.data;
	const project = projectQuery.data;
	const pendingCount = approvalsQuery.data?.length ?? 0;

	return (
		<>
			<header className="flex items-center justify-between border-b border-border px-4 py-2 shrink-0 bg-bg z-50">
				<nav className="flex items-center gap-1.5 text-[13px]">
					<Link
						to="/companies"
						className="text-text-muted hover:text-text transition-colors"
						title="All companies"
					>
						<Home className="w-4 h-4" />
					</Link>
					{companyId && company && (
						<>
							<ChevronRight className="w-3 h-3 text-text-subtle" />
							<Link
								to="/companies/$companyId/issues"
								params={{ companyId }}
								className="text-text-muted hover:text-text font-medium transition-colors"
							>
								{company.name}
							</Link>
						</>
					)}
					{projectId && project && (
						<>
							<ChevronRight className="w-3 h-3 text-text-subtle" />
							<span className="text-text font-medium">{project.name}</span>
						</>
					)}
				</nav>
				<div className="flex items-center gap-1">
					<ThemeSwitcher />
					{companyId && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setInboxOpen(true)}
							className="relative"
						>
							<Inbox className="w-4 h-4" />
							{pendingCount > 0 && (
								<span className="absolute -top-1 -right-1 flex items-center justify-center w-4 h-4 rounded-full bg-accent-red text-white text-[10px] font-bold">
									{pendingCount}
								</span>
							)}
						</Button>
					)}
				</div>
			</header>
			{companyId && (
				<BoardInboxDrawer
					open={inboxOpen}
					onOpenChange={setInboxOpen}
					approvals={approvalsQuery.data ?? []}
				/>
			)}
		</>
	);
}

export const Route = createRootRoute({
	component: RootLayout,
});
