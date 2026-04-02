import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { StatusDot } from '../../../../../components/ui/status-dot';
import { Tabs } from '../../../../../components/ui/tabs';
import { useProject } from '../../../../../hooks/use-projects';

function ProjectLayout() {
	const { companyId, projectId } = Route.useParams();
	const { data: project, isLoading } = useProject(companyId, projectId);

	if (isLoading || !project) return <div className="p-6 text-text-muted">Loading...</div>;

	const isRunning = project.container_status === 'running';

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/projects"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Projects
			</Link>

			<h1 className="text-lg font-semibold mb-1">{project.name}</h1>
			{project.goal && <p className="text-sm text-text-muted mb-4">{project.goal}</p>}

			<Tabs
				items={[
					{
						to: '/companies/$companyId/projects/$projectId',
						params: { companyId, projectId },
						label: 'Overview',
					},
					{
						to: '/companies/$companyId/projects/$projectId/container',
						params: { companyId, projectId },
						label: 'Container',
						badge: (
							<StatusDot
								status={isRunning ? 'active' : 'paused'}
								pulse={isRunning}
								className="ml-2"
							/>
						),
					},
				]}
			/>

			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/projects/$projectId')({
	component: ProjectLayout,
});
