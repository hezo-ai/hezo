import { createFileRoute, Outlet, useLocation } from '@tanstack/react-router';
import { Info } from 'lucide-react';
import { ContainerStatusBanner } from '../../../components/container-status-banner';
import { useProjectMeta } from '../../../hooks/use-projects';

function ProjectLayout() {
	const { projectId } = Route.useParams();
	const project = useProjectMeta(projectId);
	const { pathname } = useLocation();

	const base = `/projects/${projectId}`;
	const isInternal = project?.is_internal ?? false;
	const showBanner =
		isInternal && (pathname === `${base}/tasks` || pathname === `${base}/container`);

	return (
		<div>
			<ContainerStatusBanner projectId={projectId} />
			{showBanner && (
				<div className="flex items-start gap-2 mb-4 px-3 py-2 rounded-radius-md bg-bg-subtle text-text-muted text-[13px]">
					<Info className="w-4 h-4 mt-px shrink-0" aria-hidden="true" />
					<span>
						Internal team coordination project, used for onboarding and team-level changes.
					</span>
				</div>
			)}
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
});
