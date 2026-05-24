import { createFileRoute } from '@tanstack/react-router';
import { TaskList } from '../../../../../../components/task-list';
import { useProject } from '../../../../../../hooks/use-projects';

function ProjectTaskListPage() {
	const { teamId, projectId } = Route.useParams();
	const { data: project } = useProject(teamId, projectId);

	if (!project) return null;

	return <TaskList teamId={teamId} projectId={project.id} />;
}

export const Route = createFileRoute('/teams/$teamId/projects/$projectId/tasks/')({
	component: ProjectTaskListPage,
});
