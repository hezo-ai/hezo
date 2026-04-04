import { createFileRoute, Link, Outlet, useMatchRoute } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useProject } from '../../../../../hooks/use-projects';

const tabs = [
	{ label: 'Issues', to: '/companies/$companyId/projects/$projectId/issues' as const },
	{ label: 'Agents', to: '/companies/$companyId/projects/$projectId/agents' as const },
	{ label: 'Container', to: '/companies/$companyId/projects/$projectId/container' as const },
	{ label: 'Settings', to: '/companies/$companyId/projects/$projectId/settings' as const },
];

function ProjectLayout() {
	const { companyId, projectId } = Route.useParams();
	const { data: project, isLoading } = useProject(companyId, projectId);
	const matchRoute = useMatchRoute();
	const params = { companyId, projectId };

	if (isLoading || !project) return <div className="p-6 text-text-muted">Loading...</div>;

	return (
		<div>
			<Link
				to="/companies/$companyId/projects"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Projects
			</Link>

			<h1 className="text-lg font-semibold mb-1">{project.name}</h1>
			{project.goal && <p className="text-sm text-text-muted mb-4">{project.goal}</p>}

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
