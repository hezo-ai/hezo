import { createFileRoute } from '@tanstack/react-router';
import { GoalDetailPage } from '../../../../components/goal-detail/goal-detail-page';

function ProjectGoalDetailPage() {
	const { projectId, goalId } = Route.useParams();
	return <GoalDetailPage projectId={projectId} goalId={goalId} />;
}

export const Route = createFileRoute('/projects/$projectId/goals/$goalId')({
	component: ProjectGoalDetailPage,
});
