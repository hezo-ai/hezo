import { createFileRoute, Outlet } from '@tanstack/react-router';
import { ContainerStatusBanner } from '../../../components/container-status-banner';

function ProjectLayout() {
	const { projectId } = Route.useParams();

	return (
		<div>
			<ContainerStatusBanner projectId={projectId} />
			<Outlet />
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
});
