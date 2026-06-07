import { createFileRoute } from '@tanstack/react-router';
import { TaskList } from '../../../../components/task-list';

function ProjectTaskListPage() {
	const { projectId } = Route.useParams();
	return <TaskList projectId={projectId} />;
}

export const Route = createFileRoute('/projects/$projectId/tasks/')({
	component: ProjectTaskListPage,
});
