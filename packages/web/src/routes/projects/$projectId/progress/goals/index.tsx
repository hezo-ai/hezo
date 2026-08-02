import { createFileRoute } from '@tanstack/react-router';
import { GoalsList } from '../../../../../components/goals-list';

function ProjectGoalsListPage() {
	const { projectId } = Route.useParams();
	return <GoalsList projectId={projectId} />;
}

export const Route = createFileRoute('/projects/$projectId/progress/goals/')({
	component: ProjectGoalsListPage,
});
