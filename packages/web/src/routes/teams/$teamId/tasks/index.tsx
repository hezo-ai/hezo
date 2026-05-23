import { createFileRoute } from '@tanstack/react-router';
import { TaskList } from '../../../../components/task-list';

function TaskListPage() {
	const { teamId } = Route.useParams();
	return <TaskList teamId={teamId} />;
}

export const Route = createFileRoute('/teams/$teamId/tasks/')({
	component: TaskListPage,
});
