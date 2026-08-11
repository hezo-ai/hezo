import { createFileRoute } from '@tanstack/react-router';
import { ProjectDashboardView } from '../../../components/project-dashboard';

function ProjectDashboardPage() {
	const { projectId } = Route.useParams();
	return <ProjectDashboardView projectId={projectId} />;
}

export const Route = createFileRoute('/projects/$projectId/dashboard')({
	component: ProjectDashboardPage,
});
