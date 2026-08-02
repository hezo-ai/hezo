import { createFileRoute } from '@tanstack/react-router';
import { ProgressPage } from '../../../../components/progress/progress-page';

function ProjectProgressPage() {
	const { projectId } = Route.useParams();
	return <ProgressPage projectId={projectId} />;
}

export const Route = createFileRoute('/projects/$projectId/progress/')({
	component: ProjectProgressPage,
});
