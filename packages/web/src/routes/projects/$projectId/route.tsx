import { createFileRoute, Outlet } from '@tanstack/react-router';
import { BudgetBanner } from '../../../components/budget-banner';
import { ContainerStatusBanner } from '../../../components/container-status-banner';

function ProjectLayout() {
	const { projectId } = Route.useParams();

	return (
		<div>
			<ContainerStatusBanner projectId={projectId} />
			<BudgetBanner projectId={projectId} />
			<div className="px-4 py-4 md:px-6 md:py-5 lg:px-8 lg:py-6">
				<Outlet />
			</div>
		</div>
	);
}

export const Route = createFileRoute('/projects/$projectId')({
	component: ProjectLayout,
});
