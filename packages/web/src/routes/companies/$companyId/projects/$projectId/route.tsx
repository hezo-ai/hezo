import { IssueStatus, TERMINAL_ISSUE_STATUSES } from '@hezo/shared';
import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { Breadcrumb } from '../../../../../components/ui/breadcrumb';
import { useIssues } from '../../../../../hooks/use-issues';
import { useProject } from '../../../../../hooks/use-projects';

const NON_TERMINAL_STATUSES = Object.values(IssueStatus)
	.filter((s) => !(TERMINAL_ISSUE_STATUSES as readonly string[]).includes(s))
	.join(',');

const tabs = [
	{ key: 'issues', label: 'Issues', to: '/companies/$companyId/projects/$projectId/issues' },
	{
		key: 'documents',
		label: 'Documents',
		to: '/companies/$companyId/projects/$projectId/documents',
	},
	{
		key: 'container',
		label: 'Container',
		to: '/companies/$companyId/projects/$projectId/container',
	},
	{
		key: 'settings',
		label: 'Settings',
		to: '/companies/$companyId/projects/$projectId/settings',
	},
] as const;

function ProjectLayout() {
	const { companyId, projectId } = Route.useParams();
	const { data: project, isLoading } = useProject(companyId, projectId);
	const { data: openIssues } = useIssues(companyId, {
		project_id: projectId,
		status: NON_TERMINAL_STATUSES,
		per_page: '1',
	});
	const openCount = openIssues?.meta.total ?? 0;
	const matchRoute = useMatchRoute();
	const params = { companyId, projectId };

	if (isLoading || !project) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div>
			<Breadcrumb
				items={[
					{ label: 'Projects', to: '/companies/$companyId/projects', params: { companyId } },
					{ label: project.name },
				]}
			/>

			<h1 className="text-lg font-semibold mb-1">{project.name}</h1>
			{project.description && <p className="text-sm text-text-muted mb-4">{project.description}</p>}

			<div className="flex gap-1 border-b border-border mb-6">
				{tabs.map((tab) => {
					const isActive = matchRoute({ to: tab.to, params, fuzzy: true });
					return (
						<Link
							key={tab.to}
							to={tab.to}
							params={params}
							className={`px-3 py-2 text-[13px] font-medium border-b-2 transition-colors -mb-px ${
								isActive
									? 'border-primary text-text'
									: 'border-transparent text-text-muted hover:text-text hover:border-border-hover'
							}`}
						>
							{tab.label}
							{tab.key === 'issues' && openCount > 0 && (
								<span className="ml-1 text-text-muted" data-testid="project-nav-issue-count">
									({openCount})
								</span>
							)}
						</Link>
					);
				})}
			</div>

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId')({
	component: ProjectLayout,
});
